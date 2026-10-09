import { describe, expect, it } from "vitest";

import {
  EVE_MAX_PAYLOAD_BYTES,
  EVE_NATIVE_RESULT_PAGE_BYTES,
  fitOutputNativeFrame,
  largestUtf8PayloadChunk,
  nativeActionResultFrame,
  NativeFrameOverflowError,
  serializedNativeActionResultBytes,
  serializedPayloadBytes,
} from "./payload-envelope";

const metadata = { callId: "call-secret", toolName: "change_set_status", turnId: "turn-secret" };

describe("native action.result frames", () => {
  it("counts the SDK stamp and optional delivery IDs without exposing them in diagnostics", () => {
    const stampedMetadata = {
      ...metadata,
      at: "2026-10-08T00:00:00.000Z",
      deliveryIds: ['delivery-secret-🧾"'],
      id: "evt_01234567890123456789012345",
      sequence: 1,
      stepIndex: 2,
    };
    const frame = nativeActionResultFrame({ content: "hello" }, stampedMetadata);
    expect(frame.meta).toEqual({
      at: stampedMetadata.at,
      deliveryIds: stampedMetadata.deliveryIds,
      id: stampedMetadata.id,
    });
    expect(serializedNativeActionResultBytes({ content: "hello" }, stampedMetadata)).toBe(
      Buffer.byteLength(`${JSON.stringify(frame)}\n`),
    );
    expect(nativeActionResultFrame(null, { ...metadata, deliveryIds: [] }).meta).not.toHaveProperty(
      "deliveryIds",
    );
    expect(nativeActionResultFrame(null, metadata).meta.id).toHaveLength(30);
    expect(nativeActionResultFrame(null, metadata).meta.at).toHaveLength(27);
    expect(EVE_NATIVE_RESULT_PAGE_BYTES).toBe(EVE_MAX_PAYLOAD_BYTES / 8);
  });
  it("counts exact JSON escaping, multibyte text, native metadata, and the newline", () => {
    const output = { content: '🧾\n"\\', omission: null };
    const frame = nativeActionResultFrame(output, metadata);
    expect(frame.data.sequence).toBe(Number.MAX_SAFE_INTEGER);
    expect(frame.data.stepIndex).toBe(Number.MAX_SAFE_INTEGER);
    expect(serializedNativeActionResultBytes(output, metadata)).toBe(
      Buffer.byteLength(`${JSON.stringify(frame)}\n`, "utf-8"),
    );
    const bytes = serializedNativeActionResultBytes(output, metadata);
    expect(fitOutputNativeFrame(output, metadata, bytes)).toBe(output);
    expect(() => fitOutputNativeFrame(output, metadata, bytes - 1)).toThrow(
      NativeFrameOverflowError,
    );
  });

  it("rejects an output that fits bare but exceeds the unchanged native ceiling", () => {
    const output = { content: "x".repeat(EVE_MAX_PAYLOAD_BYTES - 20) };
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(EVE_MAX_PAYLOAD_BYTES);
    let caught: unknown;
    try {
      fitOutputNativeFrame(output, metadata);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NativeFrameOverflowError);
    if (!(caught instanceof NativeFrameOverflowError)) {
      throw new Error("Expected a native frame overflow");
    }
    const error = caught;
    expect(error.diagnostic).toEqual({
      eventType: "action.result",
      maximumBytes: EVE_MAX_PAYLOAD_BYTES,
      serializedBytes: serializedNativeActionResultBytes(output, metadata),
      toolName: metadata.toolName,
    });
    expect(error.message).not.toContain(metadata.callId);
    expect(error.message).not.toContain(metadata.turnId);
    expect(error.message).not.toContain("content");
  });

  it("pages escaped multibyte text against the complete native frame", () => {
    const content = '🧾\n"\\'.repeat(30);
    const maximumBytes = 450;
    const parts: string[] = [];
    let offsetBytes = 0;
    while (offsetBytes < Buffer.byteLength(content)) {
      const page = largestUtf8PayloadChunk({
        content,
        makePayload: (chunk, nextOffsetBytes) => ({ content: chunk, nextOffsetBytes }),
        maxBytes: maximumBytes,
        measurePayloadBytes: (output) => serializedNativeActionResultBytes(output, metadata),
        offsetBytes,
      });
      expect(serializedNativeActionResultBytes(page.payload, metadata)).toBeLessThanOrEqual(
        maximumBytes,
      );
      expect(page.content).not.toContain("�");
      const nextCodePoint = content.codePointAt(parts.join("").length + page.content.length);
      const nextCharacter =
        nextCodePoint === undefined ? undefined : String.fromCodePoint(nextCodePoint);
      if (nextCharacter !== undefined) {
        expect(
          serializedNativeActionResultBytes(
            {
              content: page.content + nextCharacter,
              nextOffsetBytes: page.nextOffsetBytes + Buffer.byteLength(nextCharacter),
            },
            metadata,
          ),
        ).toBeGreaterThan(maximumBytes);
      }
      parts.push(page.content);
      offsetBytes = page.nextOffsetBytes;
    }
    expect(parts.join("")).toBe(content);
  });
});

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
