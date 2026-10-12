/* oxlint-disable eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Deferred barriers intentionally release one complete wave at a time. */
import {
  readExactCompiledOperatorRelease,
  selectExactCompiledOperatorRelease,
} from "./hosted-operator-artifact-selection";
import type { OperatorArtifactSelections } from "./hosted-operator-artifact-selection";
/* oxlint-disable unicorn/no-await-expression-member -- Concise assertions inspect the returned private release snapshots. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { createOperatorArtifactPublication } from "./hosted-operator-artifacts";
import type { OperatorArtifactPublicationDiagnostic } from "./hosted-operator-artifacts";
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
    assertCurrentOwner,
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
    store,
  };
};
describe("immutable private operator artifacts", () => {
  it("returns every actual predecessor member by recorded reference after source overwrite", async () => {
    const f = fixture();
    const oldBytes = Buffer.from(f.files["sql-bundle.sql"]);
    const old = await f.publication.publishGeneratedRelease({
      context,
      description,
      source: f.source,
    });
    f.files["sql-bundle.sql"] = Buffer.from("select 2;");
    const next = await f.publication.publishGeneratedRelease({
      context,
      description,
      source: f.source,
    });
    const original = {
      ...old,
      appId: "spend-review",
      appSpecDigest: "a".repeat(64),
      version: 1 as const,
    };
    const current = {
      ...next,
      appId: "spend-review",
      appSpecDigest: "b".repeat(64),
      version: 1 as const,
    };
    const selections: OperatorArtifactSelections = {
      read: async () => await Promise.resolve(current),
      readExact: async (_context, lookup) =>
        await Promise.resolve(selectExactCompiledOperatorRelease([current, original], lookup)),
      record: async (_context, _callId, selection) => await Promise.resolve(selection),
    };
    const input = {
      assertCurrentOwner: f.assertCurrentOwner,
      context,
      lookup: { artifactRef: original.artifactRef },
      selections,
      store: f.store,
    };
    const captured = await readExactCompiledOperatorRelease(input);
    expect(captured?.selection).toEqual(original);
    expect(Object.keys(captured?.files ?? {})).toEqual([...GENERATED_RELEASE_MEMBERS]);
    expect(captured?.files["sql-bundle.sql"]).toEqual(oldBytes);
    await expect(
      readExactCompiledOperatorRelease({
        ...input,
        context: { ...context, target: { ...context.target, sessionId: "other-session" } },
      }),
    ).rejects.toThrow();
    f.revoke();
    await expect(readExactCompiledOperatorRelease(input)).rejects.toThrow();
  });
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

const deferred = () => Promise.withResolvers<null>();
const metadataSchema = z.object({ chunkCount: z.number().int().positive() });
const multiwaveFixture = async () => {
  const f = fixture();
  f.files["sql-bundle.sql"] = Buffer.from("select 1;\n".repeat(60_000));
  const expected = await f.publication.publishGeneratedRelease({
    context,
    description,
    source: f.source,
  });
  const metadata = metadataSchema.parse(
    JSON.parse(f.rows.get(f.key(context, expected.artifactRef, 0)) ?? "{}"),
  );
  return { ...f, chunkCount: metadata.chunkCount, expected };
};

describe("drained artifact data waves", () => {
  it("bounds multiwave writes and reads to four, joins out-of-order bytes canonically, and commits completion last", async () => {
    const f = await multiwaveFixture();
    const expectedRows = new Map(f.rows);
    f.rows.clear();
    const started = Array.from({ length: f.chunkCount + 1 }, deferred);
    const release = Array.from({ length: f.chunkCount + 1 }, deferred);
    const postOwner = Array.from({ length: f.chunkCount + 1 }, deferred);
    const postRelease = Array.from({ length: f.chunkCount + 1 }, deferred);
    let active = 0;
    let maxActive = 0;
    let ownerCalls = 0;
    const putStarted: number[] = [];
    const publication = createOperatorArtifactPublication({
      assertCurrentOwner: async () => {
        await f.assertCurrentOwner();
        ownerCalls += 1;
        // Source capture is serial; after the four pre-owner calls the first wave waits on store barriers.
        const postIndex = ownerCalls - GENERATED_RELEASE_MEMBERS.length - 4;
        if (postIndex >= 1 && postIndex <= 4) {
          postOwner[postIndex]?.resolve(null);
          await postRelease[postIndex]?.promise;
        }
      },
      store: {
        put: async (c, chunk) => {
          putStarted.push(chunk.chunkIndex);
          if (chunk.chunkIndex > 0) {
            active += 1;
            maxActive = Math.max(maxActive, active);
            started[chunk.chunkIndex]?.resolve(null);
            await release[chunk.chunkIndex]?.promise;
            await f.store.put(c, chunk);
            active -= 1;
          } else {
            expect(active).toBe(0);
            expect(putStarted.slice(0, -1)).toHaveLength(f.chunkCount);
            await f.store.put(c, chunk);
          }
        },
        read: f.store.read,
      },
    });
    const pending = publication.publishGeneratedRelease({ context, description, source: f.source });
    await started[4]?.promise;
    expect(putStarted).toEqual([1, 2, 3, 4]);
    for (let index = 4; index >= 1; index -= 1) {
      release[index]?.resolve(null);
    }
    await postOwner[4]?.promise;
    expect(putStarted).toEqual([1, 2, 3, 4]);
    for (let index = 1; index <= 4; index += 1) {
      postRelease[index]?.resolve(null);
    }
    for (let start = 5; start <= f.chunkCount; start += 4) {
      const end = Math.min(start + 3, f.chunkCount);
      await started[end]?.promise;
      expect(putStarted.at(-1)).toBe(end);
      for (let index = end; index >= start; index -= 1) {
        release[index]?.resolve(null);
      }
    }
    expect(await pending).toEqual(f.expected);
    expect(maxActive).toBe(4);
    expect(putStarted.at(-1)).toBe(0);
    expect(f.rows).toEqual(expectedRows);

    const readStarted = Array.from({ length: f.chunkCount + 1 }, deferred);
    const readRelease = Array.from({ length: f.chunkCount + 1 }, deferred);
    const indexes: number[] = [];
    let reading = 0;
    let maxReading = 0;
    const reader = createOperatorArtifactPublication({
      assertCurrentOwner: f.assertCurrentOwner,
      store: {
        put: f.store.put,
        read: async (c, ref, index) => {
          indexes.push(index);
          if (index > 0) {
            reading += 1;
            maxReading = Math.max(maxReading, reading);
            readStarted[index]?.resolve(null);
            await readRelease[index]?.promise;
          }
          const chunk = await f.store.read(c, ref, index);
          if (index > 0) {
            reading -= 1;
          }
          return chunk;
        },
      },
    });
    const read = reader.readGeneratedRelease(context, f.expected);
    for (let start = 1; start <= f.chunkCount; start += 4) {
      const end = Math.min(start + 3, f.chunkCount);
      await readStarted[end]?.promise;
      for (let index = end; index >= start; index -= 1) {
        readRelease[index]?.resolve(null);
      }
    }
    expect((await read).files).toEqual(f.files);
    expect(indexes[0]).toBe(0);
    expect(maxReading).toBe(4);
  });

  it.each(["failure", "abort"])(
    "drains an already admitted %s wave before rejection without a next wave or marker",
    async (mode) => {
      const f = await multiwaveFixture();
      f.rows.clear();
      const abort = new AbortController();
      const started = Array.from({ length: 5 }, deferred);
      const release = Array.from({ length: 5 }, deferred);
      const indexes: number[] = [];
      let postChecks = 0;
      const publication = createOperatorArtifactPublication({
        assertCurrentOwner: async () => {
          await f.assertCurrentOwner();
          postChecks += 1;
        },
        signal: abort.signal,
        store: {
          put: async (c, chunk) => {
            indexes.push(chunk.chunkIndex);
            started[chunk.chunkIndex]?.resolve(null);
            await release[chunk.chunkIndex]?.promise;
            if (chunk.chunkIndex === 1 && mode === "failure") {
              throw new Error("failed put");
            }
            await f.store.put(c, chunk);
          },
          read: f.store.read,
        },
      });
      const pending = publication.publishGeneratedRelease({
        context,
        description,
        source: f.source,
      });
      const rejected = expect(pending).rejects.toThrow();
      let settled = false;
      void (async () => {
        try {
          await pending;
        } catch {
          // Expected negative publication/readback.
        }
        settled = true;
      })();
      await started[4]?.promise;
      if (mode === "abort") {
        abort.abort();
      }
      release[1]?.resolve(null);
      // Other admitted puts remain pending even after failure/abort has been observed.
      await vi.waitFor(() => {
        expect(mode === "abort" ? postChecks : settled).toBe(
          mode === "abort" ? GENERATED_RELEASE_MEMBERS.length + 5 : false,
        );
      });
      expect(settled).toBe(false);
      for (let index = 2; index <= 4; index += 1) {
        release[index]?.resolve(null);
      }
      await rejected;
      expect(indexes).toEqual([1, 2, 3, 4]);
      expect(postChecks).toBe(GENERATED_RELEASE_MEMBERS.length + 4 + (mode === "abort" ? 4 : 3));
      expect([...f.rows.keys()].some((key) => key.endsWith(",0]"))).toBe(false);
    },
  );

  it.each(["failure", "abort"])(
    "blocks store admission after a pending pre-owner assertion on %s",
    async (mode) => {
      const f = fixture();
      const abort = new AbortController();
      const waiting = deferred();
      const release = deferred();
      let checks = 0;
      const indexes: number[] = [];
      const failed = deferred();
      const publication = createOperatorArtifactPublication({
        assertCurrentOwner: async () => {
          checks += 1;
          if (checks > GENERATED_RELEASE_MEMBERS.length) {
            if (checks === GENERATED_RELEASE_MEMBERS.length + 1) {
              await failed.promise;
              throw new Error("revoked owner");
            }
            waiting.resolve(null);
            await release.promise;
          }
        },
        signal: abort.signal,
        store: {
          put: async (_c, chunk) => {
            indexes.push(chunk.chunkIndex);
            await Promise.resolve();
          },
          read: f.store.read,
        },
      });
      const pending = publication.publishGeneratedRelease({
        context,
        description,
        source: f.source,
      });
      const rejected = expect(pending).rejects.toThrow();
      await waiting.promise;
      if (mode === "abort") {
        abort.abort();
      }
      failed.resolve(null);
      await vi.waitFor(() => {
        expect(checks).toBeGreaterThan(GENERATED_RELEASE_MEMBERS.length + 1);
      });
      // Let the failing callback latch its error before releasing a peer's authority lookup.
      await Promise.resolve();
      await Promise.resolve();
      release.resolve(null);
      await rejected;
      expect(indexes).toEqual([]);
    },
  );

  it("does no source, owner, or storage work when pre-aborted", async () => {
    const f = fixture();
    const abort = new AbortController();
    abort.abort();
    const owner = vi.fn(f.assertCurrentOwner);
    const publication = createOperatorArtifactPublication({
      assertCurrentOwner: owner,
      signal: abort.signal,
      store: f.store,
    });
    await expect(
      publication.publishGeneratedRelease({ context, description, source: f.source }),
    ).rejects.toThrow();
    await expect(
      publication.readGeneratedRelease(context, {
        artifactRef: "unused",
        manifestSha256: schemaHash,
        releaseId: "unused",
        schemaSha256: schemaHash,
      }),
    ).rejects.toThrow();
    expect(owner).not.toHaveBeenCalled();
    expect(f.paths).toEqual([]);
    expect(f.rows.size).toBe(0);
  });

  it.each(["missing", "corrupt", "abort"])(
    "drains a %s read wave before returning an integrity error",
    async (mode) => {
      const f = await multiwaveFixture();
      const abort = new AbortController();
      const started = Array.from({ length: 5 }, deferred);
      const release = Array.from({ length: 5 }, deferred);
      const indexes: number[] = [];
      const publication = createOperatorArtifactPublication({
        assertCurrentOwner: f.assertCurrentOwner,
        signal: abort.signal,
        store: {
          put: f.store.put,
          read: async (c, ref, index) => {
            indexes.push(index);
            if (index > 0 && index <= 4) {
              started[index]?.resolve(null);
              await release[index]?.promise;
            }
            if (index === 1 && mode !== "abort") {
              return mode === "missing" ? undefined : "corrupt";
            }
            return await f.store.read(c, ref, index);
          },
        },
      });
      const pending = publication.readGeneratedRelease(context, f.expected);
      const rejected = expect(pending).rejects.toThrow();
      let settled = false;
      void (async () => {
        try {
          await pending;
        } catch {
          // Expected negative publication/readback.
        }
        settled = true;
      })();
      await started[4]?.promise;
      if (mode === "abort") {
        abort.abort();
      }
      release[1]?.resolve(null);
      await Promise.resolve();
      expect(settled).toBe(false);
      for (let index = 2; index <= 4; index += 1) {
        release[index]?.resolve(null);
      }
      await rejected;
      if (mode !== "corrupt") {
        expect(indexes).toEqual([0, 1, 2, 3, 4]);
      }
      expect(settled).toBe(true);
    },
  );

  it("retains a committed marker and drains its post-owner check on cancellation", async () => {
    const f = fixture();
    const abort = new AbortController();
    let postMarkerOwner = false;
    let markerWritten = false;
    const publication = createOperatorArtifactPublication({
      assertCurrentOwner: async () => {
        await f.assertCurrentOwner();
        if (markerWritten) {
          postMarkerOwner = true;
        }
      },
      signal: abort.signal,
      store: {
        put: async (c, chunk) => {
          await f.store.put(c, chunk);
          if (chunk.chunkIndex === 0) {
            markerWritten = true;
            abort.abort();
          }
        },
        read: f.store.read,
      },
    });
    await expect(
      publication.publishGeneratedRelease({ context, description, source: f.source }),
    ).rejects.toThrow();
    expect(markerWritten).toBe(true);
    expect(postMarkerOwner).toBe(true);
    const retry = await f.publication.publishGeneratedRelease({
      context,
      description,
      source: f.source,
    });
    expect((await f.publication.readGeneratedRelease(context, retry)).files).toEqual(f.files);
  });

  it("preserves identical concurrent first-writer bytes and exact retries", async () => {
    const f = fixture();
    const results = await Promise.all([
      f.publication.publishGeneratedRelease({ context, description, source: f.source }),
      f.publication.publishGeneratedRelease({ context, description, source: f.source }),
    ]);
    expect(results[0]).toEqual(results[1]);
    const rows = new Map(f.rows);
    expect(
      await f.publication.publishGeneratedRelease({ context, description, source: f.source }),
    ).toEqual(results[0]);
    expect(f.rows).toEqual(rows);
  });

  it("continues publication and readback while an observer remains pending", async () => {
    const f = fixture();
    const observed = deferred();
    const publication = createOperatorArtifactPublication({
      assertCurrentOwner: f.assertCurrentOwner,
      observe: async () => {
        await observed.promise;
      },
      store: f.store,
    });
    try {
      const captured = await publication.publishGeneratedRelease({
        context,
        description,
        source: f.source,
      });
      expect((await publication.readGeneratedRelease(context, captured)).files).toEqual(f.files);
    } finally {
      observed.resolve(null);
    }
  });
  it("ignores throwing and asynchronously rejecting observers while reporting bounded safe fields", async () => {
    const f = fixture();
    const diagnostics: OperatorArtifactPublicationDiagnostic[] = [];
    for (const asynchronous of [false, true]) {
      const publication = createOperatorArtifactPublication({
        assertCurrentOwner: f.assertCurrentOwner,
        observe: asynchronous
          ? async (event) => {
              diagnostics.push(event);
              await Promise.resolve();
              throw new Error("private observer error");
            }
          : (event) => {
              diagnostics.push(event);
              throw new Error("private observer error");
            },
        store: f.store,
      });
      const captured = await publication.publishGeneratedRelease({
        context,
        description,
        source: f.source,
      });
      expect((await publication.readGeneratedRelease(context, captured)).files).toEqual(f.files);
    }
    for (const event of diagnostics) {
      expect(
        Object.keys(event).every((key) =>
          ["stage", "outcome", "member", "bytes", "chunkTotal", "chunkCompleted"].includes(key),
        ),
      ).toBe(true);
      if (event.member !== undefined) {
        expect(GENERATED_RELEASE_MEMBERS).toContain(event.member);
      }
    }
    expect(JSON.stringify(diagnostics)).not.toContain("private observer error");
    const publicationEvents = diagnostics.filter((event) => event.stage === "publication");
    const first = [...f.rows.values()].find((value) => value.startsWith('{"chunkCount"'));
    const { chunkCount: count } = metadataSchema.parse(JSON.parse(first ?? "{}"));
    expect(publicationEvents).toHaveLength(2 * 2 * Math.ceil(count / 4));
  });
});
