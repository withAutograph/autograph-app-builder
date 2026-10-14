import { afterEach, describe, expect, it, vi } from "vitest";
import {
  publishedAppSourceFromResult,
  recordPublishedAppSourceForSession,
} from "./published-app-source";
import type { DraftPullRequestSuccessReceipt } from "../repository/github-publication";
import type { ExistingDraftObservation } from "../repository/github-draft-update";
import type { CompiledOperatorReleaseSelection } from "../provisioning/hosted-operator-artifact-selection";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Observe the trusted recording port without replacing its dependency closure.
import * as compiledArtifacts from "./compiled-operator-artifacts";

const digest = "a".repeat(64);
const review = { appSpecDigest: digest, changeSetDigest: "b".repeat(64), digest: "c".repeat(64) };
const initial: DraftPullRequestSuccessReceipt = {
  approvedByCallId: "original-approved-publication",
  baseBranch: "review-base",
  baseSha: "1".repeat(40),
  branchName: "app-builder/reviewed-fixture",
  branchSha: "2".repeat(40),
  branchTree: "3".repeat(40),
  changeSetDigest: review.changeSetDigest,
  changedContentDigest: "d".repeat(64),
  digest,
  draft: true,
  idempotencyKey: "e".repeat(64),
  installationIdentityDigest: "f".repeat(64),
  kind: "draft-pull-request",
  normalizedChangedPaths: ["apps/fixture-app/page.tsx"],
  proposalDigest: "b".repeat(64),
  providerReadBackDigest: "c".repeat(64),
  pullRequestId: "42",
  pullRequestNumber: 42,
  recoveredFromPending: false,
  releaseGateUnchanged: true,
  repositoryId: "4242",
  status: "succeeded",
  version: 2,
};
const updated: ExistingDraftObservation = {
  baseBranch: "review-base",
  baseRepositoryId: "4242",
  draft: true,
  headBranch: initial.branchName,
  headRepositoryId: "4242",
  headSha: "4".repeat(40),
  headTree: "5".repeat(40),
  name: "fixture-repository",
  number: 42,
  owner: "fixture-owner",
  pullRequestId: "42",
  repositoryId: "4242",
  state: "open",
};
const selected: CompiledOperatorReleaseSelection = {
  appId: "fixture-app",
  appSpecDigest: digest,
  artifactRef: `_protected-operator/artifacts/generated-release/fixture-app/${digest}`,
  manifestSha256: digest,
  releaseId: "fixture-release",
  schemaSha256: digest,
  version: 1,
};
const session = {
  adapterSessionId: "adapter-fixture",
  appId: selected.appId,
  appSpecDigest: digest,
  callId: "current-tool-call",
  root: "/workspace/repository",
  sessionAuth: { opaqueFixtureAuthority: true },
};
afterEach(() => vi.restoreAllMocks());

describe("actual published app source recording", () => {
  it("maps initial actual repository, branch and commit without inventing a target branch", () => {
    expect(publishedAppSourceFromResult(review, initial)).toMatchObject({
      branch: initial.branchName,
      changeSetDigest: review.changeSetDigest,
      gitSha: initial.branchSha,
      gitTree: initial.branchTree,
      repositoryId: initial.repositoryId,
      reviewDigest: review.digest,
    });
  });
  it("maps the verified update head instead of the original receipt commit", () => {
    const source = publishedAppSourceFromResult(review, updated);
    expect(source).toMatchObject({
      branch: updated.headBranch,
      gitSha: updated.headSha,
      gitTree: updated.headTree,
    });
    expect(source.gitSha).not.toBe(initial.branchSha);
  });
  it("reuses the original approved call for immutable initial publication recovery", async () => {
    const record = vi
      .spyOn(compiledArtifacts, "recordPublishedOperatorSourceForSession")
      .mockResolvedValue({ selection: selected, status: "recorded" });
    await recordPublishedAppSourceForSession({
      ...session,
      review,
      publication: { ...initial, recoveredFromPending: true },
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterSessionId: session.adapterSessionId,
        appSpecDigest: digest,
        callId: initial.approvedByCallId,
        publishedSource: publishedAppSourceFromResult(review, initial),
      }),
    );
  });
  it("uses the actual current update call and verified head on the reviewed candidate root", async () => {
    const record = vi
      .spyOn(compiledArtifacts, "recordPublishedOperatorSourceForSession")
      .mockResolvedValue({ selection: selected, status: "recorded" });
    const root = "/workspace/.app-builder/candidate";
    await recordPublishedAppSourceForSession({ ...session, root, review, publication: updated });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: session.callId,
        root,
        publishedSource: publishedAppSourceFromResult(review, updated),
      }),
    );
  });
  it("does not attach publication to a different reviewed app spec", async () => {
    const record = vi.spyOn(compiledArtifacts, "recordPublishedOperatorSourceForSession");
    await expect(
      recordPublishedAppSourceForSession({
        ...session,
        review: { ...review, appSpecDigest: "f".repeat(64) },
        publication: initial,
      }),
    ).rejects.toThrow("artifact is unavailable");
    expect(record).not.toHaveBeenCalled();
  });
  it("associates the reconciled head with the actual app review and merged-source approval", async () => {
    const record = vi
      .spyOn(compiledArtifacts, "recordPublishedOperatorSourceForSession")
      .mockResolvedValue({ selection: selected, status: "recorded" });
    const reconciliationReview = { digest: "d".repeat(64) };
    await recordPublishedAppSourceForSession({
      ...session,
      review,
      reconciliationReview,
      publication: updated,
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        appSpecDigest: review.appSpecDigest,
        publishedSource: {
          ...publishedAppSourceFromResult(review, updated),
          reviewDigest: reconciliationReview.digest,
        },
      }),
    );
  });
});
