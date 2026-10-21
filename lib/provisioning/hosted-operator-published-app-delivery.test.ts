import { expect, it } from "vitest";
import type { CompiledOperatorReleaseSelection } from "./hosted-operator-artifact-selection";
import { operatorPublicResultSchema } from "./hosted-operator-contract";
import { appDescriptionSchema } from "../repository/app-description";
import {
  resolvePublishedAppDelivery,
  withAppPublicationGuidance,
} from "./hosted-operator-published-app-delivery";

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
it.each(["bun run build", "npm run build", null])(
  "freezes the configured build command with the actual publication: %s",
  (buildCommand) => {
    const projectSettings = {
      buildCommand,
      framework: "nextjs",
      rootDirectory: "apps/actual-app",
      sourceFilesOutsideRootDirectory: true,
    };
    const publishedSource = {
      branch: "codex/generated-app",
      changeSetDigest: "d".repeat(64),
      gitSha: "e".repeat(40),
      gitTree: "f".repeat(40),
      repositoryId: "generated-repository",
      reviewDigest: "b".repeat(64),
    };
    const delivery = resolvePublishedAppDelivery(
      { ...application, projectSettings },
      { ...release, publishedSource },
    );
    expect(delivery.projectSettings).toEqual(projectSettings);
    expect(delivery.gitSha).toBe(publishedSource.gitSha);
    expect(delivery.repoId).toBe(publishedSource.repositoryId);
  },
);

it("freezes configured project settings alongside the selected release source", () => {
  const projectSettings = {
    framework: "nextjs",
    rootDirectory: "apps/spend-review",
    sourceFilesOutsideRootDirectory: true,
  };
  const publishedSource = {
    branch: "codex/generated-app",
    changeSetDigest: "d".repeat(64),
    gitSha: "e".repeat(40),
    gitTree: "f".repeat(40),
    repositoryId: "generated-repository",
    reviewDigest: "b".repeat(64),
  };
  expect(
    resolvePublishedAppDelivery(
      { ...application, projectSettings },
      { ...release, publishedSource },
    ),
  ).toEqual({
    branch: publishedSource.branch,
    gitSha: publishedSource.gitSha,
    repoId: publishedSource.repositoryId,
    projectId: application.projectId,
    projectSettings,
  });
});
it("uses the captured source profile and exact described workspace for a new selected release", () => {
  const publishedSource = {
    branch: "codex/generated-app",
    changeSetDigest: "d".repeat(64),
    gitSha: "e".repeat(40),
    gitTree: "f".repeat(40),
    repositoryId: "generated-repository",
    reviewDigest: "b".repeat(64),
  };
  const description = appDescriptionSchema.parse({
    app: { id: "spend-review", routes: ["/"], workspacePath: "apps/current-source" },
    backend: { kind: "static" },
    deployment: {
      buildCommand: null,
      framework: "nextjs",
      sourceFilesOutsideRootDirectory: true,
    },
    validation: { browser: null, check: { task: "check" }, test: { shards: 1, task: "test" } },
    version: 1,
  });
  const delivery = resolvePublishedAppDelivery(
    {
      ...application,
      projectSettings: {
        framework: "vite",
        rootDirectory: "apps/initial-registration",
        sourceFilesOutsideRootDirectory: false,
      },
    },
    { ...release, publishedSource },
    description,
  );
  expect(delivery.projectSettings).toEqual({
    buildCommand: null,
    framework: "nextjs",
    rootDirectory: "apps/current-source",
    sourceFilesOutsideRootDirectory: true,
  });
  expect(delivery.gitSha).toBe(publishedSource.gitSha);
});
it("passes only the described root for an older selected source without configured settings", () => {
  const description = appDescriptionSchema.parse({
    app: { id: "spend-review", routes: ["/"], workspacePath: "apps/accepted-source" },
    backend: { kind: "static" },
    validation: { browser: null, check: { task: "check" }, test: { shards: 1, task: "test" } },
    version: 1,
  });
  const delivery = resolvePublishedAppDelivery(
    application,
    {
      ...release,
      publishedSource: {
        branch: "current-branch",
        changeSetDigest: "d".repeat(64),
        gitSha: "e".repeat(40),
        gitTree: "f".repeat(40),
        repositoryId: "current-repository",
        reviewDigest: "b".repeat(64),
      },
    },
    description,
  );
  expect(delivery.projectSettings).toEqual({ rootDirectory: "apps/accepted-source" });
  expect(Object.keys(delivery.projectSettings ?? {})).toEqual(["rootDirectory"]);
});
it("does not substitute configured starter source for an unpublished generated release", () => {
  expect(() => resolvePublishedAppDelivery(application, release)).toThrow(
    "app_source_publication_required",
  );
});
it("retains explicitly configured delivery for legacy callers without a generated selection", () => {
  expect(resolvePublishedAppDelivery(application)).toEqual(application);
  expect(() => resolvePublishedAppDelivery({ branch: "main", projectId: "prj_app" })).toThrow(
    "operator_unavailable",
  );
});

it("preserves the publication prerequisite through the operator result contract", () => {
  const result = operatorPublicResultSchema.parse({
    appId: release.appId,
    authenticatedBehavior: "unassessed",
    code: "app_source_publication_required",
    status: "blocked",
  });
  const enriched = withAppPublicationGuidance(result);
  expect(enriched).toMatchObject(result);
  expect(enriched).toHaveProperty("nextAction", expect.any(String));
});

it.each([
  { status: "pending", code: "app_source_publication_required" },
  { status: "blocked", code: "operator_unavailable" },
  { status: "blocked", code: "reconciliation_required" },
  { status: "blocked", code: "operation_in_progress" },
  { status: "planned" },
] as const)("preserves other operator outcomes (%j)", (result) => {
  expect(withAppPublicationGuidance(result)).toBe(result);
});
