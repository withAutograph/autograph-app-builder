import type { ExistingAppChange } from "./existing-app-changes";
import { createHash } from "node:crypto";
import { isHostedVercelRuntime } from "../sandbox/backend";
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
    version: 1,
    id: PRIVATE_COMPUTE_PROFILE_ID,
    vcpus: 8,
    memoryMiB: 16_384,
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
    const next: Extract<AppBuilderWorkflowState, { phase: "app_spec_accepted" }> = {
      version: APP_BUILDER_WORKFLOW_VERSION,
      phase: "app_spec_accepted",
      appSpec: current.appSpec,
      artifacts: current.artifacts,
      preparedByCallId: callId,
      workspace: current.workspace,
      sourceReceipt: current.sourceReceipt,
    };
    if (current.githubSource !== undefined) {
      next.githubSource = current.githubSource;
    }
    if (current.checkoutDependencyAttempts !== undefined) {
      next.checkoutDependencyAttempts = current.checkoutDependencyAttempts;
    }
    return next;
  });
};
export const preparePrivateComputePlanning = async (input: {
  state: AppBuilderWorkflowState;
  sandbox: SandboxSession;
  requested?: PrivateComputeProfile["id"];
  repairChanges?: readonly ExistingAppChange[];
  callId: string;
}) => {
  const retained =
    "proposal" in input.state ? input.state.proposal.target.privateCompute : undefined;
  const selected = input.requested ?? retained?.id;
  if (selected === undefined) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- No selected compute profile is an explicit optional result.
    return undefined;
  }
  if (!("appSpec" in input.state)) {
    throw new Error("Accept the app product before selecting private compute.");
  }
  if (
    retained === undefined &&
    input.repairChanges === undefined &&
    isHostedVercelRuntime(process.env)
  ) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- No local profile is selected for an ordinary hosted plan.
    return undefined;
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
export const privateComputeProjection = (
  profile?: PrivateComputeProfile,
  requested?: PrivateComputeProfile["id"],
) => {
  if (profile === undefined) {
    return requested === undefined
      ? {}
      : {
          privateComputeGuidance:
            "Standard compute is available for this plan. The optional checker investigation profile is local-only. Continue with the current workspace and omit privateCompute from apply_app_creation.",
        };
  }
  const sha256 = createHash("sha256").update(PRIVATE_COMPUTE_CHECK_TASK).digest("hex");
  if (profile.checkPolicy.afterSha256 !== sha256) {
    throw new Error(
      "The frozen private compute policy does not match the installed reviewed recipe.",
    );
  }
  return {
    privateCompute: profile,
    checkTaskSha256: sha256,
    implementationFiles: [
      {
        path: profile.checkPolicy.path,
        operation: "upsert" as const,
        content: PRIVATE_COMPUTE_CHECK_TASK,
      },
    ],
  };
};
