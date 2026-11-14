import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ARRUSTED_PRODUCTION_REPOSITORY } from "../agent/direct-production-authorization";
import { approvedBuildDecisionSchema } from "../agent/approved-build-continuation";
import type { ApprovedBuildDecision } from "../agent/approved-build-continuation";
import {
  initialRepositoryProductionRecord,
  repositoryProductionOperationRef,
} from "./repository-production-contract";
import type {
  RepositoryProductionRow,
  RepositoryProductionScope,
} from "./repository-production-contract";
import type { GeneratedAppReleaseFiles } from "./hosted-operator-sandbox-launcher";
import {
  assertRepositoryProductionSchemaPredecessorSource,
  readInstalledRepositoryProductionSchemaPredecessor,
  readRepositoryProductionSchemaPredecessorAuthority,
} from "./repository-production-schema-predecessor";
import type { OperatorOwnerContext } from "./hosted-operator-contract";

const appId = "bench-log";
const releaseId = "release-1";
const artifactKey = "app-artifact.json";
const manifestKey = "release-manifest.json";
const artifactBytes = Buffer.from(
  JSON.stringify({ schema: { app_id: appId, version: releaseId } }),
);
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const cueSha256 = sha256(Buffer.from("app: bench-log"));
const scope: RepositoryProductionScope = {
  authority: {
    issuer: "https://builder.test/api/auth",
    audience: "https://builder.test/mcp",
    ownerUserId: "owner",
    workspaceId: "workspace",
  },
  appId,
  repositoryId: "123",
  repositoryFullName: "example/repo",
  organizationId: "org",
  projectId: "project",
  publicOrigin: "https://apps.test",
  environment: "production",
};

const release = (sourceApp = appId): GeneratedAppReleaseFiles => ({
  [artifactKey]: artifactBytes,
  "cue-to-sql-source-map.json": Buffer.from("{}"),
  "data-operations.md": Buffer.from(""),
  "data-operations.ts": Buffer.from(""),
  "data-server.ts": Buffer.from(""),
  "operation-manifest.json": Buffer.from("{}"),
  [manifestKey]: Buffer.from(
    JSON.stringify({
      app: appId,
      schema_version: releaseId,
      hashes: { schema: `sha256:${sha256(artifactBytes)}` },
      sources: { [`apps/${sourceApp}/schema/${sourceApp}.cue`]: `sha256:${cueSha256}` },
    }),
  ),
  "runtime-coverage.json": Buffer.from("{}"),
  "sql-bundle.sql": Buffer.from("checked SQL"),
  "sql-manifest.json": Buffer.from("{}"),
  "transition-contract.json": Buffer.from("{}"),
  "transition-plan.json": Buffer.from("{}"),
});

const followerUnavailable = "owner changed";
type Ports = Parameters<typeof readInstalledRepositoryProductionSchemaPredecessor>[0];
const currentAuthority = async () => {
  await Promise.resolve();
};
const fixture = (files = release()) => {
  const record = initialRepositoryProductionRecord(scope, {
    sessionId: "session",
    sourceSha: "e".repeat(40),
    creatorRoles: [],
    storage: {
      kind: "postgres",
      artifactRef: "archive",
      manifestSha256: sha256(files[manifestKey]),
      releaseId,
      databaseEnvironment: "APP_DATABASE_URL",
    },
  });
  record.lease = { leaseId: "11111111-1111-4111-a111-111111111111", fenceGeneration: 1 };
  for (const effect of Object.values(record.effects)) {
    effect.state = "applied";
  }
  const row: RepositoryProductionRow = {
    record,
    operationRef: repositoryProductionOperationRef(scope),
    revision: 6,
  };
  const assertCurrent = vi.fn<Ports["assertCurrent"]>().mockImplementation(currentAuthority);
  const readRelease = vi.fn<Ports["readRelease"]>().mockResolvedValue(files);
  const inspect = vi.fn<Ports["inspect"]>().mockResolvedValue({
    state: "applied",
    receipt: { projection: "not returned" },
  });
  return { row, assertCurrent, readRelease, inspect };
};

