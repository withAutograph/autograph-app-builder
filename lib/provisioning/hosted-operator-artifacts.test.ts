/* oxlint-disable unicorn/no-await-expression-member -- Concise assertions inspect the returned private release snapshots. */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOperatorArtifactPublication } from "./hosted-operator-artifacts";
import type {
  OperatorArtifactContext,
  OperatorArtifactStore,
} from "./hosted-operator-artifact-store";
import { GENERATED_RELEASE_MEMBERS } from "./hosted-operator-sandbox-launcher";
import type { HostedOperatorContext } from "./hosted-operator-service";
import type { AppDescription } from "../repository/app-description";
import { getPrototypeChunk } from "../agent/postgres-prototype-chunks";

const context: HostedOperatorContext = {
  authority: {
    audience: "https://builder.example/mcp",
    issuer: "https://builder.example/api/auth",
    ownerUserId: "owner",
    workspaceId: "workspace",
  },
  target: {
    appId: "spend-review",
    branch: "preview",
    environment: "preview",
    installationId: "owner-installation",
    projectId: "app-project",
    scopeId: "team",
    scopeType: "team",
    sessionId: "original-session",
  },
};
const schemaHash = "a".repeat(64);
const description: AppDescription = {
  app: { id: "spend-review", routes: ["/spend-review"], workspacePath: "apps/spend-review" },
  backend: {
    authorization: "declared-policy",
    kind: "generated-postgres",
    release: {
      artifactHash: `sha256:${schemaHash}`,
      directory: "apps/spend-review/schema/release/historical-v12",
      id: "historical-v12",
    },
    roles: ["reviewer"],
    runtime: { databaseEnvironment: "SPEND_REVIEW_DATABASE_URL" },
    schemaReceipt: null,
  },
  validation: {
    browser: null,
    check: { task: "mise run app:check spend-review" },
    test: { shards: 1, task: "mise run app:test spend-review 0" },
  },
  version: 1,
};
const fixture = () => {
  let currentOwner = true;
  let writes = 0;
  let interruptAt = Infinity;
  const rows = new Map<string, string>();
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Faithful store fixtures own their row-key construction.
  const key = (c: OperatorArtifactContext, ref: string, index: number) =>
    JSON.stringify([c.authority, c.target.sessionId, c.target.appId, ref, index]);
  const assertCurrentOwner = async () => {
    if (!currentOwner) {
      throw new Error("owner revoked");
    }
    await Promise.resolve();
  };
  const store: OperatorArtifactStore = {
    put: async (c, chunk) => {
      await assertCurrentOwner();
      writes += 1;
      if (writes === interruptAt) {
        throw new Error("interrupted");
      }
      const k = key(c, chunk.artifactRef, chunk.chunkIndex);
      const existing = rows.get(k);
      if (existing !== undefined && existing !== chunk.content) {
        throw new Error("immutable");
      }
      rows.set(k, chunk.content);
    },
    read: async (c, ref, index) => {
      await assertCurrentOwner();
      return rows.get(key(c, ref, index));
    },
  };
  const files: Record<string, Buffer> = Object.fromEntries(
    GENERATED_RELEASE_MEMBERS.map((name) => {
      let content: string = name;
      if (name === "release-manifest.json") {
        content = JSON.stringify({
          app: "spend-review",
          hashes: { schema: `sha256:${schemaHash}` },
          schema_version: "historical-v12",
        });
      } else if (name === "sql-bundle.sql") {
        content = "select 1;\n".repeat(14_000);
      }
      return [name, Buffer.from(content)];
    }),
  );
  const paths: string[] = [];
  const source = {
    readBinaryFile: async ({ path }: { path: string }) => {
      await assertCurrentOwner();
      paths.push(path);
      const bytes = files[path.split("/").at(-1) ?? ""];
      if (bytes === undefined) {
        throw new Error("missing");
      }
      return Buffer.from(bytes);
    },
  };
  return {
    files,
    interrupt: (at: number) => {
      writes = 0;
      interruptAt = at;
    },
    key,
    paths,
    publication: createOperatorArtifactPublication({ assertCurrentOwner, store }),
    revoke: () => {
      currentOwner = false;
    },
    rows,
    source,
  };
};
describe("immutable private operator artifacts", () => {
  it("captures actual source API fixed members, preserves both schema/manifest hashes and round-trips multi-chunk bytes", async () => {
    const f = fixture();
    const published = await f.publication.publishGeneratedRelease({
      context,
      description,
      source: f.source,
    });
    expect(published.schemaSha256).toBe(schemaHash);
    expect(published.manifestSha256).toBe(
      createHash("sha256").update(f.files["release-manifest.json"]).digest("hex"),
    );
    expect(published.manifestSha256).not.toBe(published.schemaSha256);
    expect(f.paths).toHaveLength(GENERATED_RELEASE_MEMBERS.length);
    expect(
      f.paths.every((path) =>
        path.startsWith("repository/apps/spend-review/schema/release/historical-v12/"),
      ),
    ).toBe(true);
    const read = await f.publication.readGeneratedRelease(context, published);
    expect(read.files).toEqual(f.files);
  });
  it("reuses exact publications and preserves historical bytes when ordinary source produces a new reference", async () => {
    const f = fixture();
    const first = await f.publication.publishGeneratedRelease({
      context,
      description,
      source: f.source,
    });
    expect(
      await f.publication.publishGeneratedRelease({ context, description, source: f.source }),
    ).toEqual(first);
    f.files["sql-bundle.sql"] = Buffer.from("select 2;");
    const next = await f.publication.publishGeneratedRelease({
      context,
      description,
      source: f.source,
    });
    expect(next.artifactRef).not.toBe(first.artifactRef);
    expect(
      (await f.publication.readGeneratedRelease(context, first)).files["sql-bundle.sql"].toString(),
    ).toContain("select 1;");
    expect(
      (await f.publication.readGeneratedRelease(context, next)).files["sql-bundle.sql"].toString(),
    ).toBe("select 2;");
  });
  it.each(["ownerUserId", "workspaceId"])(
    "does not return another owner scope %s",
    async (field) => {
      const f = fixture();
      const published = await f.publication.publishGeneratedRelease({
        context,
        description,
        source: f.source,
      });
      await expect(
        f.publication.readGeneratedRelease(
          { ...context, authority: { ...context.authority, [field]: "other" } },
          published,
        ),
      ).rejects.toThrow();
    },
  );
  it("denies other sessions/app identity and revoked owner on read", async () => {
    const f = fixture();
    const published = await f.publication.publishGeneratedRelease({
      context,
      description,
      source: f.source,
    });
    await expect(
      f.publication.readGeneratedRelease(
        { ...context, target: { ...context.target, sessionId: "replacement-session" } },
        published,
      ),
    ).rejects.toThrow();
    await expect(
      f.publication.readGeneratedRelease(
        { ...context, target: { ...context.target, appId: "other-app" } },
        published,
      ),
    ).rejects.toThrow();
    f.revoke();
    await expect(f.publication.readGeneratedRelease(context, published)).rejects.toThrow();
  });
  it("does not expose interrupted publication and allows an exact retry", async () => {
    const f = fixture();
    f.interrupt(2);
    await expect(
      f.publication.publishGeneratedRelease({ context, description, source: f.source }),
    ).rejects.toThrow();
    expect([...f.rows.keys()].some((key) => key.endsWith(",0]"))).toBe(false);
    f.interrupt(Infinity);
    const published = await f.publication.publishGeneratedRelease({
      context,
      description,
      source: f.source,
    });
    expect((await f.publication.readGeneratedRelease(context, published)).files).toEqual(f.files);
  });
  it("rejects corrupted chunks and wrong frozen release identity", async () => {
    const f = fixture();
    const published = await f.publication.publishGeneratedRelease({
      context,
      description,
      source: f.source,
    });
    await expect(
      f.publication.readGeneratedRelease(context, { ...published, schemaSha256: "b".repeat(64) }),
    ).rejects.toThrow();
    f.rows.set(f.key(context, published.artifactRef, 1), "corrupt");
    await expect(f.publication.readGeneratedRelease(context, published)).rejects.toThrow();
  });
  it("public prototype retrieval rejects the private namespace before accessing storage", async () => {
    const f = fixture();
    const published = await f.publication.publishGeneratedRelease({
      context,
      description,
      source: f.source,
    });
    let accessed = false;
    const publicDatabase = new Proxy(
      {},
      {
        get: () => {
          accessed = true;
          throw new Error("public storage access");
        },
      },
    );
    // SAFETY: Public getPrototypeChunk rejects the namespace before reading any database method; this proxy makes unintended access observable.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Negative public namespace boundary, never used as a functioning database.
    const guardedDatabase = publicDatabase as never;
    await expect(
      getPrototypeChunk(guardedDatabase, {
        chunkIndex: 1,
        path: published.artifactRef,
        principal: { ...context.authority, scopes: ["autograph:get"] },
        sessionId: context.target.sessionId,
        transferDigest: published.artifactRef.split("/").at(-1) ?? "",
      }),
    ).rejects.toThrow("Prototype artifact path is not allowed.");
    expect(accessed).toBe(false);
  });
  it.each([
    "postgresql://owner:private-password@host.neon.tech/db",
    '{"runtimePassword":"private-password"}',
  ])("rejects credential material and never captures runtime/env files", async (secret) => {
    const f = fixture();
    f.files["sql-bundle.sql"] = Buffer.from(secret);
    await expect(
      f.publication.publishGeneratedRelease({ context, description, source: f.source }),
    ).rejects.toThrow();
    expect(f.paths.some((path) => path.includes(".env"))).toBe(false);
    expect(f.rows.size).toBe(0);
  });
  it("publishes and reads exact reviewed Auth plan bytes with separate digests", async () => {
    const f = fixture();
    const content = Buffer.from(
      JSON.stringify({
        resource: { database: "realm", migratorRole: "auth_migrator", runtimeRole: "auth_runtime" },
        schemaPlan: { planDigest: "b".repeat(64), targetDigest: "c".repeat(64) },
      }),
    );
    const expected = { planDigest: "b".repeat(64), targetDigest: "c".repeat(64) };
    const artifactRef = await f.publication.publishAuthPlan({ content, context, ...expected });
    expect(
      (await f.publication.readAuthPlan(context, { artifactRef, ...expected })).content,
    ).toEqual(content);
    await expect(
      f.publication.readAuthPlan(context, {
        artifactRef,
        ...expected,
        targetDigest: "d".repeat(64),
      }),
    ).rejects.toThrow();
  });
});
