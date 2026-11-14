import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  initialRepositoryProductionRecord,
  repositoryProductionOperationRef,
} from "./repository-production-contract";
import type {
  RepositoryProductionRow,
  RepositoryProductionScope,
} from "./repository-production-contract";
import type { GeneratedAppReleaseFiles } from "./hosted-operator-sandbox-launcher";
import { readInstalledRepositoryProductionSchemaPredecessor } from "./repository-production-schema-predecessor";

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
