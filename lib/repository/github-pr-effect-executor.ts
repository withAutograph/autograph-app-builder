import {
  createGitHubPrEffectReceipt,
  githubPrEffectIntentDigest,
  parseGitHubPrEffectReceipt,
} from "./github-pr-effect-journal";
import type {
  GitHubPrEffectIntent,
  GitHubPrEffectReceipt,
  GitHubPrEffectStore,
} from "./github-pr-effect-journal";
import { GitHubPrEffectRejectedError } from "./github-pr-delivery";
import type { GitHubPrDeliveryObservation, GitHubPrDeliveryProvider } from "./github-pr-delivery";

type PendingReceipt = Extract<GitHubPrEffectReceipt, { status: "pending" }>;

interface ApprovedEffect {
  abortSignal?: AbortSignal;
  intent: GitHubPrEffectIntent;
  approvedByCallId: string;
  store: GitHubPrEffectStore;
  provider: GitHubPrDeliveryProvider;
}

const observesExpectedRevision = (
  intent: GitHubPrEffectIntent,
  observation: GitHubPrDeliveryObservation,
): boolean =>
  observation.headSha === intent.headSha && observation.baseBranch === intent.baseBranch;

const confirmedEffect = (pending: PendingReceipt, observation: GitHubPrDeliveryObservation) => {
  const { intent, approvedByCallId } = pending;
  if (!observesExpectedRevision(intent, observation) || observation.draft) {
    return null;
  }
  if (
    intent.kind === "pr-ready" &&
    observation.state === "open" &&
    observation.readyAt !== undefined
  ) {
    return createGitHubPrEffectReceipt({
      intent,
      approvedByCallId,
      status: "succeeded",
      evidence: { kind: "pr-ready", readyAt: observation.readyAt },
    });
  }
  if (
    intent.kind === "pr-merge" &&
    observation.state === "merged" &&
    observation.readyAt === intent.readyAt &&
    observation.mergeCommitSha !== undefined
  ) {
    return createGitHubPrEffectReceipt({
      intent,
      approvedByCallId,
      status: "succeeded",
      evidence: { kind: "pr-merge", mergeCommitSha: observation.mergeCommitSha },
    });
  }
  return null;
};

const journalAccess = ({
  intent,
  store,
  provider,
}: Pick<ApprovedEffect, "intent" | "store" | "provider">) => {
  const intentDigest = githubPrEffectIntentDigest(intent);
  const read = async () => {
    const raw = await store.read(intentDigest);
    if (raw === undefined) {
      return raw;
    }
    const stored = parseGitHubPrEffectReceipt(raw);
    if (stored.intentDigest !== intentDigest) {
      throw new Error("The GitHub effect journal belongs to a different approved intent.");
    }
    return stored;
  };
  const finish = async (pending: PendingReceipt, terminal: GitHubPrEffectReceipt) =>
    (await store.compareAndSet(intentDigest, pending.digest, terminal))
      ? terminal
      : ((await read()) ?? pending);
  const settle = async (pending: PendingReceipt, observation: GitHubPrDeliveryObservation) => {
    const confirmed = confirmedEffect(pending, observation);
    return confirmed === null ? pending : await finish(pending, confirmed);
  };
  const reconcile = async (stored: GitHubPrEffectReceipt) => {
    if (stored.status !== "pending") {
      return stored;
    }
    let observation: GitHubPrDeliveryObservation;
    try {
      observation = await provider.inspect(intent);
    } catch {
      return stored;
    }
    return await settle(stored, observation);
  };
  return { finish, intentDigest, read, reconcile, settle };
};

export const reconcileApprovedGitHubPrEffect = async (
  input: ApprovedEffect,
): Promise<GitHubPrEffectReceipt | undefined> => {
  const { read, reconcile } = journalAccess(input);
  const existing = await read();
  return existing === undefined ? existing : await reconcile(existing);
};

// The caller verifies authority before entering this executor. A pending row
// means an outward operation may already have happened and only readback is safe.
export const executeApprovedGitHubPrEffect = async ({
  abortSignal,
  intent,
  approvedByCallId,
  store,
  provider,
}: ApprovedEffect): Promise<GitHubPrEffectReceipt> => {
  const { finish, intentDigest, read, reconcile, settle } = journalAccess({
    intent,
    store,
    provider,
  });
  const existing = await read();
  if (existing !== undefined) {
    return await reconcile(existing);
  }

  const before = await provider.inspect(intent);
  if (!observesExpectedRevision(intent, before) || before.state !== "open") {
    throw new Error("The GitHub pull request no longer matches the approved open revision.");
  }
  if (intent.kind === "pr-ready" && !before.draft) {
    throw new Error("The approved GitHub pull request is no longer a draft.");
  }
  const passingReadyRun =
    !before.draft && before.checks === "passed" && before.checkRunId !== undefined;
  if (intent.kind === "pr-merge" && (!passingReadyRun || before.readyAt !== intent.readyAt)) {
    throw new Error("The approved GitHub pull request no longer has a passing current ready run.");
  }

  const pending = createGitHubPrEffectReceipt({ intent, approvedByCallId, status: "pending" });
  if (pending.status !== "pending") {
    throw new Error("Expected a pending GitHub effect receipt.");
  }
  abortSignal?.throwIfAborted();
  if (!(await store.compareAndSet(intentDigest, undefined, pending))) {
    const concurrent = await read();
    if (concurrent === undefined) {
      throw new Error("The GitHub effect journal changed concurrently.");
    }
    return await reconcile(concurrent);
  }

  // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
  const rejectEffect = (code: "provider-rejected" | "cancelled") =>
    finish(
      pending,
      createGitHubPrEffectReceipt({ intent, approvedByCallId, status: "failed", code }),
    );
  if (abortSignal?.aborted === true) {
    return await rejectEffect("cancelled");
  }
  let observation: GitHubPrDeliveryObservation;
  try {
    observation =
      intent.kind === "pr-ready"
        ? await provider.markReady(intent, abortSignal)
        : await provider.merge(intent, intent.readyAt, abortSignal);
  } catch (error) {
    if (error instanceof GitHubPrEffectRejectedError) {
      return await rejectEffect(error.code);
    }
    return await reconcile(pending);
  }
  return await settle(pending, observation);
};
