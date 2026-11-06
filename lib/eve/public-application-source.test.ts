import type { MessageStreamEvent } from "eve/client";
import { expect, it } from "vitest";
import { latestInstalledApplicationSource } from "./public-application-source";

const reference = {
  appId: "app",
  bytes: 123,
  downloadPath: `/application-source/session/${"a".repeat(64)}`,
  fileCount: 2,
  kind: "application-source-export-v1",
  manifestDigest: "a".repeat(64),
  omissionCount: 1,
  sourceSessionId: "session",
};
const meta = { at: "2026-11-03T00:00:00Z", id: "event" };
const request: MessageStreamEvent = {
  data: {
    actions: [
      {
        callId: "export-call",
        input: { displayName: "App" },
        kind: "tool-call",
        toolName: "export-application-source",
      },
    ],
    sequence: 1,
    stepIndex: 0,
    turnId: "turn",
  },
  meta,
  type: "actions.requested",
};
const result: MessageStreamEvent = {
  data: {
    result: {
      callId: "export-call",
      kind: "tool-result",
      output: reference,
      toolName: "export-application-source",
    },
    sequence: 2,
    status: "completed",
    stepIndex: 0,
    turnId: "turn",
  },
  meta,
  type: "action.result",
};
it("projects only a matching completed native source-export receipt", () => {
  expect(latestInstalledApplicationSource([result])).toBeUndefined();
  expect(latestInstalledApplicationSource([request, result])).toEqual(reference);
  const failed: MessageStreamEvent = { ...result, data: { ...result.data, status: "failed" } };
  expect(latestInstalledApplicationSource([request, failed])).toBeUndefined();
});
