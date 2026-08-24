import { describe, expect, it } from "vitest";

import {
  exactPrototypeArtifact,
  expectedPrototypeArtifactMediaType,
  parsePrototypeArtifactPath,
  recordPrototypeArtifactRevision,
} from "./prototype-artifacts";

const sessionId = "session-1";

function record(
  input: Partial<Parameters<typeof recordPrototypeArtifactRevision>[0]> = {},
) {
  return recordPrototypeArtifactRevision({
    artifacts: [],
    path: "prototype/expense-review/app-spec.md",
    mediaType: "text/markdown",
    content: "first revision",
    sessionId,
    callId: "call-1",
    ...input,
  });
}

describe("prototype artifact receipts", () => {
  it("allows only the three exact files below one kebab-case app id", () => {
    expect(
      parsePrototypeArtifactPath("prototype/expense-review/app-spec.md"),
    ).toEqual({ appId: "expense-review", fileName: "app-spec.md" });
    expect(
      expectedPrototypeArtifactMediaType(
        "prototype/expense-review/decisions.md",
      ),
    ).toBe("text/markdown");
    expect(
      expectedPrototypeArtifactMediaType("prototype/expense-review/index.html"),
    ).toBe("text/html");
    for (const path of [
      "prototype/Expense-review/app-spec.md",
      "prototype/expense-review/other.md",
      "prototype/expense-review/pages/index.html",
      "prototype/expense-review/../app-spec.md",
      "/prototype/expense-review/app-spec.md",
    ])
      expect(() => parsePrototypeArtifactPath(path)).toThrow("not allowed");
  });

  it("reads back only the exact session, path, and digest", () => {
    const recorded = record();
    expect(
      exactPrototypeArtifact(recorded.artifacts, {
        path: recorded.artifact.path,
        digest: recorded.artifact.digest,
        revision: recorded.artifact.revision,
        sessionId,
      }),
    ).toBe(recorded.artifact);
    expect(() =>
      exactPrototypeArtifact(recorded.artifacts, {
        path: recorded.artifact.path,
        digest: "0".repeat(64),
        sessionId,
      }),
    ).toThrow("stale or unavailable");
    expect(() =>
      exactPrototypeArtifact(recorded.artifacts, {
        path: recorded.artifact.path,
        digest: recorded.artifact.digest,
        sessionId: "session-2",
      }),
    ).toThrow("stale or unavailable");
  });

  it("converges an exact lost-response retry on the stored receipt", () => {
    const first = record();
    const retry = record({ artifacts: first.artifacts, callId: "call-2" });
    expect(retry.reused).toBe(true);
    expect(retry.artifact).toBe(first.artifact);
    expect(retry.artifacts).toBe(first.artifacts);
    expect(retry.artifact.recordedByCallId).toBe("call-1");
  });

  it("changes the revision when bytes or the allowlisted path change", () => {
    const first = record();
    const changedBytes = record({
      artifacts: first.artifacts,
      content: "second revision",
      callId: "call-2",
    });
    const changedPath = record({
      artifacts: changedBytes.artifacts,
      path: "prototype/expense-review/decisions.md",
      content: "second revision",
      callId: "call-3",
    });
    expect(changedBytes.artifact.digest).not.toBe(first.artifact.digest);
    expect(changedBytes.artifact.revision).not.toBe(first.artifact.revision);
    expect(changedPath.artifact.digest).toBe(changedBytes.artifact.digest);
    expect(changedPath.artifact.revision).not.toBe(
      changedBytes.artifact.revision,
    );
  });

  it("rejects media-type drift and a second app id in one session", () => {
    expect(() => record({ mediaType: "text/html" })).toThrow("media type");
    const first = record();
    expect(() =>
      record({
        artifacts: first.artifacts,
        path: "prototype/vendor-review/app-spec.md",
      }),
    ).toThrow("different prototype app");
  });
});
