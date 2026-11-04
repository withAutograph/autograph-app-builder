import type { MessageStreamEvent } from "eve/client";
import { expect, it } from "vitest";
import { latestInstalledApplicationSource } from "./public-application-source";

const reference = {
  kind: "application-source-export-v1",
  appId: "app",
  sourceSessionId: "session",
  manifestDigest: "a".repeat(64),
  downloadPath: `/application-source/session/${"a".repeat(64)}`,
  fileCount: 2,
  bytes: 123,
  omissionCount: 1,
};
const meta = { id: "event", at: "2026-11-03T00:00:00Z" };
const request: MessageStreamEvent = {
  type: "actions.requested",
  meta,
  data: {
    turnId: "turn",
    sequence: 1,
    stepIndex: 0,
    actions: [
      {
        kind: "tool-call",
        callId: "export-call",
        toolName: "export-application-source",
        input: { displayName: "App" },
      },
    ],
  },
};
const result: MessageStreamEvent = {
  type: "action.result",
  meta,
  data: {
    turnId: "turn",
    sequence: 2,
    stepIndex: 0,
    status: "completed",
    result: {
      kind: "tool-result",
      callId: "export-call",
      toolName: "export-application-source",
      output: reference,
    },
  },
};
it("projects only a matching completed native source-export receipt", () => {
  expect(latestInstalledApplicationSource([result])).toBeUndefined();
  expect(latestInstalledApplicationSource([request, result])).toEqual(reference);
  const failed: MessageStreamEvent = { ...result, data: { ...result.data, status: "failed" } };
  expect(latestInstalledApplicationSource([request, failed])).toBeUndefined();
});
