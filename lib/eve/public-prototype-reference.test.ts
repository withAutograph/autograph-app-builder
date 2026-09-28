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
  it("binds a completed UI preview artifact receipt to its source request", () => {
    const reducer = createInstalledPrototypeReferenceReducer({ sessionId: "session_1" });
    reducer.accept({
      data: {
        actions: [
          {
            callId: "preview_call",
            input: { appId: "spend-review", sourceFiles: [] },
            kind: "tool-call",
            toolName: "record_ui_preview",
          },
        ],
      },
      type: "actions.requested",
    });
    const previewResult = {
      data: {
        result: {
          callId: "preview_call",
          kind: "tool-result",
          output: {
            appId: "spend-review",
            artifactDigest: digest,
            artifactRevision: revision,
            chunkCount: 1,
            complete: true,
            contentBytes: Buffer.byteLength(content),
            digest,
            mediaType: "text/html",
            path,
            recordedByCallId: "preview_call",
            revision: "a".repeat(64),
            sessionId: "session_1",
            version: 2,
          },
          toolName: "record_ui_preview",
        },
        status: "completed",
      },
      type: "action.result",
    };
    reducer.accept(previewResult);
    expect(reducer.snapshot()).toMatchObject({
      digest,
      recordedByCallId: "preview_call",
      revision,
    });
    const wrong = createInstalledPrototypeReferenceReducer({ sessionId: "session_1" });
    wrong.accept({
      data: {
        actions: [
          {
            callId: "preview_call",
            input: { appId: "spend-review" },
            kind: "tool-call",
            toolName: "record_ui_preview",
          },
        ],
      },
      type: "actions.requested",
    });
    wrong.accept({
      ...previewResult,
      data: {
        ...previewResult.data,
        result: {
          ...previewResult.data.result,
          output: { ...previewResult.data.result.output, artifactRevision: "b".repeat(64) },
        },
      },
    });
    expect(wrong.snapshot()).toBeUndefined();
  });

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