describe("installed Production schema predecessor", () => {
  it("reports only the digest of the app's own checked source and active installed release", async () => {
    const ports = fixture();
    const result = await readInstalledRepositoryProductionSchemaPredecessor(ports);
    expect(ports.inspect).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        row: ports.row,
        effect: "install-schema",
        assertCurrent: ports.assertCurrent,
      }),
    );
    const [[context]] = ports.inspect.mock.calls;
    const attemptCheckpoint = async () => {
      await context.checkpoint({ write: "forbidden" });
    };
    await expect(attemptCheckpoint()).rejects.toThrow(
      "repository_production_schema_predecessor_unavailable",
    );
    expect(result).toEqual({
      version: 1,
      appId,
      repositoryId: scope.repositoryId,
      releaseId,
      artifactSha256: sha256(artifactBytes),
      manifestSha256: sha256(release()[manifestKey]),
      cueSha256,
    });
  });

  it("refuses uninstalled or unavailable readback and concurrent authority changes", async () => {
    const ports = fixture();
    ports.inspect.mockResolvedValueOnce({ state: "not-applied" });
    await expect(readInstalledRepositoryProductionSchemaPredecessor(ports)).rejects.toThrow();
    ports.inspect.mockResolvedValueOnce({ state: "unknown" });
    await expect(readInstalledRepositoryProductionSchemaPredecessor(ports)).rejects.toThrow();
    ports.assertCurrent
      .mockImplementationOnce(currentAuthority)
      .mockImplementationOnce(currentAuthority);
    ports.assertCurrent.mockRejectedValueOnce(new Error(followerUnavailable));
    await expect(readInstalledRepositoryProductionSchemaPredecessor(ports)).rejects.toThrow(
      followerUnavailable,
    );
  });

  it("refuses pending setup, an unrelated CUE file, or mismatched archived artifact bytes before worker access", async () => {
    const pending = fixture();
    pending.row.record.effects["install-schema"].state = "pending";
    const otherAppCue = fixture(release("other-app"));
    const wrongArtifact = fixture({ ...release(), [artifactKey]: Buffer.from("{}") });
    for (const ports of [pending, otherAppCue, wrongArtifact]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each independent fixture verifies its own worker was untouched.
      await expect(readInstalledRepositoryProductionSchemaPredecessor(ports)).rejects.toThrow();
      expect(ports.inspect).not.toHaveBeenCalled();
    }
    expect(pending.readRelease).not.toHaveBeenCalled();
  });
});

const readAuthorityFixture = () => {
  const logicalSessionId = "logical-owner";
  const owner: OperatorOwnerContext = {
    kind: "direct",
    authority: scope.authority,
    principal: { ...scope.authority, scopes: ["autograph:send"] },
    sessionId: "saved-session",
    adapterSessionId: "current-worker",
    adapterGeneration: 2,
  };
  const { repositoryId } = scope;
  const installationId = "456";
  const baseBranch = "main";
  const appSpecDigest = "1".repeat(64);
  const reviewDigest = "7".repeat(64);
  const decision: ApprovedBuildDecision = {
    version: 1,
    adapterSessionId: owner.adapterSessionId,
    turnId: "correction",
    turnSequence: 2,
    decision: "blocked",
    workflowPhase: "reviewed",
    currentSpec: {
      appId,
      appSpecDigest,
      proposalDigest: "2".repeat(64),
      sessionId: logicalSessionId,
      workspaceId: "private-workspace",
    },
    githubDelivery: {
      version: 1,
      requirements: [],
      calls: [],
      current: {
        appId,
        appSpecDigest,
        proposalDigest: "8".repeat(64),
        reviewDigest,
        installationId,
      },
    },
  };
  const [repoOwner, repoName] = ARRUSTED_PRODUCTION_REPOSITORY.split("/");
  const published = {
    repositoryId,
    branch: "published-draft",
    gitSha: "a".repeat(40),
    gitTree: "b".repeat(40),
    changeSetDigest: "9".repeat(64),
    reviewDigest,
  };
  return {
    input: {
      decision: approvedBuildDecisionSchema.parse(decision),
      destination: {
        version: 1 as const,
        kind: "existing-repository" as const,
        confirmedByCallId: "select",
        appId,
        installationId,
        repository: {
          repositoryId,
          owner: repoOwner,
          name: repoName,
          defaultBranch: baseBranch,
        },
      },
      owner,
      logicalSessionId,
      appId,
      repositoryId,
    },
    published,
    target: { expectedRepositoryId: repositoryId, reviewedHeadSha: published.gitSha },
  };
};

