import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  recordDurablePrototypeContent,
  durablePrototypeToolReceipt,
} from "../agent/prototype-artifacts-v2";
import type { DurablePrototypeChunkStore } from "../agent/prototype-artifacts-v2";
import { createInstalledPrototypeReferenceReducer } from "./public-events";
import { createPrototypePreviewRequestHandler } from "../mcp/browser-preview";

const content = "<!doctype html><main>🥑 Spend review</main>";
const digest = (value: string) => createHash("sha256").update(value, "utf-8").digest("hex");
const path = "prototype/spend-review/index.html";
const key = (value: { path: string; transferDigest: string; chunkIndex: number }) =>
  JSON.stringify([value.path, value.transferDigest, value.chunkIndex]);

const fixtureStore = () => {
  const values = new Map<string, string>();
  const store: DurablePrototypeChunkStore = {
    // oxlint-disable-next-line eslint/require-await -- Preserve Promise-returning store fixture.
    async get(value) {
      return values.get(key(value));
    },
    // oxlint-disable-next-line eslint/require-await -- Preserve Promise-returning store fixture.
    async put(value) {
      const id = key(value);
      const prior = values.get(id);
      if (prior !== undefined && prior !== value.content) {
        throw new Error("immutable conflict");
      }
      values.set(id, value.content);
      return digest(value.content);
    },
  };
  return { store, values };
};

describe("hosted v2 prototype journey", () => {
  it("writes chunks, projects only the completed ref, and serves verified HTML", async () => {
    const { store } = fixtureStore();
    const saved = await recordDurablePrototypeContent({
      appId: "spend-review",
      callId: "call-1",
      chunkBytes: 8,
      content,
      path,
      sessionId: "session-1",
      store,
    });
    const reducer = createInstalledPrototypeReferenceReducer({ sessionId: "session-1" });
    reducer.accept({
      data: {
        actions: [
          {
            callId: "call-1",
            input: { content, mediaType: "text/html", path },
            kind: "tool-call",
            toolName: "record_prototype_artifact",
          },
        ],
      },
      type: "actions.requested",
    });
    reducer.accept({
      data: {
        result: {
          callId: "call-1",
          kind: "tool-result",
          output: durablePrototypeToolReceipt(saved),
          toolName: "record_prototype_artifact",
        },
        status: "completed",
      },
      type: "action.result",
    });
    const reference = reducer.snapshot();
    expect(reference).toMatchObject({ digest: digest(content), path, version: 2 });
    expect(reference).not.toHaveProperty("content");
    const handler = createPrototypePreviewRequestHandler({
      // oxlint-disable-next-line eslint/require-await -- Preserve Promise-returning legacy resolver fixture.
      async resolvePrototype() {},
      // oxlint-disable-next-line eslint/require-await -- Preserve Promise-returning verified ref fixture.
      async resolveStreamedPrototype() {
        return {
          artifact: saved.artifact,
          readChunk: async (chunkIndex: number) =>
            await store.get({ chunkIndex, path, transferDigest: saved.artifact.digest }),
        };
      },
    });
    const request = new Request(
      `https://builder.example/preview/session-1/${saved.artifact.digest}`,
    );
    const response = await handler(request, {
      digest: saved.artifact.digest,
      sessionId: "session-1",
    });
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(content);
  });

  it("rejects a tampered durable chunk before emitting a Browser response", async () => {
    const { store, values } = fixtureStore();
    const saved = await recordDurablePrototypeContent({
      appId: "spend-review",
      callId: "call-1",
      chunkBytes: 8,
      content,
      path,
      sessionId: "session-1",
      store,
    });
    values.set(JSON.stringify([path, saved.artifact.digest, 0]), "tampered");
    const handler = createPrototypePreviewRequestHandler({
      // oxlint-disable-next-line eslint/require-await -- Preserve Promise-returning legacy resolver fixture.
      async resolvePrototype() {},
      // oxlint-disable-next-line eslint/require-await -- Preserve Promise-returning verified ref fixture.
      async resolveStreamedPrototype() {
        return {
          artifact: saved.artifact,
          readChunk: async (chunkIndex: number) =>
            await store.get({ chunkIndex, path, transferDigest: saved.artifact.digest }),
        };
      },
    });
    const response = await handler(
      new Request(`https://builder.example/preview/session-1/${saved.artifact.digest}`),
      { digest: saved.artifact.digest, sessionId: "session-1" },
    );
    expect(response.status).toBe(404);
  });
});
