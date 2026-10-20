import { z } from "zod";
import { operatorPlanDigest, HostedOperatorError } from "../provisioning/hosted-operator-contract";
import { hostedOperatorClientForSession } from "../provisioning/hosted-operator-client";

import { readHostedRuntimeExecutionBinding } from "../provisioning/hosted-runtime-deployment";
import { HostedRuntimeProviderError } from "../provisioning/hosted-runtime-provider";
import type {
  PrivateRuntimeFiles,
  HostedRuntimeProof,
} from "../provisioning/hosted-runtime-service";
import { createHostedRuntimeSandboxExecutor } from "../provisioning/hosted-runtime-sandbox";
import { withHostedInstallerSandbox } from "../provisioning/hosted-runtime-installer";
import { hostedRuntimeProofSchema } from "../provisioning/hosted-runtime-journal";
import { assertHostedSandboxCommandAuthority } from "../sandbox/deployment-execution-lease";
import { getVercelPreviewProvider } from "../sandbox/vercel-preview-provider";
import { resolveHostedRuntimePreparationSelection } from "./hosted-runtime-selection-handoff";
import type { PreparedRuntimeSelection } from "./prepared-runtime-selection";

import { restorePreparedRuntimeExecution } from "./prepared-runtime-execution-core";
import type {
  RuntimeTransport,
  PreparedRuntimeExecution,
  PreparedRuntimeExecutionContext,
} from "./prepared-runtime-execution-core";

export {
  restorePreparedRuntimeExecution,
  runtimeFilesForOrigin,
} from "./prepared-runtime-execution-core";
export type {
  RuntimeCommand,
  RuntimeTransport,
  PreparedRuntimeExecution,
  PreparedRuntimeExecutionContext,
  PreparedRuntimeExecutionBinding,
} from "./prepared-runtime-execution-core";
export interface PreparedRuntimeExecutionDependencies {
  operatorClient?: typeof hostedOperatorClientForSession;
  readBinding: typeof readHostedRuntimeExecutionBinding;
  assertAuthority: typeof assertHostedSandboxCommandAuthority;
  getProvider: (id: string, signal?: AbortSignal) => Promise<RuntimeTransport>;
  observeInstallation: (input: {
    appId: string;
    files: PrivateRuntimeFiles;
    root: string;
    sandboxId: string;
    stateDirectory: string;
    signal?: AbortSignal;
  }) => Promise<HostedRuntimeProof>;
}
const executionDependencies: PreparedRuntimeExecutionDependencies = {
  assertAuthority: assertHostedSandboxCommandAuthority,
  getProvider: getVercelPreviewProvider,
  async observeInstallation(input) {
    const source = await getVercelPreviewProvider(input.sandboxId, input.signal);
    const state = z
      .object({
        clusterUrl: z.string(),
        plan: z.object({ roles: z.array(z.string()), runtimeId: z.string() }),
        productionDatabaseIdentity: z.string(),
      })
      .parse(JSON.parse(input.files["state.json"] ?? "null"));
    return await withHostedInstallerSandbox({
      root: input.root,
      run: async (control, signal) => {
        const executor = createHostedRuntimeSandboxExecutor({
          appId: input.appId,
          provider: control,
          roles: state.plan.roles,
          root: input.root,
          signal,
          stateDirectory: input.stateDirectory,
        });
        await executor.restore(input.files);
        return hostedRuntimeProofSchema.parse(
          await executor.run({
            clusterUrl: state.clusterUrl,
            operation: "verify",
            productionDatabaseIdentity: state.productionDatabaseIdentity,
            runtimeId: state.plan.runtimeId,
            signal,
          }),
        );
      },
      signal: input.signal,
      source,
    });
  },
  readBinding: readHostedRuntimeExecutionBinding,
};

