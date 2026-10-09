import { createHash } from "node:crypto";

// oxlint-disable typescript/promise-function-async -- In-memory store methods return settled Promises without awaits.

import { describe, expect, it } from "vitest";

import { readValidationLogPage, ValidationLogWriter } from "./validation-log";
import type {
  ValidationLogKey,
  ValidationLogReference,
  ValidationLogStore,
} from "./validation-log";

const digest = (value: string) => createHash("sha256").update(value, "utf-8").digest("hex");
const attemptDigest = "a".repeat(64);

class MemoryLogStore implements ValidationLogStore {
  readonly chunks: Map<string, { content: string; digest: string }>;
  readonly manifests: Map<string, ValidationLogReference>;
  private readonly tenant: string;
  private readonly data: {
    chunks: Map<string, { content: string; digest: string }>;
    manifests: Map<string, ValidationLogReference>;
  };
  failAtChunk?: number;
  failPublish = false;

  constructor(tenant: string, data?: MemoryLogStore["data"]) {
    this.tenant = tenant;
    this.data = data ?? {
      chunks: new Map<string, { content: string; digest: string }>(),
      manifests: new Map<string, ValidationLogReference>(),
    };
    this.chunks = this.data.chunks;
    this.manifests = this.data.manifests;
  }

  forTenant(tenant: string) {
    return new MemoryLogStore(tenant, this.data);
  }
  private prefix(key: ValidationLogKey) {
    return `${this.tenant}:${key.sessionId}:${key.attemptDigest}:${key.command}:${key.channel}:${key.logId}`;
  }
  putChunk(key: ValidationLogKey, index: number, content: string, chunkDigest: string) {
    if (this.failAtChunk === index) {
      throw new Error("database write failed");
    }
    this.chunks.set(`${this.prefix(key)}:${index}`, { content, digest: chunkDigest });
    return Promise.resolve();
  }
  publish(key: ValidationLogKey, reference: ValidationLogReference) {
    if (this.failPublish) {
      throw new Error("manifest write failed");
    }
    this.manifests.set(this.prefix(key), reference);
    return Promise.resolve();
  }
  removeStaged(key: ValidationLogKey) {
    this.manifests.delete(this.prefix(key));
    for (let index = 0; this.chunks.delete(`${this.prefix(key)}:${index}`); index += 1) {
      /* staged chunks */
    }
    return Promise.resolve();
  }
  getReference(key: ValidationLogKey) {
    return Promise.resolve(this.manifests.get(this.prefix(key)));
  }
  getChunk(key: ValidationLogKey, index: number) {
    return Promise.resolve(this.chunks.get(`${this.prefix(key)}:${index}`));
  }
}

const log = (store: ValidationLogStore, sessionId = "session-a") =>
  new ValidationLogWriter(store, {
    attemptDigest,
    channel: "stdout",
    command: "check-build",
    sessionId,
  });

