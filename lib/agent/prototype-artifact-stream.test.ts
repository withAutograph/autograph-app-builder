import { createHash } from "node:crypto";

// oxlint-disable typescript/promise-function-async -- Promise.resolve fixtures keep ordered reads deterministic.

import { describe, expect, it } from "vitest";

import type { PrototypeArtifactV2 } from "./workflow-state";
import {
  streamVerifiedPrototypeArtifact,
  verifyPrototypeArtifactManifest,
} from "./prototype-artifact-stream";

const digest = (content: string) => createHash("sha256").update(content, "utf-8").digest("hex");
const chunks = ["<main>🥑", "café</main>"];
const content = chunks.join("");
const path = "prototype/spend-review/index.html";
const artifact: PrototypeArtifactV2 = {
  appId: "spend-review",
  chunkCount: chunks.length,
  contentBytes: Buffer.byteLength(content, "utf-8"),
  digest: digest(content),
  mediaType: "text/html",
  path,
  recordedByCallId: "call-1",
  revision: digest(JSON.stringify({ digest: digest(content), mediaType: "text/html", path })),
  sessionId: "session-1",
  version: 2,
};

describe("v2 prototype artifact streaming", () => {
  it("reconstructs exact UTF-8 bytes after verifying every ordered chunk", async () => {
    const readChunk = (index: number) => Promise.resolve(chunks[index]);
    const output: Uint8Array[] = [];
    for await (const chunk of streamVerifiedPrototypeArtifact({ artifact, readChunk })) {
      output.push(chunk);
    }
    expect(Buffer.concat(output).toString("utf-8")).toBe(content);
  });

  it("rejects missing, altered, and stale material before streaming", async () => {
    await expect(
      verifyPrototypeArtifactManifest({
        artifact,
        readChunk: (index) =>
          Promise.resolve(chunks[index] === undefined ? undefined : `${chunks[index]}x`),
      }),
    ).rejects.toThrow("chunk lengths");
    await expect(
      verifyPrototypeArtifactManifest({
        artifact,
        readChunk: (index) => Promise.resolve(index === 1 ? undefined : chunks[index]),
      }),
    ).rejects.toThrow("missing chunk 1");
    await expect(
      verifyPrototypeArtifactManifest({
        artifact: { ...artifact, path: "prototype/other/index.html" },
        readChunk: (index) => Promise.resolve(chunks[index]),
      }),
    ).rejects.toThrow("revision");
    await expect(
      verifyPrototypeArtifactManifest({
        artifact: { ...artifact, digest: "f".repeat(64) },
        readChunk: (index) => Promise.resolve(chunks[index]),
      }),
    ).rejects.toThrow("revision");
  });
});
