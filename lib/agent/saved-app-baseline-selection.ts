import type { ImmutableGitHubSourceReceipt } from "../repository/github-publication";
import type { SelectedAppBaseline } from "./app-baseline-state";

interface SavedBaselineSource {
  baseline: SelectedAppBaseline | undefined;
  githubSource: ImmutableGitHubSourceReceipt | undefined;
  sessionId: string;
}

const ownsSelectedSource = (input: SavedBaselineSource): boolean => {
  const { baseline, githubSource, sessionId } = input;
  if (baseline === undefined || githubSource === undefined) {
    return false;
  }
  return [
    baseline.selection.sessionId === sessionId,
    baseline.selection.historical.owner === githubSource.repository.owner,
    baseline.selection.historical.name === githubSource.repository.name,
    baseline.selection.historical.repositoryId === githubSource.repository.repositoryId,
  ].every(Boolean);
};

const hasProjectedReceipt = (input: SavedBaselineSource): boolean => {
  const { baseline } = input;
  if (!ownsSelectedSource(input) || baseline?.receipt === undefined) {
    return false;
  }
  const { receipt, selection } = baseline;
  const selectionKeys = ["appId", "historical", "selectedByCallId", "sessionId", "source"] as const;
  return selectionKeys.every(
    (key) => JSON.stringify(receipt[key]) === JSON.stringify(selection[key]),
  );
};

/** Correct only an already projected app commit mistakenly supplied as its platform branch. */
export const savedAppBaselineBranchCorrection = (
  input: SavedBaselineSource & {
    branch: string | undefined;
    repository: { owner: string; name: string; repositoryId: string };
  },
) => {
  const { baseline, branch, githubSource, repository } = input;
  if (
    !hasProjectedReceipt(input) ||
    baseline?.selection.source.kind !== "commit" ||
    branch === undefined ||
    githubSource === undefined
  ) {
    return null;
  }
  if (
    [
      branch !== baseline.selection.source.commitSha,
      branch !== baseline.selection.historical.commitSha,
      repository.owner !== githubSource.repository.owner,
      repository.name !== githubSource.repository.name,
      repository.repositoryId !== githubSource.repository.repositoryId,
    ].some(Boolean)
  ) {
    return null;
  }
  return {
    appId: baseline.selection.appId,
    historicalAppCommitSha: baseline.selection.historical.commitSha,
    kind: "saved-app-baseline-commit" as const,
    note: "The historical app version is already selected; the platform source remains on its saved branch.",
    platformRef: githubSource.resolvedRef,
    platformSha: githubSource.resolvedSha,
    requestedBranch: branch,
  };
};

/** Report selected provenance without treating a pending selection as prepared source. */
export const savedAppBaselineSummary = (input: SavedBaselineSource) => {
  const { baseline } = input;
  if (!ownsSelectedSource(input) || baseline === undefined) {
    return null;
  }
  if (baseline.receipt !== undefined && !hasProjectedReceipt(input)) {
    return null;
  }
  const summary = {
    appId: baseline.selection.appId,
    commitSha: baseline.selection.historical.commitSha,
    source: baseline.selection.source,
  };
  return baseline.receipt === undefined
    ? { ...summary, status: "pending" as const }
    : { ...summary, receiptDigest: baseline.receipt.digest, status: "prepared" as const };
};
