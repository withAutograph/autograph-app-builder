import { describe, expect, it } from "vitest";

import { largestUtf8PayloadChunk, serializedPayloadBytes } from "./payload-envelope";

describe("Eve payload envelope chunking", () => {
  it("finds the largest UTF-8-safe prefix using the whole serialized output shape", () => {
    const content = "a🧾\n".repeat(100);
    const first = largestUtf8PayloadChunk({
      content,
      makePayload: (chunk, nextOffsetBytes) => ({
        data: {
          result: { output: { content: chunk, nextOffsetBytes, path: "prototype/x/index.html" } },
        },
        type: "action.result",
      }),
      maxBytes: 256,
      offsetBytes: 0,
    });
    expect(serializedPayloadBytes(first.payload)).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(first.content)).toBe(first.nextOffsetBytes);
    expect(content.startsWith(first.content)).toBe(true);
    const chunks = [first.content];
    let offsetBytes = first.nextOffsetBytes;
    while (offsetBytes < Buffer.byteLength(content)) {
      const next = largestUtf8PayloadChunk({
        content,
        makePayload: (chunk, nextOffsetBytes) => ({ content: chunk, nextOffsetBytes }),
        maxBytes: 256,
        offsetBytes,
      });
      chunks.push(next.content);
      offsetBytes = next.nextOffsetBytes;
    }
    expect(chunks.join("")).toBe(content);
  });

  it("rejects offsets inside a multibyte UTF-8 character", () => {
    expect(() =>
      largestUtf8PayloadChunk({
        content: "🧾",
        makePayload: (content) => ({ content }),
        maxBytes: 128,
        offsetBytes: 1,
      }),
    ).toThrow("UTF-8 character boundary");
  });
});
