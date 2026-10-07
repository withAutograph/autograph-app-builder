import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { BUILD_READY_APP_SPEC } from "../../evals/support/app-spec";
import { inspectCanonicalAppSpec, readAcceptedAppSpecContent } from "./accepted-app-spec-stream";
import { recordDurablePrototypeChunk } from "./prototype-artifacts-v2";
import type { DurablePrototypeChunkStore } from "./prototype-artifacts-v2";

const digest = (content: string) => createHash("sha256").update(content, "utf-8").digest("hex");

const fixture = async (content: string) => {
  const chunks = new Map<number, string>();
  const store: DurablePrototypeChunkStore = {
    // oxlint-disable-next-line eslint/require-await -- In-memory durable store fixture.
    async get({ chunkIndex }) {
      return chunks.get(chunkIndex);
    },
    // oxlint-disable-next-line eslint/require-await -- In-memory durable store fixture.
    async put({ chunkIndex, content: piece }) {
      const prior = chunks.get(chunkIndex);
      if (prior !== undefined && prior !== piece) {
        throw new Error("immutable chunk conflict");
      }
      chunks.set(chunkIndex, piece);
      return digest(piece);
    },
  };
  const pieces = content.match(/[\s\S]{1,65536}/gu) ?? [];
  let current: Awaited<ReturnType<typeof recordDurablePrototypeChunk>> | undefined;
  for (const [chunkIndex, piece] of pieces.entries()) {
    const continuation =
      current === undefined
        ? {}
        : {
            baseRevision: current.artifact.revision,
            current: current.artifact,
          };
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Each revision binds the next append.
    current = await recordDurablePrototypeChunk({
      appId: "inventory",
      ...continuation,
      callId: `call-${chunkIndex}`,
      chunkIndex,
      content: piece,
      expectedDigest: digest(content),
      finalChunk: chunkIndex === pieces.length - 1,
      mediaType: "text/markdown",
      path: "prototype/inventory/app-spec.md",
      sessionId: "session",
      store,
    });
  }
  if (current === undefined) {
    throw new Error("Expected a completed artifact.");
  }
  return {
    artifact: current.artifact,
    chunks,
    current,
    // oxlint-disable-next-line eslint/require-await -- In-memory read preserves the asynchronous store contract.
    readChunk: async (index: number) => chunks.get(index),
    store,
  };
};

describe("streamed AppSpec acceptance", () => {
  it("accepts a large canonical AppSpec by exact digest and reads the exact revision", async () => {
    const content = BUILD_READY_APP_SPEC.replace(
      "Confirmed outcome.",
      `Confirmed outcome.\n\n${"Large product requirement. ".repeat(80_000)}`,
    );
    const { artifact, readChunk } = await fixture(content);
    expect(artifact.chunkCount).toBeGreaterThan(20);
    expect(artifact).not.toHaveProperty("content");
    expect(await inspectCanonicalAppSpec({ artifact, readChunk })).toEqual({
      digest: digest(content),
      walkthrough: "User accepted this AppSpec.",
    });
    const accepted = {
      acceptedByCallId: "accept",
      appId: "inventory",
      artifactPath: artifact.path,
      artifactRevision: artifact.revision,
      digest: artifact.digest,
      version: 2 as const,
      walkthrough: "User accepted this AppSpec.",
    };
    expect(await readAcceptedAppSpecContent({ accepted, artifact, readChunk })).toBe(content);
    await expect(
      readAcceptedAppSpecContent({
        accepted: { ...accepted, artifactRevision: "0".repeat(64) },
        artifact,
        readChunk,
      }),
    ).rejects.toThrow("reference does not match");
  });

  it("preserves an interrupted transfer, exact retry, and verified readback", async () => {
    const content = BUILD_READY_APP_SPEC;
    const { artifact, chunks, current, readChunk, store } = await fixture(content);
    const lastIndex = artifact.chunkCount - 1;
    const retry = await recordDurablePrototypeChunk({
      appId: "inventory",
      callId: `call-${lastIndex}`,
      chunkIndex: lastIndex,
      content: chunks.get(lastIndex) ?? "",
      current: artifact,
      expectedDigest: digest(content),
      finalChunk: true,
      mediaType: "text/markdown",
      path: artifact.path,
      sessionId: "session",
      store,
    });
    expect(current.complete).toBe(true);
    expect(retry.reused).toBe(true);
    chunks.delete(lastIndex);
    await expect(inspectCanonicalAppSpec({ artifact, readChunk })).rejects.toThrow("missing chunk");
  });

  it("rejects noncanonical handoff bytes rather than accepting a mismatched normalized digest", async () => {
    const { artifact, readChunk } = await fixture(`${BUILD_READY_APP_SPEC}\n`);
    await expect(inspectCanonicalAppSpec({ artifact, readChunk })).rejects.toThrow(
      '"canonicalBuildHandoff":"## Build handoff\\n\\n```json',
    );
  });

  it("reports the handoff field and exact canonical block without normalizing streamed bytes", async () => {
    const content = BUILD_READY_APP_SPEC.replace('"status": "build-ready"', '"status": "ready"');
    const { artifact, readChunk } = await fixture(content);
    let message = "";
    try {
      await inspectCanonicalAppSpec({ artifact, readChunk });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(
      '"canonicalBuildHandoff":"## Build handoff\\n\\n```json\\n{\\n  \\"status\\": \\"build-ready\\"\\n}\\n```"',
    );
    expect(message).toContain('"path":"Build handoff.status"');
    expect(message).not.toContain('"status": "ready"');
  });

  it("distinguishes malformed spacing, trailing content, and CRLF in streamed handoffs", async () => {
    const cases = [
      {
        content: BUILD_READY_APP_SPEC.replace(
          "## Build handoff\n\n```json",
          "## Build handoff\n```json",
        ),
        message: "one blank line",
      },
      {
        content: `${BUILD_READY_APP_SPEC}\nNotes after handoff.`,
        message: "Remove all content after",
      },
      {
        content: BUILD_READY_APP_SPEC.replaceAll("\n", "\r\n"),
        message: "carriage returns",
      },
    ];
    await Promise.all(
      cases.map(async (testCase) => {
        const { artifact, readChunk } = await fixture(testCase.content);
        await expect(inspectCanonicalAppSpec({ artifact, readChunk })).rejects.toThrow(
          testCase.message,
        );
      }),
    );
  });
});
