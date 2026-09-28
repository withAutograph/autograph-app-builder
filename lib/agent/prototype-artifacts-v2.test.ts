import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { durablePrototypeToolReceipt, recordDurablePrototypeChunk } from "./prototype-artifacts-v2";
import type { DurablePrototypeChunkStore } from "./prototype-artifacts-v2";

const digest = (value: string) => createHash("sha256").update(value, "utf-8").digest("hex");

const key = (value: { path: string; transferDigest: string; chunkIndex: number }) =>
  JSON.stringify([value.path, value.transferDigest, value.chunkIndex]);

const memoryStore = (): DurablePrototypeChunkStore => {
  const chunks = new Map<string, string>();
  return {
    // oxlint-disable-next-line eslint/require-await -- Preserve Promise-returning store fixture.
    async get(value) {
      return chunks.get(key(value));
    },
    // oxlint-disable-next-line eslint/require-await -- Preserve Promise-returning store fixture.
    async put(value) {
      const id = key(value);
      const prior = chunks.get(id);
      if (prior !== undefined && prior !== value.content) {
        throw new Error("immutable chunk conflict");
      }
      chunks.set(id, value.content);
      return digest(value.content);
    },
  };
};

describe("durable v2 prototype tool writer", () => {
  it("stores chunks before publishing only a verified manifest and preserves idempotent retry", async () => {
    const store = memoryStore();
    const pieces = ["<main>🥑", "café</main>"];
    const expectedDigest = digest(pieces.join(""));
    const common = {
      appId: "spend-review",
      expectedDigest,
      mediaType: "text/html" as const,
      path: "prototype/spend-review/index.html",
      sessionId: "session-1",
      store,
    };
    const first = await recordDurablePrototypeChunk({
      ...common,
      callId: "call-1",
      chunkIndex: 0,
      content: pieces[0],
      finalChunk: false,
    });
    expect(first.artifact).not.toHaveProperty("content");
    expect(first.artifact.transfer?.nextChunkIndex).toBe(1);
    expect(
      await recordDurablePrototypeChunk({
        ...common,
        callId: "call-1",
        chunkIndex: 0,
        content: pieces[0],
        current: first.artifact,
        finalChunk: false,
      }),
    ).toMatchObject({ complete: false, reused: true });
    const second = await recordDurablePrototypeChunk({
      ...common,
      baseRevision: first.artifact.revision,
      callId: "call-2",
      chunkIndex: 1,
      content: pieces[1],
      current: first.artifact,
      finalChunk: true,
    });
    expect(second.artifact).toMatchObject({ chunkCount: 2, digest: expectedDigest, version: 2 });
    expect(second.artifact).not.toHaveProperty("content");
    expect(durablePrototypeToolReceipt(second)).toMatchObject({
      complete: true,
      contentBytes: Buffer.byteLength(pieces.join(""), "utf-8"),
      digest: expectedDigest,
      recordedByCallId: "call-2",
      version: 2,
    });
    expect(durablePrototypeToolReceipt(second)).not.toHaveProperty("transfer");
    expect(
      await recordDurablePrototypeChunk({
        ...common,
        baseRevision: first.artifact.revision,
        callId: "call-2",
        chunkIndex: 1,
        content: pieces[1],
        current: second.artifact,
        finalChunk: true,
      }),
    ).toMatchObject({ complete: true, reused: true });
  });

  it("does not publish a manifest when final content fails the digest", async () => {
    const store = memoryStore();
    const common = {
      appId: "spend-review",
      expectedDigest: digest("correct"),
      mediaType: "text/html" as const,
      path: "prototype/spend-review/index.html",
      sessionId: "session-1",
      store,
    };
    await expect(
      recordDurablePrototypeChunk({
        ...common,
        callId: "call-1",
        chunkIndex: 0,
        content: "wrong",
        finalChunk: true,
      }),
    ).rejects.toThrow("content digest");
  });

  it("rejects stale revisions and cross-session transfers", async () => {
    const store = memoryStore();
    const common = {
      appId: "spend-review",
      expectedDigest: digest("ab"),
      mediaType: "text/html" as const,
      path: "prototype/spend-review/index.html",
      sessionId: "session-1",
      store,
    };
    const first = await recordDurablePrototypeChunk({
      ...common,
      callId: "call-1",
      chunkIndex: 0,
      content: "a",
      finalChunk: false,
    });
    await expect(
      recordDurablePrototypeChunk({
        ...common,
        baseRevision: "f".repeat(64),
        callId: "call-2",
        chunkIndex: 1,
        content: "b",
        current: first.artifact,
        finalChunk: true,
      }),
    ).rejects.toThrow("stale");
    await expect(
      recordDurablePrototypeChunk({
        ...common,
        callId: "call-1",
        chunkIndex: 0,
        content: "a",
        current: { ...first.artifact, sessionId: "another" },
        finalChunk: false,
      }),
    ).rejects.toThrow("different session");
  });
});
