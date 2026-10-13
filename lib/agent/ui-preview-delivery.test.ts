import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MessageStreamEvent } from "eve/client";
import { hostedUiPreviewReceipt } from "./ui-preview-delivery";
import { recordDurablePrototypeContent } from "./prototype-artifacts-v2";
import type { DurablePrototypeChunkStore } from "./prototype-artifacts-v2";
import {
  createInstalledPrototypeReferenceReducer,
  latestInstalledUiPreview,
} from "../eve/public-events";
import { EVE_MAX_PAYLOAD_BYTES, serializedPayloadBytes } from "../eve/payload-envelope";
import { verifyPrototypeArtifactManifest } from "./prototype-artifact-stream";

const sha256 = (value: string) => createHash("sha256").update(value, "utf-8").digest("hex");
const envelope = (output: ReturnType<typeof hostedUiPreviewReceipt> & { content?: string }) => ({
  data: { result: { kind: "tool-result", output, toolName: "record_ui_preview" } },
  type: "action.result",
});
const memoryStore = () => {
  const chunks = new Map<number, string>();
  const store: DurablePrototypeChunkStore = {
    async get(input) {
      return await Promise.resolve(chunks.get(input.chunkIndex));
    },
    async put(input) {
      const prior = chunks.get(input.chunkIndex);
      if (prior !== undefined && prior !== input.content) {
        throw new Error("Immutable fixture chunk conflict");
      }
      chunks.set(input.chunkIndex, input.content);
      return await Promise.resolve(sha256(input.content));
    },
  };
  return { chunks, store };
};

describe("hosted preview delivery", () => {
  it("publishes bounded browser-ready metadata and v2 public discovery without exposing compiled HTML", async () => {
    const source =
      "export default function Screen() { return <main><h1>Spend review</h1></main>; }\n";
    const prefix = "<!doctype html><html><body><script>/*";
    const suffix = "*/</script><main>Spend review</main></body></html>";
    const renderedBytes = 3_128_176;
    const html =
      prefix +
      "compiled_bundle_fixture;"
        .repeat(Math.ceil(renderedBytes / 24))
        .slice(0, renderedBytes - prefix.length - suffix.length) +
      suffix;
    const { chunks, store } = memoryStore();
    const result = await recordDurablePrototypeContent({
      appId: "spend-review",
      callId: "preview-call",
      content: html,
      path: "prototype/spend-review/index.html",
      sessionId: "session-fixture",
      store,
    });
    const receipt = hostedUiPreviewReceipt({
      callId: "preview-call",
      preview: { appId: "spend-review", revision: sha256(source), routes: ["/"] },
      result,
      reused: false,
    });
    expect(receipt).toMatchObject({
      browserReady: true,
      browserVerification: "not-observed",
      complete: true,
      contentBytes: renderedBytes,
      contentDelivery: "hosted-browser-stream",
      requiresChunkedRead: true,
      routineReadNotRequired: true,
    });
    expect(receipt).not.toHaveProperty("content");
    expect(JSON.stringify(receipt)).not.toContain("compiled_bundle_fixture");
    expect(receipt.artifactDigest).toBe(result.artifact.digest);
    expect(receipt.artifactRevision).toBe(result.artifact.revision);
    expect(receipt.sessionId).toBe(result.artifact.sessionId);
    expect(chunks.size).toBe(3);
    await verifyPrototypeArtifactManifest({
      artifact: result.artifact,
      readChunk: async (index) =>
        await store.get({
          chunkIndex: index,
          path: result.artifact.path,
          transferDigest: result.artifact.digest,
        }),
    });

    const events: MessageStreamEvent[] = [
      {
        data: {
          actions: [
            {
              callId: "preview-call",
              input: { appId: "spend-review" },
              kind: "tool-call",
              toolName: "record_ui_preview",
            },
          ],
          sequence: 0,
          stepIndex: 0,
          turnId: "turn-fixture",
        },
        meta: { at: "2026-10-13T00:00:00Z", id: "event-request" },
        type: "actions.requested",
      },
      {
        data: {
          result: {
            callId: "preview-call",
            kind: "tool-result",
            output: receipt,
            toolName: "record_ui_preview",
          },
          sequence: 0,
          status: "completed",
          stepIndex: 0,
          turnId: "turn-fixture",
        },
        meta: { at: "2026-10-13T00:00:01Z", id: "event-result" },
        type: "action.result",
      },
    ];
    const references = createInstalledPrototypeReferenceReducer({ sessionId: "session-fixture" });
    for (const event of events) {
      references.accept(event);
    }
    expect(references.snapshot()).toMatchObject({
      digest: result.artifact.digest,
      revision: result.artifact.revision,
      sessionId: result.artifact.sessionId,
      version: 2,
    });
    expect(latestInstalledUiPreview(events)).toMatchObject({
      appId: "spend-review",
      revision: sha256(source),
      routes: ["/"],
    });
    expect(events).toHaveLength(2);
    const receiptBytes = serializedPayloadBytes(envelope(receipt));
    const rawBytes = serializedPayloadBytes(envelope({ ...receipt, content: html }));
    expect(receiptBytes).toBeLessThan(2048);
    expect(receiptBytes).toBeLessThan(EVE_MAX_PAYLOAD_BYTES);
    expect(rawBytes).toBeGreaterThan(renderedBytes);
    console.info({
      authoredSourceBytes: Buffer.byteLength(source),
      compiledHtmlBytes: Buffer.byteLength(html),
      modelCompiledHtmlBytes: 0,
      rawEnvelopeBytes: rawBytes,
      receiptEnvelopeBytes: receiptBytes,
      savedEnvelopeBytes: rawBytes - receiptBytes,
    });
  });

  it("does not call an incomplete durable transfer browser-ready", async () => {
    const { store } = memoryStore();
    const result = await recordDurablePrototypeContent({
      appId: "spend-review",
      callId: "preview-call",
      content: "<main>Complete</main>",
      path: "prototype/spend-review/index.html",
      sessionId: "session-fixture",
      store,
    });
    expect(() =>
      hostedUiPreviewReceipt({
        callId: "preview-call",
        preview: { appId: "spend-review", revision: "a".repeat(64), routes: ["/"] },
        result: { ...result, complete: false },
        reused: false,
      }),
    ).toThrow("completed durable artifact");
  });
});