describe("published draft readback authority", () => {
  it("uses the owner-reviewed publication without requiring permission to correct it", () => {
    const { input, target, published } = readAuthorityFixture();
    const authority = readRepositoryProductionSchemaPredecessorAuthority(input);
    expect(authority.repositoryFullName).toBe(ARRUSTED_PRODUCTION_REPOSITORY);
    expect(input.decision.directProduction).toBeUndefined();
    expect(assertRepositoryProductionSchemaPredecessorSource(authority, published, target)).toEqual(
      published,
    );
    expect(() =>
      assertRepositoryProductionSchemaPredecessorSource(
        authority,
        { ...published, gitSha: "f".repeat(40) },
        target,
      ),
    ).toThrow();
    expect(() =>
      assertRepositoryProductionSchemaPredecessorSource(
        authority,
        { ...published, reviewDigest: "d".repeat(64) },
        target,
      ),
    ).toThrow();
  });

  it("rejects a changed physical owner, repository, logical session, or installation", () => {
    const { input } = readAuthorityFixture();
    const changes = [
      {
        ...input,
        owner: { ...input.owner, adapterSessionId: "another-worker" },
      },
      { ...input, repositoryId: "999" },
      { ...input, logicalSessionId: "other-session" },
      { ...input, destination: { ...input.destination, installationId: "999" } },
      { ...input, decision: { ...input.decision, workflowPhase: "planned" } },
    ];
    for (const changed of changes) {
      expect(() => readRepositoryProductionSchemaPredecessorAuthority(changed)).toThrow();
    }
  });

  it("accepts a retained published reconciliation only with its exact review and tree", () => {
    const { input, published, target } = readAuthorityFixture();
    const reconciliationDigest = "3".repeat(64);
    const reconciled = {
      digest: reconciliationDigest,
      reconciliationReviewDigest: "4".repeat(64),
      reconciliationTree: "5".repeat(40),
    };
    const { githubDelivery } = input.decision;
    if (githubDelivery === undefined || githubDelivery.current === null) {
      throw new Error("Expected an existing reviewed draft fixture.");
    }
    const current = { ...githubDelivery.current, reconciliationDigest };
    const partial = {
      ...input.decision,
      workflowPhase: "validated",
      githubDelivery: { ...githubDelivery, current },
    };
    expect(() =>
      readRepositoryProductionSchemaPredecessorAuthority({ ...input, decision: partial }),
    ).toThrow();
    const decision = {
      ...partial,
      githubDelivery: { ...githubDelivery, current, publishedReconciliation: reconciled },
    };
    const authority = readRepositoryProductionSchemaPredecessorAuthority({ ...input, decision });
    expect(() =>
      assertRepositoryProductionSchemaPredecessorSource(authority, published, target),
    ).toThrow();
    const result = {
      ...published,
      reviewDigest: reconciled.reconciliationReviewDigest,
      gitTree: reconciled.reconciliationTree,
    };
    expect(assertRepositoryProductionSchemaPredecessorSource(authority, result, target)).toEqual(
      result,
    );
  });
});
