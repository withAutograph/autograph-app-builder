import { expect, it } from "vitest";
import type { CompiledOperatorReleaseSelection } from "./hosted-operator-artifact-selection";
import { resolvePublishedAppDelivery } from "./hosted-operator-published-app-delivery";

const application = {
  branch: "main",
  gitSha: "a".repeat(40),
  projectId: "prj_app",
  repoId: "starter-repository",
};
const release: CompiledOperatorReleaseSelection = {
  appId: "spend-review",
  appSpecDigest: "a".repeat(64),
  artifactRef: "selected-release",
  manifestSha256: "b".repeat(64),
  releaseId: "release",
  schemaSha256: "c".repeat(64),
  version: 1,
};
it("uses the selected release's actual published repository, ref and commit", () => {
  const publishedSource = {
    branch: "codex/generated-app",
    changeSetDigest: "d".repeat(64),
    gitSha: "e".repeat(40),
    gitTree: "f".repeat(40),
    repositoryId: "generated-repository",
    reviewDigest: "b".repeat(64),
  };
  expect(resolvePublishedAppDelivery(application, { ...release, publishedSource })).toEqual({
    branch: publishedSource.branch,
    gitSha: publishedSource.gitSha,
    repoId: publishedSource.repositoryId,
    projectId: application.projectId,
  });
  expect(application.branch).toBe("main");
});
it("does not substitute configured starter source for an unpublished generated release", () => {
  expect(() => resolvePublishedAppDelivery(application, release)).toThrow("operator_unavailable");
});
it("retains explicitly configured delivery for legacy callers without a generated selection", () => {
  expect(resolvePublishedAppDelivery(application)).toEqual(application);
  expect(() => resolvePublishedAppDelivery({ branch: "main", projectId: "prj_app" })).toThrow(
    "operator_unavailable",
  );
});
