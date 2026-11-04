import { reconcilePrivateApplyDecisions } from "./reconcile-private-apply-decisions";
/* oxlint-disable sonarjs/max-union-size, sonarjs/expression-complexity -- Preserve exact closed workflow phases and immutable receipt comparisons at this authorization boundary. */
import { samePrivateComputeIntent } from "./private-compute-planning";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { defineState } from "eve/context";
import type { SandboxSession } from "eve/sandbox";
import type { ToolContext } from "eve/tools";
import { getBuilderSandboxId } from "../sandbox/builder-sandbox";
import { safeSourcePath } from "../repository/source-path";
import {
  assertApprovedPrivateApplySession,
  assertNoPendingPrivateApplyApproval,
} from "./private-apply-authority";
import { assertExactWorkflowState, appBuilderWorkflowState, sha256 } from "./workflow-state";
import type { AppBuilderWorkflowState } from "./workflow-state";
import type { ExistingAppChange } from "./existing-app-changes";

// oxlint-disable-next-line sonarjs/max-union-size -- These are the exact settled private workflow phases, not a new phase model.
type Settled = Extract<
  AppBuilderWorkflowState,
  { phase: "applied" | "validated" | "reviewed" | "validation_failed" }
>;
interface RepairHistoryEntry {
  requestDigest: string;
  proposalDigest: string;
  sessionId: string;
  previousWorkflow: AppBuilderWorkflowState;
  approvedBase: Settled;
}
/** Separate linear history; workflow snapshots never recursively include this key. */
export const existingAppRepairHistory = defineState<readonly RepairHistoryEntry[]>(
  "autograph-app-builder.existing-app-repair-history.v1",
  () => [],
);
// oxlint-disable-next-line sonarjs/expression-complexity -- Only completed private execution states may authorize a repair.
const settled = (state: AppBuilderWorkflowState): state is Settled =>
  state.phase === "applied" ||
  state.phase === "validated" ||
  state.phase === "reviewed" ||
  (state.phase === "validation_failed" &&
    ["command-failed", "tooling-prerequisite"].includes(state.validationFailure.reason));

type Proposed = Extract<AppBuilderWorkflowState, { proposal: unknown }>;
/* oxlint-disable sonarjs/expression-complexity -- Keep every immutable source/receipt comparison visible at one authorization boundary. */
const assertRepairBinding = (current: Proposed, base: Settled, sandbox: SandboxSession) => {
  if (
    !isDeepStrictEqual(base.appSpec, current.appSpec) ||
    !isDeepStrictEqual(base.workspace, current.workspace) ||
    !(
      (base.proposal.target.privateCompute === undefined &&
        current.proposal.target.privateCompute === undefined) ||
      (current.proposal.target.privateCompute !== undefined &&
        samePrivateComputeIntent(
          base.proposal.target.privateCompute,
          current.proposal.target.privateCompute,
        ))
    ) ||
    base.workspace.workspaceId !== current.workspace.workspaceId ||
    base.sourceReceipt.digest !== current.sourceReceipt.digest ||
    base.workspace.workspaceId !== getBuilderSandboxId(sandbox) ||
    base.applyReceipt.appSpecDigest !== base.appSpec.digest ||
    base.applyReceipt.proposalDigest !== base.proposal.digest ||
    base.applyReceipt.workspaceDigest !== base.workspace.workspaceDigest ||
    base.applyReceipt.sourceReceiptDigest !== base.sourceReceipt.digest ||
    base.applyReceipt.applyRoot !== base.workspace.workspacePath
  ) {
    throw new Error("The settled private repair source binding changed.");
  }
};
const validateRepairChanges = (changes: readonly ExistingAppChange[], current: Proposed) => {
  const paths = new Set<string>();
  for (const change of changes) {
    if (
      !safeSourcePath(change.path) ||
      !change.path.startsWith(`apps/${current.appSpec.appId}/`) ||
      change.path === `apps/${current.appSpec.appId}/.config/app-spec.md` ||
      paths.has(change.path)
    ) {
      throw new Error("An existing-app repair path is not allowed.");
    }
    paths.add(change.path);
  }
  const profile = current.proposal.target.privateCompute;
  if (profile !== undefined && profile.target.sandboxId !== current.workspace.workspaceId) {
    throw new Error("The private compute repair target changed.");
  }
  if (
    profile !== undefined &&
    changes.some(
      (change) =>
        change.path === profile.checkPolicy.path &&
        (change.operation === "delete" ||
          sha256(change.content) !== profile.checkPolicy.afterSha256),
    )
  ) {
    throw new Error("The repair must preserve the exact reviewed private compute check policy.");
  }
};
const verifyPreparedPreimages = async (current: Proposed, sandbox: SandboxSession) => {
  if (!("iteration" in current.proposal.target)) {
    throw new Error("The prepared repair has no frozen app change inventory.");
  }
  for (const change of current.proposal.target.iteration.changes) {
    // Ordered reads bind reuse to actual unchanged prepared preimages, never an old applied repair.
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Each file preimage belongs to the exact prepared proposal.
    const bytes = await sandbox.readBinaryFile({ path: `repository/${change.path}` });
    if (
      (bytes === null) !== (change.before === undefined) ||
      (bytes !== null && createHash("sha256").update(bytes).digest("hex") !== change.before?.digest)
    ) {
      throw new Error(
        "The prepared repair preimage changed; reconcile its source before replanning.",
      );
    }
    if (bytes !== null) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Preserve ordered path/mode observation.
      const mode = await sandbox.run({
        command: `stat -c %a '/workspace/repository/${change.path.replaceAll("'", "'\"'\"'")}'`,
      });
      if (mode.exitCode !== 0 || mode.stdout.trim() !== change.before?.mode) {
        throw new Error("The prepared repair mode changed.");
      }
    }
  }
};

