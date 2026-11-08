import { describe, expect, it } from "vitest";
import type { MessageStreamEvent } from "eve/client";
import { publicWorkingPreviewSchema } from "../mcp/contracts";
import {
  createInstalledPreviewMetadataReducer,
  latestInstalledWorkingPreview,
} from "./public-events";
import { projectHostedSnapshot } from "./hosted-projection";
import { resultFromHostedCheckpoint } from "./hosted-checkpoint-result";
import { hostedSessionCheckpointSchema } from "./hosted-store";

const workingPreview = {
  appId: "stock-exceptions",
  expiresAt: "2099-09-13T18:00:00.000Z",
  status: "ready" as const,
  url: "https://preview.example.test/app?access=opaque-signed-value",
  verifiedAt: "2026-09-13T17:00:00.000Z",
};
const eventMeta = { at: "2026-09-13T17:00:00.000Z", id: "event-one" };
const resultEvent = (
  toolName = "start_app_preview",
  status: "completed" | "failed" = "completed",
  isError = false,
): MessageStreamEvent => ({
  data: {
    result: {
      callId: "launch",
      isError,
      kind: "tool-result",
      output: { workingPreview },
      toolName,
    },
    sequence: 0,
    status,
    stepIndex: 0,
    turnId: "turn-one",
  },
  meta: eventMeta,
  type: "action.result",
});

describe("public working app preview", () => {
  it("reduces a live preview receipt and its invalidation one event at a time", () => {
    const reducer = createInstalledPreviewMetadataReducer();
    reducer.accept(resultEvent());
    expect(reducer.snapshot().workingPreview).toEqual(workingPreview);
    reducer.accept(resultEvent("start_app_preview", "failed"));
    expect(reducer.snapshot().workingPreview).toBeNull();
  });
  it("requires the actual successful runtime tool result, never model prose or fixture preview", () => {
    expect(latestInstalledWorkingPreview([resultEvent()])).toEqual(workingPreview);
    expect(
      latestInstalledWorkingPreview([
        {
          data: {
            finishReason: "stop",
            message: JSON.stringify({ workingPreview }),
            sequence: 0,
            stepIndex: 0,
            turnId: "turn-one",
          },
          meta: eventMeta,
          type: "message.completed",
        },
        resultEvent("record_ui_preview"),
        resultEvent("record_prototype_artifact"),
        resultEvent("start_app_preview", "failed"),
        resultEvent("start_app_preview", "completed", true),
      ]),
    ).toBeNull();
  });
  it("keeps the original signed HTTPS URL and rejects insecure or embedded-credential URLs", () => {
    expect(publicWorkingPreviewSchema.parse(workingPreview).url).toBe(workingPreview.url);
    for (const url of [
      "http://preview.example.test/app",
      "https://user:password@preview.example.test/app",
      "data:text/html,preview",
    ]) {
      expect(publicWorkingPreviewSchema.safeParse({ ...workingPreview, url }).success).toBe(false);
    }
  });
  it("invalidates the previous receipt when a later launch fails", () => {
    expect(
      latestInstalledWorkingPreview([resultEvent(), resultEvent("start_app_preview", "failed")]),
    ).toBeNull();
  });
  it("preserves expiry evidence outside pagination and through durable checkpoint recovery", () => {
    const snapshot = projectHostedSnapshot(
      "session-one",
      {
        events: [{ index: 0, status: "waiting", type: "status" }],
        status: "waiting",
        workingPreview,
      },
      1,
    );
    expect(snapshot).toMatchObject({ events: [], workingPreview });
    expect(snapshot.prototype).toBeUndefined();
    expect(snapshot.uiPreview).toBeUndefined();
    const checkpoint = hostedSessionCheckpointSchema.parse({
      capturedAtEpochMs: 0,
      events: [],
      status: "working",
      version: 1,
      workingPreview,
    });
    const recovered = resultFromHostedCheckpoint("session-one", checkpoint);
    expect(recovered).toMatchObject({ status: "waiting", workingPreview });
    // Historical readiness is not extended by observation or recovery.
    expect(recovered.workingPreview?.expiresAt).toBe(workingPreview.expiresAt);
  });
  it("invalidates while a new preview is starting and installs only its successful result", () => {
    const requested: MessageStreamEvent = {
      data: {
        actions: [
          { callId: "reopen", input: {}, kind: "tool-call", toolName: "start_app_preview" },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-one",
      },
      meta: eventMeta,
      type: "actions.requested",
    };
    expect(latestInstalledWorkingPreview([resultEvent(), requested])).toBeNull();
    expect(latestInstalledWorkingPreview([resultEvent(), requested, resultEvent()])).toEqual(
      workingPreview,
    );
  });
  it.each(["turn.cancelled", "turn.failed", "session.failed"])("invalidates after %s", (type) => {
    expect(
      latestInstalledWorkingPreview([resultEvent(), { data: {}, type } as MessageStreamEvent]),
    ).toBeNull();
  });
  it("returns null for expired receipts in current stream, snapshot, and checkpoint reads", () => {
    const expired = { ...workingPreview, expiresAt: "2000-01-01T00:00:00.000Z" };
    const event: MessageStreamEvent = {
      data: {
        result: {
          callId: "launch",
          kind: "tool-result",
          output: { workingPreview: expired },
          toolName: "start_app_preview",
        },
        sequence: 0,
        status: "completed",
        stepIndex: 0,
        turnId: "turn-one",
      },
      meta: eventMeta,
      type: "action.result",
    };
    expect(latestInstalledWorkingPreview([event])).toBeNull();
    expect(
      projectHostedSnapshot("one", { events: [], status: "waiting", workingPreview: expired })
        .workingPreview,
    ).toBeNull();
    const checkpoint = hostedSessionCheckpointSchema.parse({
      capturedAtEpochMs: 0,
      events: [],
      status: "waiting",
      version: 1,
      workingPreview: expired,
    });
    expect(resultFromHostedCheckpoint("one", checkpoint).workingPreview).toBeNull();
    expect(checkpoint.workingPreview).toEqual(expired);
  });
  it("retains explicit null in newer checkpoints instead of restoring an earlier receipt", () => {
    const prior = hostedSessionCheckpointSchema.parse({
      capturedAtEpochMs: 0,
      events: [],
      status: "waiting",
      version: 1,
      workingPreview,
    });
    const next = hostedSessionCheckpointSchema.parse({
      ...prior,
      capturedAtEpochMs: 1,
      workingPreview: null,
    });
    expect(resultFromHostedCheckpoint("one", next).workingPreview).toBeNull();
    expect(
      projectHostedSnapshot("one", { events: [], status: "working", workingPreview: null })
        .workingPreview,
    ).toBeNull();
  });
});
