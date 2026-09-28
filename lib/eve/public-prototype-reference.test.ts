import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createInstalledPrototypeReferenceReducer } from "./public-events";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const content = "<html>review</html>";
const path = "prototype/spend-review/index.html";
const digest = sha256(content);
const revision = sha256(JSON.stringify({ digest, mediaType: "text/html", path }));
const request = {
  data: {
    actions: [
      {
        callId: "call_1",
        input: { content, mediaType: "text/html", path },
        kind: "tool-call",
        toolName: "record_prototype_artifact",
      },
    ],
  },
  type: "actions.requested",
};
const result = {
  data: {
    result: {
      callId: "call_1",
      kind: "tool-result",
      output: {
        appId: "spend-review",
        chunkCount: 1,
        complete: true,
        contentBytes: Buffer.byteLength(content),
        digest,
        mediaType: "text/html",
        path,
        recordedByCallId: "call_1",
        revision,
        sessionId: "session_1",
        version: 2,
      },
      toolName: "record_prototype_artifact",
    },
    status: "completed",
  },
  type: "action.result",
};

describe("v2 public prototype reference projection", () => {
  it("projects only a completed receipt bound to the request and session", () => {
    const reducer = createInstalledPrototypeReferenceReducer({ sessionId: "session_1" });
    reducer.accept(result);
    expect(reducer.snapshot()).toBeUndefined();
    reducer.accept(request);
    reducer.accept(result);
    expect(reducer.snapshot()).toMatchObject({
      contentBytes: Buffer.byteLength(content),
      digest,
      path,
      recordedByCallId: "call_1",
      version: 2,
    });
    expect(reducer.snapshot()).not.toHaveProperty("content");
  });

  it("rejects a wrong session, call, revision, digest, or incomplete receipt", () => {
    for (const outputPatch of [
      { sessionId: "session_2" },
      { recordedByCallId: "call_other" },
      { revision: "a".repeat(64) },
      { digest: "b".repeat(64) },
      { complete: false },
    ]) {
      const reducer = createInstalledPrototypeReferenceReducer({ sessionId: "session_1" });
      reducer.accept(request);
      reducer.accept({
        ...result,
        data: {
          ...result.data,
          result: {
            ...result.data.result,
            output: { ...result.data.result.output, ...outputPatch },
          },
        },
      });
      expect(reducer.snapshot()).toBeUndefined();
    }
  });
});
