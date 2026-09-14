import { describe, expect, it } from "vitest";
import type { MessageStreamEvent } from "eve/client";
import { publicWorkingPreviewSchema } from "../mcp/contracts";
import { latestInstalledWorkingPreview } from "./public-events";
import { projectHostedSnapshot } from "./hosted-projection";
import { resultFromHostedCheckpoint } from "./hosted-checkpoint-result";
import { hostedSessionCheckpointSchema } from "./hosted-store";

const workingPreview = {
  appId: "stock-exceptions",
  expiresAt: "2026-09-13T18:00:00.000Z",
  status: "ready" as const,
  url: "https://preview.example.test/app?access=opaque-signed-value",
  verifiedAt: "2026-09-13T17:00:00.000Z",
};
const resultEvent = (toolName = "start_app_preview", status = "completed", isError = false) =>
  ({
    data: {
      result: {
        callId: "launch",
        isError,
        kind: "tool-result",
        output: { workingPreview },
        toolName,
      },
      status,
    },
    type: "action.result",
  }) as unknown as MessageStreamEvent;

describe("public working app preview", () => {
  it("requires the actual successful runtime tool result, never model prose or fixture preview", () => {
    expect(latestInstalledWorkingPreview([resultEvent()])).toEqual(workingPreview);
    expect(
      latestInstalledWorkingPreview([
        {
          data: { message: JSON.stringify({ workingPreview }) },
          type: "message.completed",
        } as unknown as MessageStreamEvent,
        resultEvent("record_ui_preview"),
        resultEvent("record_prototype_artifact"),
        resultEvent("start_app_preview", "failed"),
        resultEvent("start_app_preview", "completed", true),
      ]),
    ).toBeUndefined();
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
  it("retains the last successful receipt if a later launch fails", () => {
    expect(
      latestInstalledWorkingPreview([resultEvent(), resultEvent("start_app_preview", "failed")]),
    ).toEqual(workingPreview);
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
});
