import type { ExistingAppChange } from "./existing-app-changes";
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

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Select one declared, provider-observed profile before the new proposal is hashed; this performs no resource effect. */
export const planPrivateComputeProfile = async (
  sandbox: SandboxSession,
  appId: string,
  prospectiveCheck?: string,
) => {
  if (!canAutoSelectDevelopmentSource()) {
    throw new Error(
      "This private compute profile currently requires the supported local Builder launch and its scoped provider observations.",
    );
  }
  const limits = readPrivateComputeLimits();
  const native = await getVercelPreviewProvider(getBuilderSandboxId(sandbox), undefined, false);
  const mount = native.mounts?.["/workspace"];
  if (!native.persistent || mount?.mode !== "read-write") {
    throw new Error(
      "Private compute changes require this app's existing persistent workspace Drive.",
    );
  }
  const checkPath = `apps/${appId}/.config/mise/tasks/check`;
  const current = await sandbox.readTextFile({ path: `repository/${checkPath}` });
  const before =
    current ??
    (await sandbox.readTextFile({
      path: "repository/.config/turbo/generators/templates/app/.config/mise/tasks/check.hbs",
    }));
  if (
    before === null ||
    !(
      before === LEGACY_PRIVATE_COMPUTE_CHECK_TASK ||
      before === PRIVATE_COMPUTE_CHECK_TASK ||
      prospectiveCheck === PRIVATE_COMPUTE_CHECK_TASK
    )
  ) {
    throw new Error(
      "This app has a custom check task. Preserve it and plan its compute-aware adaptation through the normal reviewed app change flow; no task was replaced.",
    );
  }
  return privateComputeProfileSchema.parse({
    checkPolicy: {
      afterSha256: hash(PRIVATE_COMPUTE_CHECK_TASK),
      beforeSha256: hash(before),
      path: checkPath,
    },
    id: PRIVATE_COMPUTE_PROFILE_ID,
    limits,
    lintWorkers: 1,
    memoryMiB: 16_384,
    target: { sandboxId: native.name, workspaceDrive: mount.drive },
    vcpus: 8,
    version: 1,
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
  if (!("appSpec" in current)) {
    throw new Error("Accept the product before selecting private compute.");
  }
  if (
    samePrivateComputeIntent(
      "proposal" in current ? current.proposal.target.privateCompute : undefined,
      profile,
    )
  ) {
    return;
  }
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
  ) {
    throw new Error(
      "Finish the pending private operation before preparing a different compute profile.",
    );
  }
  appBuilderWorkflowState.update((latest) => {
    assertExactWorkflowState(latest, current, "prepare a new private compute plan");
    const nextState = {
      appSpec: current.appSpec,
      artifacts: current.artifacts,
      phase: "app_spec_accepted" as const,
      preparedByCallId: callId,
      sourceReceipt: current.sourceReceipt,
      version: APP_BUILDER_WORKFLOW_VERSION,
      workspace: current.workspace,
    };
    const withSource =
      current.githubSource === undefined
        ? nextState
        : { ...nextState, githubSource: current.githubSource };
    return current.checkoutDependencyAttempts === undefined
      ? withSource
      : { ...withSource, checkoutDependencyAttempts: current.checkoutDependencyAttempts };
  });
};
export const preparePrivateComputePlanning = async (input: {
  state: AppBuilderWorkflowState;
  sandbox: SandboxSession;
  requested?: PrivateComputeProfile["id"];
  repairChanges?: readonly ExistingAppChange[];
  callId: string;
}) => {
  const selected =
    input.requested ??
    ("proposal" in input.state ? input.state.proposal.target.privateCompute?.id : undefined);
  if (selected === undefined) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- No selected compute profile is an explicit optional result.
    return undefined;
  }
  if (!("appSpec" in input.state)) {
    throw new Error("Accept the app product before selecting private compute.");
  }
  const { appId } = input.state.appSpec;
  const check = input.repairChanges?.find(
    (change) => change.path === `apps/${appId}/.config/mise/tasks/check`,
  );
  const profile = await planPrivateComputeProfile(
    input.sandbox,
    input.state.appSpec.appId,
    check?.content,
  );
  if (
    input.repairChanges !== undefined &&
    !(
      "proposal" in input.state &&
      samePrivateComputeIntent(input.state.proposal.target.privateCompute, profile)
    )
  ) {
    throw new Error(
      "The same-app repair must retain its observed private compute target and policy.",
    );
  }
  refreshPrivateComputePlanning(appBuilderWorkflowState.get(), profile, input.callId);
  return profile;
};
/** Source-owned repair guidance is not approval and never changes the frozen profile. */
export const privateComputeProjection = (profile?: PrivateComputeProfile) => {
  if (profile === undefined) {
    return {};
  }
  const sha256 = createHash("sha256").update(PRIVATE_COMPUTE_CHECK_TASK).digest("hex");
  if (profile.checkPolicy.afterSha256 !== sha256) {
    throw new Error(
      "The frozen private compute policy does not match the installed reviewed recipe.",
    );
  }
  return {
    checkTaskSha256: sha256,
    implementationFiles: [
      {
        content: PRIVATE_COMPUTE_CHECK_TASK,
        operation: "upsert" as const,
        path: profile.checkPolicy.path,
      },
    ],
    privateCompute: profile,
  };
};