/** Reads the same owner-bound protected selection without creating or adapting private compute. */
export const resolveProtectedRuntimeBindings = async (
  input: Pick<PreparedRuntimeExecutionContext, "appId" | "sessionAuth" | "sessionId" | "signal">,
  selectionInput?: PreparedRuntimeSelection | null,
  operatorClientFactory = hostedOperatorClientForSession,
) => {
  let selection = selectionInput;
  if (selection === undefined) {
    selection = await resolveHostedRuntimePreparationSelection(input);
  }
  if (selection?.operationRef === undefined) {
    return null;
  }
  if (selection.appId !== input.appId || !selection.branch) {
    throw new HostedRuntimeProviderError("authorization_required");
  }
  const client = await operatorClientFactory(input.sessionAuth, input.sessionId);
  if (selection.sessionId !== client.sessionId) {
    throw new HostedRuntimeProviderError("authorization_required");
  }
  const projection = await client.bindings(
    {
      action: "bindings",
      operationRef: selection.operationRef,
      selection: {
        appId: input.appId,
        branch: selection.branch,
        environment: "preview",
        projectId: selection.projectId,
        sessionId: client.sessionId,
      },
    },
    input.signal,
  );
  if (
    selection.planDigest === undefined ||
    selection.planDigest !== operatorPlanDigest(projection.plan)
  ) {
    throw new HostedOperatorError("resource_mismatch");
  }
  return projection;
};

// oxlint-disable-next-line eslint/complexity -- Operator references and explicitly retained v1 selections are separate closed authority paths.
export const resolvePreparedRuntimeExecution = async (
  input: PreparedRuntimeExecutionContext,
  selectionInput?: PreparedRuntimeSelection | null,
  dependencies = executionDependencies,
): Promise<PreparedRuntimeExecution | null> => {
  let selection = selectionInput;
  if (selection === undefined) {
    selection = await resolveHostedRuntimePreparationSelection(input);
  }
  const sourceRef =
    "githubSource" in input.state ? input.state.githubSource?.resolvedRef : undefined;
  const branch =
    selection?.branch ??
    (sourceRef !== undefined && sourceRef.startsWith("refs/heads/")
      ? sourceRef.slice("refs/heads/".length)
      : undefined);
  if (branch === undefined || branch === "") {
    return null;
  }
  if (selection && selection.appId !== input.appId) {
    throw new HostedRuntimeProviderError("authorization_required");
  }
  if (
    selection &&
    selection.operationRef === undefined &&
    selection.sessionId !== input.sessionId
  ) {
    throw new HostedRuntimeProviderError("authorization_required");
  }
  const projection =
    selection?.operationRef === undefined
      ? null
      : await resolveProtectedRuntimeBindings(
          input,
          selection,
          dependencies.operatorClient ?? hostedOperatorClientForSession,
        );
  const binding = projection
    ? {
        branch,
        environment: projection.environment,
        files: { "environment.json": JSON.stringify(projection.environment) },
        // Browser-origin adaptation is local runtime state only; the operator retains resource/secret authority.
        persistFiles: async (_files: PrivateRuntimeFiles) => {
          /* Local origin files are restored below; protected credentials stay in the operator. */
        },
        projectId: projection.plan.selection.projectId,
        stateDirectory: `/tmp/app-builder-operator/${projection.operationRef}`,
      }
    : await dependencies.readBinding({
        appId: input.appId,
        branch,
        optionalProject: !selection,
        sessionAuth: input.sessionAuth,
        sessionId: input.sessionId,
      });
  if (!binding) {
    if (selection) {
      throw new HostedRuntimeProviderError("connection_required");
    }
    return null;
  }
  if (selection && selection.projectId !== binding.projectId) {
    throw new HostedRuntimeProviderError("resource_mismatch");
  }
  await dependencies.assertAuthority({ sessionId: input.sessionId });
  const provider = await dependencies.getProvider(input.sandboxId, input.signal);
  return await restorePreparedRuntimeExecution({
    appId: input.appId,
    browserTestBaseUrl: projection?.nativePreview?.publicOrigin,
    normalActors: projection?.normalActors,
    binding,
    observeInstallation: async (files) =>
      projection
        ? projection.proof
        : await dependencies.observeInstallation({
            appId: input.appId,
            files,
            root: input.root,
            sandboxId: input.sandboxId,
            signal: input.signal,
            stateDirectory: binding.stateDirectory,
          }),
    provider,
    root: input.root,
    signal: input.signal,
  });
};
