/* oxlint-disable eslint/complexity, sonarjs/expression-complexity -- Keep all independent immutable scope and receipt comparisons explicit at this read-only authority boundary. */
import { isDeepStrictEqual } from "node:util";
import type { SandboxSession } from "eve/sandbox";
import { canAutoSelectDevelopmentSource } from "../repository/development-source";
import { assertCurrentTargetApplyReceipt, inspectApplyOverlay } from "../repository/target-apply";
import { validationBinding } from "../repository/target-validation";
import { getBuilderSandboxId } from "../sandbox/builder-sandbox";
import { existingAppRepairHistory } from "./existing-app-repair-planning";
import { readPrivateApplyAuthority } from "./private-apply-authority";
import { appBuilderWorkflowState, sha256 } from "./workflow-state";
import type { AppBuilderWorkflowState } from "./workflow-state";

const unavailable = () =>
  new Error("The prior validated private artifact cannot be verified for the current plan.");

const digestMatches = ({ digest, ...unsigned }: { digest: string }) =>
  digest === sha256(JSON.stringify(unsigned));

const selectionBinding = (state: AppBuilderWorkflowState) =>
  state.phase === "planned"
    ? {
        appId: state.appSpec.appId,
        appSpecDigest: state.appSpec.digest,
        proposalDigest: state.proposal.digest,
        sourceReceiptDigest: state.sourceReceipt.digest,
        workspaceId: state.workspace.workspaceId,
        workspacePath: state.workspace.workspacePath,
        workspaceDigest: state.workspace.workspaceDigest,
        sourceSha: state.workspace.sourceSha,
        githubSourceDigest: state.githubSource?.digest,
      }
    : undefined;

const validationIdentity = (state: AppBuilderWorkflowState) =>
  state.phase === "validated"
    ? {
        proposalDigest: state.proposal.digest,
        applyDigest: state.applyReceipt.digest,
        validationDigest: state.validationReceipt.digest,
      }
    : undefined;

export const priorValidatedPrivateArtifact = async (input: {
  appId?: string;
  state: AppBuilderWorkflowState;
  sandbox: SandboxSession;
  sessionId: string;
  signal?: AbortSignal;
}) => {
  const { state, sandbox, sessionId, signal } = input;
  signal?.throwIfAborted();
  if (
    !canAutoSelectDevelopmentSource() ||
    state.phase !== "planned" ||
    state.githubSource !== undefined ||
    (input.appId !== undefined && input.appId !== state.appSpec.appId) ||
    state.workspace.workspaceId !== getBuilderSandboxId(sandbox)
  ) {
    throw unavailable();
  }
  const authority = readPrivateApplyAuthority();
  const history = existingAppRepairHistory.get();
  const matches = history.filter((entry) => entry.proposalDigest === state.proposal.digest);
  const [entry] = matches;
  const prior = entry?.approvedBase;
  if (
    authority.pending.length !== 0 ||
    "applyReceipt" in state ||
    matches.length !== 1 ||
    entry?.sessionId !== sessionId ||
    prior?.phase !== "validated" ||
    prior.githubSource !== undefined ||
    state.appSpec.digest !== prior.appSpec.digest ||
    state.sourceReceipt.digest !== prior.sourceReceipt.digest ||
    state.workspace.workspaceId !== prior.workspace.workspaceId ||
    state.workspace.workspacePath !== prior.workspace.workspacePath ||
    state.workspace.workspaceDigest !== prior.workspace.workspaceDigest ||
    state.workspace.sourceSha !== prior.workspace.sourceSha
  ) {
    throw unavailable();
  }
  const apply = prior.applyReceipt;
  const validation = prior.validationReceipt;
  assertCurrentTargetApplyReceipt(apply);
  const binding = validationBinding(apply, validation.testShards);
  // A running or already dispatched apply records its grant before any writes.
  // A merely drafted proposal does not need a denial to leave the prior app usable.
  const approvedScope = {
    appId: prior.appSpec.appId,
    appSpecDigest: prior.appSpec.digest,
    proposalDigest: prior.proposal.digest,
    sessionId,
    workspaceId: prior.workspace.workspaceId,
  };
  if (
    !isDeepStrictEqual(authority.grant, approvedScope) ||
    !digestMatches(prior.proposal) ||
    !digestMatches(apply) ||
    !digestMatches(validation) ||
    apply.status !== "applied" ||
    apply.targetReceipt.appId !== prior.appSpec.appId ||
    apply.applyRoot !== "/workspace/repository" ||
    apply.applyRoot !== prior.workspace.workspacePath ||
    apply.proposalDigest !== prior.proposal.digest ||
    apply.sourceReceiptDigest !== prior.sourceReceipt.digest ||
    apply.sourceSha !== prior.workspace.sourceSha ||
    apply.workspaceDigest !== prior.workspace.workspaceDigest ||
    apply.appSpecDigest !== prior.appSpec.digest ||
    validation.status !== "passed" ||
    validation.commands.length === 0 ||
    validation.commands.some((command) => command.exitCode !== 0) ||
    !isDeepStrictEqual({ ...validation, ...binding }, validation)
  ) {
    throw unavailable();
  }

  const selected = selectionBinding(state);
  const approved = validationIdentity(prior);
  const assertCurrent = () => {
    signal?.throwIfAborted();
    const currentAuthority = readPrivateApplyAuthority();
    const retained = existingAppRepairHistory
      .get()
      .filter((row) => row.proposalDigest === state.proposal.digest);
    const [retainedEntry] = retained;
    if (
      !isDeepStrictEqual(selectionBinding(appBuilderWorkflowState.get()), selected) ||
      currentAuthority.pending.length !== 0 ||
      !isDeepStrictEqual(currentAuthority.grant, approvedScope) ||
      retained.length !== 1 ||
      retainedEntry?.sessionId !== sessionId ||
      !isDeepStrictEqual(validationIdentity(retainedEntry.approvedBase), approved) ||
      getBuilderSandboxId(sandbox) !== state.workspace.workspaceId
    ) {
      throw unavailable();
    }
  };
  const verifyCurrent = async () => {
    assertCurrent();
    const observed = await inspectApplyOverlay(
      { run: async (options) => await sandbox.run({ ...options, abortSignal: signal }) },
      apply.applyRoot,
      "/workspace/repository",
    );
    assertCurrent();
    const sameSource =
      observed.files.length === apply.postTree.length &&
      observed.files.every(({ path, digest }, index) => {
        const retained = apply.postTree[index];
        return retained?.path === path && retained.digest === digest;
      });
    if (!sameSource) {
      throw unavailable();
    }
  };
  await verifyCurrent();
  return {
    appId: prior.appSpec.appId,
    root: apply.applyRoot,
    revision: apply.digest,
    validationDigest: validation.digest,
    reusable: true,
    assertCurrent,
    verifyCurrent,
  };
};
