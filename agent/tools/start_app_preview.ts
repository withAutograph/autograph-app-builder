import { createHash } from "node:crypto";

import {
  bindProductBehaviorPreview,
  currentProductBehaviorGeneration,
} from "@/lib/agent/product-behavior-state";
import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  previewWorkingDirectorySchema,
  resolvePreviewWorkingDirectory,
} from "@/lib/agent/preview-working-directory";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { runnableSelectedApp } from "@/lib/agent/runnable-selected-app";
import { resolvePreviewPackageManager } from "@/lib/agent/preview-package-manager";
import { ensureCheckoutDependencies } from "@/lib/agent/checkout-dependencies";
import {
  appDeclaresLocalSetup,
  prepareAppLocalPreview,
  localRuntimeEnvironmentPath,
} from "./prepare-app-local-preview";
import {
  hasLiveWorkingPreview,
  workingPreviewState,
  workingPreviewAttemptState,
} from "@/lib/agent/working-preview-state";
import { assertHostedSandboxCommandAuthority } from "@/lib/sandbox/deployment-execution-lease";
import { getVercelPreviewProvider } from "@/lib/sandbox/vercel-preview-provider";
import { startWorkingPreview } from "@/lib/sandbox/working-preview-runtime";

const validationAttemptDigest = (
  state: ReturnType<typeof appBuilderWorkflowState.get>,
): string | undefined => {
  if ("validationReceipt" in state) {
    return state.validationReceipt.digest;
  }
  if ("validationFailure" in state) {
    return state.validationFailure.attemptDigest;
  }
  if ("validationAttempt" in state) {
    return state.validationAttempt.digest;
  }
  return undefined;
};

const nextDependencyManifest = z.object({
  dependencies: z.object({ next: z.string().optional() }).optional(),
  devDependencies: z.object({ next: z.string().optional() }).optional(),
});

const usesNext = (source: string | null): boolean => {
  if (source === null) {
    return false;
  }
  try {
    const parsed = nextDependencyManifest.safeParse(JSON.parse(source));
    return (
      parsed.success &&
      (parsed.data.dependencies?.next !== undefined ||
        parsed.data.devDependencies?.next !== undefined)
    );
  } catch {
    throw new Error(
      "The selected app's package.json is not valid JSON. Repair its manifest before starting the private preview.",
    );
  }
};

export default defineTool({
  description:
    "Open the selected existing app or applied new app in its private Sandbox and return a working browser URL. For a prepared existing GitHub checkout, supply appId from the repository's apps directory; this only previews current files and does not grant build or publication approval. Discover the development script and package manager from the checkout's package.json, then use workingDirectory relative to the repository root. Configure it to listen on the supplied port. A reachable page is not proof of backend product behavior.",
  async execute(input, ctx) {
    const current = appBuilderWorkflowState.get();
    const sandbox = await ctx.getSandbox();
    const selected = await runnableSelectedApp({ appId: input.appId, sandbox, state: current });
    const cwd = resolvePreviewWorkingDirectory(selected.root, input.workingDirectory);
    const rootManifest = await sandbox.readTextFile({ path: `${selected.root}/package.json` });
    const launch = resolvePreviewPackageManager(input.command, rootManifest);
    const evidenceGeneration = currentProductBehaviorGeneration();
    await assertHostedSandboxCommandAuthority({ sessionId: ctx.session.id });
    const provider = await getVercelPreviewProvider(sandbox.id, ctx.abortSignal);
    const previous = workingPreviewState.get();
    const validationDigest = validationAttemptDigest(current);
    const requestDigest = createHash("sha256")
      .update(
        JSON.stringify({
          appId: selected.appId,
          command: launch.command,
          cwd,
          landingPath: input.landingPath,
          port: input.port,
          revision: selected.revision,
          validationDigest,
        }),
      )
      .digest("hex");
    if (
      selected.reusable &&
      previous?.requestDigest === requestDigest &&
      hasLiveWorkingPreview(previous, sandbox.id) &&
      previous.providerSessionId === provider.currentSession().sessionId
    ) {
      const command = await provider.getCommand(previous.commandId, { signal: ctx.abortSignal });
      if (command.exitCode === null) {
        bindProductBehaviorPreview(previous.commandId, evidenceGeneration);
        return { commandAdjustment: launch.adjustment, workingPreview: previous.receipt };
      }
    }
    const { appId } = selected;
    const packageManifest = await sandbox.readTextFile({ path: `${cwd}/package.json` });
    const dependencyInput = {
      root: selected.root,
      sandbox,
      signal: ctx.abortSignal,
    };
    await ensureCheckoutDependencies(
      usesNext(packageManifest)
        ? { ...dependencyInput, requiredExecutable: "next" }
        : dependencyInput,
    );
    let environmentPath: string | undefined;
    if (await appDeclaresLocalSetup({ appId, root: selected.root, sandbox })) {
      const setup = await prepareAppLocalPreview({
        appId,
        root: selected.root,
        sandbox,
        signal: ctx.abortSignal,
      });
      if (setup.status === "failed") {
        throw new Error(
          `The app's local data setup failed before preview startup. ${setup.problem}\nCommand: ${setup.command}\n${setup.stderr || setup.stdout || "No command output was returned."}`,
        );
      }
      environmentPath = localRuntimeEnvironmentPath(selected.root, appId);
    }
    workingPreviewState.update(() => null);
    let ownedAttemptId: string | undefined;
    let prepareAuthenticatedOrigin: ((origin: string) => Promise<void>) | undefined;
    if (environmentPath !== undefined) {
      prepareAuthenticatedOrigin = async (authOrigin) => {
        const setup = await prepareAppLocalPreview({
          appId,
          authOrigin,
          root: selected.root,
          sandbox,
          signal: ctx.abortSignal,
        });
        if (setup.status === "failed") {
          throw new Error(setup.problem);
        }
      };
    }
    const preview = await startWorkingPreview({
      ...input,
      appId: selected.appId,
      command: launch.command,
      cwd,
      environmentPath,
      onAttempt: (attempt) => {
        workingPreviewAttemptState.update((currentAttempt) => {
          if (attempt === null) {
            return currentAttempt?.attemptId === ownedAttemptId ? null : currentAttempt;
          }
          ownedAttemptId = attempt.attemptId;
          return attempt;
        });
      },
      prepareAuthenticatedOrigin,
      previous,
      provider,
      requestDigest,
      sandboxId: sandbox.id,
      signal: ctx.abortSignal,
    });
    workingPreviewState.update(() => preview);
    bindProductBehaviorPreview(preview.commandId, evidenceGeneration);
    return { commandAdjustment: launch.adjustment, workingPreview: preview.receipt };
  },
  inputSchema: z.object({
    appId: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u)
      .optional(),
    command: z.object({
      args: z.array(z.string().max(8192)).max(256),
      executable: z.string().min(1).max(1024),
    }),
    landingPath: z.string().min(1).max(2048).default("/"),
    port: z.number().int().min(1024).max(65_535).default(3000),
    workingDirectory: previewWorkingDirectorySchema,
  }),
});