export const inspectExistingAppRepair = async (input: {
  current: AppBuilderWorkflowState;
  changes: readonly ExistingAppChange[] | undefined;
  sandbox: SandboxSession;
  ctx: Pick<ToolContext, "callId" | "abortSignal" | "session">;
}) => {
  const { current, changes, sandbox, ctx } = input;
  if (changes === undefined || changes.length === 0 || !("proposal" in current)) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Absence explicitly distinguishes ordinary idempotent planning from an authorized repair.
    return undefined;
  }
  ctx.abortSignal?.throwIfAborted();
  await reconcilePrivateApplyDecisions(ctx);
  assertNoPendingPrivateApplyApproval();
  const requestDigest = sha256(
    JSON.stringify(changes.toSorted((a, b) => a.path.localeCompare(b.path))),
  );
  const previous = existingAppRepairHistory
    .get()
    .findLast(
      (entry) =>
        entry.proposalDigest === current.proposal.digest && entry.sessionId === ctx.session.id,
    );
  let base: Settled | undefined;
  if (settled(current)) {
    base = current;
  } else if (current.phase === "planned") {
    base = previous?.approvedBase;
  }
  if (base === undefined) {
    throw new Error(
      "Finish or reconcile the current private operation before preparing an explicit app repair.",
    );
  }
  assertRepairBinding(current, base, sandbox);
  assertApprovedPrivateApplySession({
    appId: base.appSpec.appId,
    appSpecDigest: base.appSpec.digest,
    proposalDigest: base.proposal.digest,
    workspaceId: base.workspace.workspaceId,
    sessionId: ctx.session.id,
  });
  const assertCurrent = () => {
    ctx.abortSignal?.throwIfAborted();
    assertExactWorkflowState(appBuilderWorkflowState.get(), current, "prepare the same-app repair");
    assertNoPendingPrivateApplyApproval();
    assertApprovedPrivateApplySession({
      appId: base.appSpec.appId,
      appSpecDigest: base.appSpec.digest,
      proposalDigest: base.proposal.digest,
      workspaceId: base.workspace.workspaceId,
      sessionId: ctx.session.id,
    });
    if (getBuilderSandboxId(sandbox) !== base.workspace.workspaceId) {
      throw new Error("The private repair workspace changed.");
    }
  };
  validateRepairChanges(changes, current);
  if (current.phase === "planned" && previous?.requestDigest === requestDigest) {
    await verifyPreparedPreimages(current, sandbox);
    ctx.abortSignal?.throwIfAborted();
    assertExactWorkflowState(appBuilderWorkflowState.get(), current, "reuse the prepared repair");
    assertCurrent();
    return { requestDigest, approvedBase: base, reuse: true, assertCurrent };
  }
  ctx.abortSignal?.throwIfAborted();
  assertExactWorkflowState(
    appBuilderWorkflowState.get(),
    current,
    "prepare an explicit app repair",
  );
  assertCurrent();
  return { requestDigest, approvedBase: base, reuse: false, assertCurrent };
};
