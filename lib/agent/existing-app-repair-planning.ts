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
  readPrivateApplyAuthority,
} from "./private-apply-authority";
import {
  assertExactWorkflowState,
  appBuilderWorkflowState,
  sha256,
  updateExactWorkflow,
} from "./workflow-state";
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
  suspendedWorkflow?: Extract<AppBuilderWorkflowState, { phase: "planned" }>;
}
interface RepairInspection {
  approvedBase?: Settled;
  assertCurrent: () => void;
  requestDigest: string;
  reuse: boolean;
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
    base.appSpec.appId !== current.appSpec.appId ||
    base.appSpec.digest !== current.appSpec.digest ||
    base.workspace.workspacePath !== current.workspace.workspacePath ||
    base.workspace.workspaceDigest !== current.workspace.workspaceDigest ||
    base.workspace.sourceSha !== current.workspace.sourceSha ||
    base.workspace.sourceTree !== current.workspace.sourceTree ||
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

const assertRepairApproval = (base: Settled, sessionId: string) => {
  assertNoPendingPrivateApplyApproval();
  assertApprovedPrivateApplySession({
    appId: base.appSpec.appId,
    appSpecDigest: base.appSpec.digest,
    proposalDigest: base.proposal.digest,
    sessionId,
    workspaceId: base.workspace.workspaceId,
  });
};

const approvedRepairHistory = (proposalDigest: string, sessionId: string): RepairHistoryEntry => {
  const matches = existingAppRepairHistory
    .get()
    .filter((entry) => entry.proposalDigest === proposalDigest);
  if (matches.length === 0) {
    throw new Error(
      "This proposal has no retained approved predecessor. Reuse the current plan with prepare_app_creation without options. To implement that proposal, use apply_app_creation with the selected compute profile and implementation files. Its normal approval policy presents or reuses Build approval for the exact current proposal. Preserve the saved work if the approval cannot be reconciled.",
    );
  }
  const [entry] = matches;
  if (matches.length !== 1 || entry?.sessionId !== sessionId || !settled(entry.approvedBase)) {
    throw new Error(
      "The approved build history is unavailable for this session and repair proposal.",
    );
  }
  return entry;
};

/** Resume the original execution scope while retaining the unapplied proposal in history. */
export const resumeApprovedAppBuild = async (
  ctx: Pick<ToolContext, "abortSignal" | "getSandbox" | "session">,
) => {
  ctx.abortSignal?.throwIfAborted();
  const current = appBuilderWorkflowState.get();
  if (current.phase !== "planned") {
    throw new Error("Resuming an approved build requires an unapplied same-app repair proposal.");
  }
  const entry = approvedRepairHistory(current.proposal.digest, ctx.session.id);
  const { approvedBase: base } = entry;
  assertRepairApproval(base, ctx.session.id);
  const sandbox = await ctx.getSandbox();
  ctx.abortSignal?.throwIfAborted();
  if (!isDeepStrictEqual(approvedRepairHistory(current.proposal.digest, ctx.session.id), entry)) {
    throw new Error("The approved build history changed while opening the checkout.");
  }
  assertRepairApproval(base, ctx.session.id);
  assertRepairBinding(current, base, sandbox);
  if (base.githubSource?.digest !== current.githubSource?.digest) {
    throw new Error("The selected repository changed after the approved build.");
  }
  const { publishedGitHubDraftProposalDigest } = base;
  const checkoutDependencyAttempts = new Map(
    [...(base.checkoutDependencyAttempts ?? []), ...(current.checkoutDependencyAttempts ?? [])].map(
      (attempt) => [attempt.attemptDigest, attempt],
    ),
  );

  updateExactWorkflow({
    expected: current,
    operation: "resume the approved build",
    transition: () => {
      const ordered = {
        appSpec: base.appSpec,
        applyReceipt: base.applyReceipt,
        artifacts: current.artifacts,
      };
      const withAttempts =
        checkoutDependencyAttempts.size > 0
          ? { ...ordered, checkoutDependencyAttempts: [...checkoutDependencyAttempts.values()] }
          : ordered;
      const withDependencies = { ...withAttempts, dependencyReceipt: base.dependencyReceipt };
      const withSource =
        base.githubSource === undefined
          ? withDependencies
          : { ...withDependencies, githubSource: base.githubSource };
      const withProposal = {
        ...withSource,
        identityReceipt: base.identityReceipt,
        phase: "applied" as const,
        preparedByCallId: base.preparedByCallId,
        proposal: base.proposal,
      };
      const withPublishedProposal =
        publishedGitHubDraftProposalDigest === undefined
          ? withProposal
          : { ...withProposal, publishedGitHubDraftProposalDigest };
      return {
        ...withPublishedProposal,
        sourceReceipt: base.sourceReceipt,
        version: base.version,
        workspace: base.workspace,
      };
    },
  });
  existingAppRepairHistory.update((history) =>
    history.map((record) =>
      record.proposalDigest === current.proposal.digest && record.sessionId === ctx.session.id
        ? { ...record, suspendedWorkflow: current }
        : record,
    ),
  );
  return { appId: base.appSpec.appId, status: "resumed_approved_build" as const };
};

/** Historical context for delivery to inspect in the tenant journal. Sealing is not publication. */
export const priorResumedBuildDraftProposal = (
  state: Extract<AppBuilderWorkflowState, { phase: "validated" | "reviewed" }>,
  sessionId: string,
) => {
  const entry = existingAppRepairHistory.get().findLast((record) => {
    const { approvedBase: base } = record;
    return [
      record.sessionId === sessionId,
      record.suspendedWorkflow !== undefined,
      base.phase === "reviewed" && base.githubDraftProposal !== undefined,
      base.appSpec.appId === state.appSpec.appId,
      base.appSpec.digest === state.appSpec.digest,
      base.workspace.workspaceId === state.workspace.workspaceId,
      base.workspace.workspacePath === state.workspace.workspacePath,
      base.sourceReceipt.digest === state.sourceReceipt.digest,
      base.githubSource?.digest === state.githubSource?.digest,
    ].every(Boolean);
  });
  const base = entry?.approvedBase;
  return base?.phase === "reviewed" ? base.githubDraftProposal?.proposal : undefined;
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
const hasUnchangedPreparedPreimages = async (current: Proposed, sandbox: SandboxSession) => {
  if (!("iteration" in current.proposal.target)) {
    return false;
  }
  for (const change of current.proposal.target.iteration.changes) {
    // Ordered reads bind reuse to actual unchanged prepared preimages, never an old applied repair.
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Each file preimage belongs to the exact prepared proposal.
    const bytes = await sandbox.readBinaryFile({ path: `repository/${change.path}` });
    if (
      (bytes === null) !== (change.before === undefined) ||
      (bytes !== null && createHash("sha256").update(bytes).digest("hex") !== change.before?.digest)
    ) {
      return false;
    }
    if (bytes !== null) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Preserve ordered path/mode observation.
      const mode = await sandbox.run({
        command: `stat -c %a '/workspace/repository/${change.path.replaceAll("'", "'\"'\"'")}'`,
      });
      if (mode.exitCode !== 0 || mode.stdout.trim() !== change.before?.mode) {
        return false;
      }
    }
  }
  return true;
};

/** A plan can be amended without treating a prior execution grant as approval. */
const inspectUnapprovedPlan = (
  current: Extract<AppBuilderWorkflowState, { phase: "planned" }>,
  changes: readonly ExistingAppChange[],
  sandbox: SandboxSession,
  ctx: Pick<ToolContext, "callId" | "abortSignal" | "session">,
  requestDigest: string,
): RepairInspection => {
  if (
    !("operation" in current.proposal.target) ||
    current.proposal.target.operation !== "iterate-existing-app" ||
    !("iteration" in current.proposal.target) ||
    current.proposal.plannedByCallId.length === 0
  ) {
    throw new Error("The unapplied plan has no frozen existing-app planning binding.");
  }
  const authority = readPrivateApplyAuthority();
  // The producer binds its unique call ID into the digest. Apply records this
  // proposal's grant BEFORE any I/O; an unresolved apply must not be amended.
  if (authority.grant?.proposalDigest === current.proposal.digest) {
    throw new Error("Reconcile the approved private operation before amending its plan.");
  }
  const assertCurrent = () => {
    ctx.abortSignal?.throwIfAborted();
    assertExactWorkflowState(appBuilderWorkflowState.get(), current, "amend an unapplied plan");
    assertNoPendingPrivateApplyApproval();
    if (
      !isDeepStrictEqual(readPrivateApplyAuthority(), authority) ||
      getBuilderSandboxId(sandbox) !== current.workspace.workspaceId
    ) {
      throw new Error("The unapplied plan authority or workspace changed.");
    }
  };
  assertCurrent();
  validateRepairChanges(changes, current);
  // The target planner captures the current preimages for the successor.
  // No approvedBase: the new proposal must obtain its own Build approval.
  return { approvedBase: undefined, assertCurrent, requestDigest, reuse: false };
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
  const matchingHistory = existingAppRepairHistory
    .get()
    .filter((entry) => entry.proposalDigest === current.proposal.digest);
  if (matchingHistory.some((entry) => entry.sessionId !== ctx.session.id)) {
    throw new Error("The prepared repair history belongs to another session.");
  }
  const previous = matchingHistory.at(-1);
  let base: Settled | undefined;
  if (settled(current)) {
    base = current;
  } else if (current.phase === "planned") {
    base = previous?.approvedBase;
  }
  if (base === undefined && current.phase === "planned" && previous === undefined) {
    return inspectUnapprovedPlan(current, changes, sandbox, ctx, requestDigest);
  }
  if (base === undefined) {
    throw new Error(
      "Finish or reconcile the current private operation before preparing an explicit app repair.",
    );
  }
  assertRepairBinding(current, base, sandbox);
  assertRepairApproval(base, ctx.session.id);
  const assertCurrent = () => {
    ctx.abortSignal?.throwIfAborted();
    assertExactWorkflowState(appBuilderWorkflowState.get(), current, "prepare the same-app repair");
    assertRepairApproval(base, ctx.session.id);
    if (getBuilderSandboxId(sandbox) !== base.workspace.workspaceId) {
      throw new Error("The private repair workspace changed.");
    }
  };
  validateRepairChanges(changes, current);
  if (current.phase === "planned" && previous?.requestDigest === requestDigest) {
    const reuse = await hasUnchangedPreparedPreimages(current, sandbox);
    assertCurrent();
    return { approvedBase: base, assertCurrent, requestDigest, reuse };
  }
  ctx.abortSignal?.throwIfAborted();
  assertExactWorkflowState(
    appBuilderWorkflowState.get(),
    current,
    "prepare an explicit app repair",
  );
  assertCurrent();
  return { approvedBase: base, assertCurrent, requestDigest, reuse: false };
};