describe("durable validation logs", () => {
  it("keeps late kernel and assertion context after routine output fills the receipt sample", async () => {
    const store = new MemoryLogStore("tenant-a");
    const writer = log(store);
    const routine = "apps/example: checking existing files coût ❄️\n".repeat(1200);
    const failure = [
      "kernel_prepare_schema_revision: unsupported_predecessor",
      "DETAIL: active base not exact compiler-owned transition predecessor",
      "CONTEXT: version 2026-10-08.authenticated-review-v2",
      "HINT: restore the canonical transition predecessor",
      "FAIL apps/example/test/review.test.ts > preserves the current release",
      "AssertionError: expected actual to equal requested",
      "Expected: canonical predecessor",
      "Received: unknown transition",
      "The transition cannot use the active release as its base.",
      "secret=private-value",
      " at apps/example/test/review.test.ts:12:3",
      "",
    ].join("\n");
    await writer.append(routine);
    await writer.append(failure);
    const { excerpt, omitted, reference } = await writer.finish();
    expect(Buffer.byteLength(excerpt, "utf-8")).toBeLessThanOrEqual(32 * 1024);
    expect(excerpt).toContain("unsupported_predecessor");
    expect(excerpt).toContain(
      "DETAIL: active base not exact compiler-owned transition predecessor",
    );
    expect(excerpt).toContain("CONTEXT: version 2026-10-08.authenticated-review-v2");
    expect(excerpt).toContain("Expected: canonical predecessor");
    expect(excerpt).toContain("Received: unknown transition");
    expect(excerpt).toContain("The transition cannot use the active release as its base.");
    expect(excerpt).toContain("secret=[REDACTED]");
    expect(excerpt).not.toContain("private-value");
    expect(omitted).toBe(true);
    let cursor: string | undefined;
    let output = "";
    do {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Read the complete immutable log in cursor order.
      const page = await readValidationLogPage({
        cursor,
        digest: reference.digest,
        key: writer.key,
        store,
      });
      output += page.content;
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(output).toContain(routine);
    expect(output).toContain("unsupported_predecessor");
    expect(output).not.toContain("private-value");
    expect(digest(output)).toBe(reference.digest);
  });

  it("preserves explicit leading excerpt limits", async () => {
    const store = new MemoryLogStore("tenant-a");
    const writer = new ValidationLogWriter(
      store,
      { attemptDigest, channel: "stdout", command: "check-build", sessionId: "session-a" },
      { excerptLimit: 6 },
    );
    await writer.append("ready\nFAIL late failure\nExpected: complete\n");
    const { excerpt, omitted } = await writer.finish();
    expect(excerpt).toBe("ready");
    expect(omitted).toBe(true);
  });

  it("reconstructs Unicode output beyond the old receipt and checkpoint ceilings", async () => {
    const store = new MemoryLogStore("tenant-a");
    const writer = log(store);
    const source = "checking coût ❄️\n".repeat(60_000);
    for (let index = 0; index < source.length; index += 7001) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Simulate sequential Sandbox stream chunks.
      await writer.append(source.slice(index, index + 7001));
    }
    const { reference, omitted } = await writer.finish();
    expect(reference.bytes).toBeGreaterThan(512 * 1024);
    expect(reference.chunkCount).toBeGreaterThan(16);
    expect(omitted).toBe(true);
    let cursor: string | undefined;
    let output = "";
    do {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Cursor pages are sequential.
      const page = await readValidationLogPage({
        cursor,
        digest: reference.digest,
        key: writer.key,
        store,
      });
      output += page.content;
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(output).toBe(source);
    expect(digest(output)).toBe(reference.digest);
  });

  it("redacts a credential split across stream chunks and an unseparated oversized line", async () => {
    const store = new MemoryLogStore("tenant-a");
    const writer = log(store);
    await writer.append("API_KEY=super-");
    await writer.append(`secret\n${"x".repeat(40_000)}`);
    await writer.append("\nall done\n");
    const { reference, omitted } = await writer.finish();
    const first = await readValidationLogPage({ digest: reference.digest, key: writer.key, store });
    expect(first.content).not.toContain("super-secret");
    expect(first.content).toContain("x".repeat(100));
    expect(first.content).toContain("[REDACTED]");
    expect(omitted).toBe(true);
  });

  it("rejects tampered digests, chunks, and stale cursors", async () => {
    const store = new MemoryLogStore("tenant-a");
    const writer = log(store);
    await writer.append("safe output\n");
    const { reference } = await writer.finish();
    await expect(
      readValidationLogPage({ digest: "b".repeat(64), key: writer.key, store }),
    ).rejects.toThrow("unavailable");
    await expect(
      readValidationLogPage({ cursor: "old:1", digest: reference.digest, key: writer.key, store }),
    ).rejects.toThrow("stale");
    const chunk = await store.getChunk(writer.key, 0);
    expect(chunk).toBeDefined();
    if (chunk === undefined) {
      throw new Error("Expected the saved chunk.");
    }
    store.chunks.set(
      `tenant-a:${writer.key.sessionId}:${writer.key.attemptDigest}:${writer.key.command}:${writer.key.channel}:${writer.key.logId}:0`,
      {
        content: "tampered output",
        digest: chunk.digest,
      },
    );
    await expect(
      readValidationLogPage({ digest: reference.digest, key: writer.key, store }),
    ).rejects.toThrow("integrity");
  });

  it("rolls back interrupted and failed writes without publishing a partial log", async () => {
    const store = new MemoryLogStore("tenant-a");
    const interrupted = log(store);
    await interrupted.append("partial\n".repeat(10_000));
    await interrupted.abort();
    expect(await store.getReference(interrupted.key)).toBeUndefined();
    expect(store.chunks.size).toBe(0);

    const failed = log(store);
    store.failPublish = true;
    await failed.append("written before manifest\n".repeat(2000));
    await expect(failed.finish()).rejects.toThrow("manifest write failed");
    await failed.abort();
    expect(store.chunks.size).toBe(0);
    expect(store.manifests.size).toBe(0);
  });

  it("denies another tenant or session and preserves logs through compute cleanup", async () => {
    const store = new MemoryLogStore("tenant-a");
    const writer = log(store);
    await writer.append("durable output\n");
    const { reference } = await writer.finish();
    const otherTenant = store.forTenant("tenant-b");
    await expect(
      readValidationLogPage({ digest: reference.digest, key: writer.key, store: otherTenant }),
    ).rejects.toThrow("unavailable");
    await expect(
      readValidationLogPage({
        digest: reference.digest,
        key: { ...writer.key, sessionId: "session-b" },
        store,
      }),
    ).rejects.toThrow("unavailable");
    const saved = await readValidationLogPage({ digest: reference.digest, key: writer.key, store });
    expect(saved.content).toBe("durable output\n");
  });
});
