import { describe, expect, it } from "vitest";
import type { RepositoryAccessReceipt } from "../agent/repository-access-state";
import type { CompiledOperatorReleaseSelection } from "./hosted-operator-artifact-selection";
import {
  RepositoryProductionDestinationRequiredError,
  resolveRepositoryProductionDestination,
} from "./repository-production-destination";

const profile = { workspaceId: "workspace", repositoryId: "123", repositoryFullName: "team/apps" };
const selection: CompiledOperatorReleaseSelection = {
  version: 1,
  appId: "requests",
  appSpecDigest: "a".repeat(64),
  artifactRef: `_protected-operator/artifacts/generated-release/requests/${"b".repeat(64)}`,
  manifestSha256: "c".repeat(64),
  releaseId: "requests-v1",
  schemaSha256: "d".repeat(64),
  publishedSource: {
    branch: "builder/requests",
    changeSetDigest: "e".repeat(64),
    gitSha: "f".repeat(40),
    gitTree: "a".repeat(40),
    repositoryId: "123",
    reviewDigest: "b".repeat(64),
  },
};
const source: RepositoryAccessReceipt = {
  version: 1,
  confirmedByCallId: "acquisition",
  providerAccessDigest: "1".repeat(64),
  digest: "2".repeat(64),
  sessionId: "original-adapter",
  repository: {
    repositoryId: "123",
    owner: "team",
    name: "apps",
    defaultBranch: "main",
    headSha: "3".repeat(40),
    headTree: "4".repeat(40),
  },
  scope: { accountLogin: "team", accountType: "Organization", installationId: "456" },
};
const input = () => ({
  workspaceId: "workspace",
  appId: "requests",
  appSpecDigest: selection.appSpecDigest,
  selection: structuredClone(selection),
  repositories: [profile],
});

describe("Production destination authority", () => {
  it("uses the published app's owned release when it was built from a fresh template", () => {
    const request = input();
    expect(resolveRepositoryProductionDestination(request)).toEqual({
      profile,
      sourceSha: selection.publishedSource?.gitSha,
    });
    expect(request).not.toHaveProperty("source");
  });
  it("resolves a fresh frontend-only app from its owned publication without a SQL selection", () => {
    const { publishedSource } = selection;
    if (publishedSource === undefined) {
      throw new Error("fixture publication missing");
    }
    expect(
      resolveRepositoryProductionDestination({
        ...input(),
        // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
        selection: undefined,
        destination: {
          version: 1,
          appId: "requests",
          appSpecDigest: selection.appSpecDigest,
          publishedSource,
        },
      }),
    ).toEqual({ profile, sourceSha: publishedSource.gitSha });
  });
  it("rejects a foreign generic destination and contradictory publication evidence", () => {
    const { publishedSource } = selection;
    if (publishedSource === undefined) {
      throw new Error("fixture publication missing");
    }
    const destination = {
      version: 1 as const,
      appId: "requests",
      appSpecDigest: selection.appSpecDigest,
      publishedSource,
    };
    expect(() =>
      resolveRepositoryProductionDestination({
        ...input(),
        destination: { ...destination, appId: "foreign-app" },
      }),
    ).toThrow("repository_production_capture_unavailable");
    expect(() =>
      resolveRepositoryProductionDestination({
        ...input(),
        destination: { ...destination, appSpecDigest: "9".repeat(64) },
      }),
    ).toThrow("repository_production_capture_unavailable");
    expect(() =>
      resolveRepositoryProductionDestination({
        ...input(),
        destination: {
          ...destination,
          publishedSource: { ...publishedSource, repositoryId: "999" },
        },
      }),
    ).toThrow("repository_production_scope_denied");
  });
  it("retains acquired-repository setup, including frontend-only apps with no SQL selection", () => {
    expect(
      // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
      resolveRepositoryProductionDestination({ ...input(), selection: undefined, source }),
    ).toEqual({
      profile,
      sourceSha: source.repository.headSha,
    });
  });
  it("uses the actual published revision while keeping an acquired repository unchanged", () => {
    const retained = structuredClone(source);
    expect(resolveRepositoryProductionDestination({ ...input(), source }).sourceSha).toBe(
      selection.publishedSource?.gitSha,
    );
    expect(source).toEqual(retained);
  });
  it("does not turn a configured repository into an app's delivery authority", () => {
    expect(() =>
      // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
      resolveRepositoryProductionDestination({ ...input(), selection: undefined }),
    ).toThrow(RepositoryProductionDestinationRequiredError);
    const unpublished = input();
    delete unpublished.selection.publishedSource;
    expect(() => resolveRepositoryProductionDestination(unpublished)).toThrow(
      RepositoryProductionDestinationRequiredError,
    );
  });
  it.each([{ appId: "other-app" }, { appSpecDigest: "9".repeat(64) }])(
    "rejects a marker for another app or accepted specification: %j",
    (mismatch) => {
      const request = input();
      Object.assign(request.selection, mismatch);
      expect(() => resolveRepositoryProductionDestination(request)).toThrow(
        "repository_production_capture_unavailable",
      );
    },
  );
  it("rejects a published destination that differs from the acquired repository", () => {
    const request = input();
    if (request.selection.publishedSource === undefined) {
      throw new Error("The fixture must retain its publication marker.");
    }
    request.selection.publishedSource.repositoryId = "999";
    expect(() => resolveRepositoryProductionDestination({ ...request, source })).toThrow(
      "repository_production_scope_denied",
    );
  });
  it.each([
    { repositories: [{ ...profile, workspaceId: "other-workspace" }] },
    { repositories: [{ ...profile, repositoryId: "999" }] },
    { repositories: [profile, { ...profile, repositoryFullName: "team/other" }] },
  ])("rejects foreign, mismatched, or ambiguous configured destinations", ({ repositories }) => {
    expect(() => resolveRepositoryProductionDestination({ ...input(), repositories })).toThrow(
      "repository_production_scope_denied",
    );
  });
  it("keeps the acquired repository name binding when both authorities are present", () => {
    expect(() =>
      resolveRepositoryProductionDestination({
        ...input(),
        source,
        repositories: [{ ...profile, repositoryFullName: "team/wrong-name" }],
      }),
    ).toThrow("repository_production_scope_denied");
  });
});

it("retains the selected existing repository when resolving a fresh app's published release", () => {
  const repositoryDestination = {
    kind: "existing-repository" as const,
    version: 1 as const,
    appId: "requests",
    repository: { repositoryId: "123", owner: "team", name: "apps", defaultBranch: "main" },
    installationId: "456",
    confirmedByCallId: "selected",
  };
  expect(resolveRepositoryProductionDestination({ ...input(), repositoryDestination })).toEqual({
    profile,
    sourceSha: selection.publishedSource?.gitSha,
  });
  expect(() =>
    resolveRepositoryProductionDestination({
      ...input(),
      repositoryDestination: {
        ...repositoryDestination,
        repository: { ...repositoryDestination.repository, repositoryId: "999" },
      },
    }),
  ).toThrow("scope_denied");
  expect(() =>
    resolveRepositoryProductionDestination({
      ...input(),
      repositoryDestination: { ...repositoryDestination, appId: "foreign" },
    }),
  ).toThrow("scope_denied");
});
