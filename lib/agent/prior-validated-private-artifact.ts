/* oxlint-disable eslint/complexity, sonarjs/expression-complexity -- Keep all independent immutable scope and receipt comparisons explicit at this read-only authority boundary. */
import { isDeepStrictEqual } from "node:util";
import type { SandboxSession } from "eve/sandbox";
import { canAutoSelectDevelopmentSource } from "../repository/development-source";
import { assertCurrentTargetApplyReceipt, inspectApplyOverlay } from "../repository/target-apply";
import { validationBinding } from "../repository/target-validation";
import { getBuilderSandboxId } from "../sandbox/builder-sandbox";
import { existingAppRepairHistory } from "./existing-app-repair-planning";
import { inspectPlannedAuthoringCandidate } from "./planned-proposal-authoring";
import { readPrivateApplyAuthority } from "./private-apply-authority";
import { appBuilderWorkflowState, assertExactWorkflowState, sha256 } from "./workflow-state";
import type { AppBuilderWorkflowState } from "./workflow-state";

const unavailable = () =>
  new Error("The prior validated private artifact cannot be verified for this denied plan.");

const digestMatches = ({ digest, ...unsigned }: { digest: string }) =>
  digest === sha256(JSON.stringify(unsigned));

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
  const denial = inspectPlannedAuthoringCandidate({
    current: state,
    authority,
    history,
    sessionId,
  });
  const matches = history.filter((entry) => entry.proposalDigest === state.proposal.digest);
  const entry = matches[0];
  const prior = entry?.approvedBase;
  if (
    denial === null ||
    matches.length !== 1 ||
    entry?.sessionId !== sessionId ||
    prior?.phase !== "validated" ||
    !isDeepStrictEqual(entry.previousWorkflow, prior) ||
    prior.githubSource !== undefined ||
    !isDeepStrictEqual(state.appSpec, prior.appSpec) ||
    !isDeepStrictEqual(state.sourceReceipt, prior.sourceReceipt) ||
    !isDeepStrictEqual(state.workspace, prior.workspace)
  ) {
    throw unavailable();
  }
  const apply = prior.applyReceipt;
  const validation = prior.validationReceipt;
  assertCurrentTargetApplyReceipt(apply);
  const binding = validationBinding(apply, validation.testShards);
  if (
    !isDeepStrictEqual(authority.grant, {
      ...denial.scope,
      proposalDigest: prior.proposal.digest,
    }) ||
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

  const assertCurrent = () => {
    signal?.throwIfAborted();
    assertExactWorkflowState(
      appBuilderWorkflowState.get(),
      state,
      "select the prior validated private artifact",
    );
    if (
      !isDeepStrictEqual(readPrivateApplyAuthority(), authority) ||
      !isDeepStrictEqual(existingAppRepairHistory.get(), history) ||
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
    if (observed.treeDigest !== apply.postTreeDigest) {
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
