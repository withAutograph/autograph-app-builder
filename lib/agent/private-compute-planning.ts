import { createHash } from "node:crypto";
import {
  appBuilderWorkflowState,
  assertExactWorkflowState,
  APP_BUILDER_WORKFLOW_VERSION,
} from "./workflow-state";
import type { AppBuilderWorkflowState } from "./workflow-state";
import { getBuilderSandboxId } from "../sandbox/builder-sandbox";
import { getVercelPreviewProvider } from "../sandbox/vercel-preview-provider";
import {
  privateComputeProfileSchema,
  readPrivateComputeLimits,
  PRIVATE_COMPUTE_PROFILE_ID,
  PRIVATE_COMPUTE_CHECK_TASK,
  LEGACY_PRIVATE_COMPUTE_CHECK_TASK,
} from "../sandbox/private-compute-profile";
import type { PrivateComputeProfile } from "../sandbox/private-compute-profile";
import type { SandboxSession } from "eve/sandbox";
import { canAutoSelectDevelopmentSource } from "../repository/development-source";

/** Select one declared, provider-observed profile before the new proposal is hashed; this performs no resource effect. */
export const planPrivateComputeProfile = async (sandbox: SandboxSession, appId: string) => {
  if (!canAutoSelectDevelopmentSource())
    throw new Error(
      "This private compute profile currently requires the supported local Builder launch and its scoped provider observations.",
    );
  const limits = readPrivateComputeLimits();
  const native = await getVercelPreviewProvider(getBuilderSandboxId(sandbox), undefined, false);
  const mount = native.mounts?.["/workspace"];
  if (!native.persistent || mount?.mode !== "read-write")
    throw new Error(
      "Private compute changes require this app's existing persistent workspace Drive.",
    );
  const checkPath = `apps/${appId}/.config/mise/tasks/check`;
  const current = await sandbox.readTextFile({ path: `repository/${checkPath}` });
  const before =
    current ??
    (await sandbox.readTextFile({
      path: "repository/.config/turbo/generators/templates/app/.config/mise/tasks/check.hbs",
    }));
  if (
    before === null ||
    !(before === LEGACY_PRIVATE_COMPUTE_CHECK_TASK || before === PRIVATE_COMPUTE_CHECK_TASK)
  )
    throw new Error(
      "This app has a custom check task. Preserve it and plan its compute-aware adaptation through the normal reviewed app change flow; no task was replaced.",
    );
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  return privateComputeProfileSchema.parse({
    version: 1,
    id: PRIVATE_COMPUTE_PROFILE_ID,
    vcpus: 8,
    memoryMiB: 16384,
    lintWorkers: 1,
    target: { sandboxId: native.name, workspaceDrive: mount.drive },
    checkPolicy: {
      path: checkPath,
      beforeSha256: hash(before),
      afterSha256: hash(PRIVATE_COMPUTE_CHECK_TASK),
    },
    limits,
  });
};
/** Observation timestamps and installed preimages do not change a frozen compute intent. */
export const samePrivateComputeIntent = (
  previous: PrivateComputeProfile | undefined,
  profile: PrivateComputeProfile,
) =>
  previous !== undefined &&
  previous.id === profile.id &&
  JSON.stringify([
    previous.target,
    previous.limits.teamId,
    previous.limits.projectId,
    previous.checkPolicy.path,
    previous.checkPolicy.afterSha256,
  ]) ===
    JSON.stringify([
      profile.target,
      profile.limits.teamId,
      profile.limits.projectId,
      profile.checkPolicy.path,
      profile.checkPolicy.afterSha256,
    ]);
/** A changed compute intent is a new ordinary planning input, never a reuse of an old Build approval. */
export const refreshPrivateComputePlanning = (
  current: AppBuilderWorkflowState,
  profile: PrivateComputeProfile,
  callId: string,
) => {
  if (!("appSpec" in current))
    throw new Error("Accept the product before selecting private compute.");
  if (
    samePrivateComputeIntent(
      "proposal" in current ? current.proposal.target.privateCompute : undefined,
      profile,
    )
  )
    return;
  if (
    ![
      "app_spec_accepted",
      "dependencies_prepared",
      "identity_resolved",
      "planned",
      "applied",
      "validation_failed",
      "validated",
      "reviewed",
    ].includes(current.phase)
  )
    throw new Error(
      "Finish the pending private operation before preparing a different compute profile.",
    );
  appBuilderWorkflowState.update((latest) => {
    assertExactWorkflowState(latest, current, "prepare a new private compute plan");
    return {
      version: APP_BUILDER_WORKFLOW_VERSION,
      phase: "app_spec_accepted",
      appSpec: current.appSpec,
      artifacts: current.artifacts,
      preparedByCallId: callId,
      workspace: current.workspace,
      sourceReceipt: current.sourceReceipt,
      ...(current.githubSource === undefined ? {} : { githubSource: current.githubSource }),
      ...(current.checkoutDependencyAttempts === undefined
        ? {}
        : { checkoutDependencyAttempts: current.checkoutDependencyAttempts }),
    };
  });
};
export const preparePrivateComputePlanning = async (input: {
  state: AppBuilderWorkflowState;
  sandbox: SandboxSession;
  requested?: PrivateComputeProfile["id"];
  callId: string;
}) => {
  const selected =
    input.requested ??
    ("proposal" in input.state ? input.state.proposal.target.privateCompute?.id : undefined);
  if (selected === undefined) return undefined;
  if (!("appSpec" in input.state))
    throw new Error("Accept the app product before selecting private compute.");
  const profile = await planPrivateComputeProfile(input.sandbox, input.state.appSpec.appId);
  refreshPrivateComputePlanning(appBuilderWorkflowState.get(), profile, input.callId);
  return profile;
};
export const privateComputeProjection = (profile: PrivateComputeProfile | undefined) =>
  profile === undefined ? {} : { privateCompute: profile };
