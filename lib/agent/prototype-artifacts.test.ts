import { describe, expect, it } from "vitest";

import {
  completeBuildReadyPrototypeAppSpec,
  exactPrototypeArtifact,
  expectedPrototypeArtifactMediaType,
  parsePrototypeArtifactPath,
  prototypeArtifactReadChunk,
  recordPrototypeArtifactBundle,
  recordPrototypeArtifactChunk,
  recordPrototypeArtifactRevision,
} from "./prototype-artifacts";
import { sha256 } from "./workflow-state";

const sessionId = "session-1";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function record(input: Partial<Parameters<typeof recordPrototypeArtifactRevision>[0]> = {}) {
  return recordPrototypeArtifactRevision({
    artifacts: [],
    callId: "call-1",
    content: "first revision",
    mediaType: "text/markdown",
    path: "prototype/expense-review/app-spec.md",
    sessionId,
    ...input,
  });
}

describe("prototype artifact receipts", () => {
  it("allows only the three exact files below one kebab-case app id", () => {
    expect(parsePrototypeArtifactPath("prototype/expense-review/app-spec.md")).toEqual({
      appId: "expense-review",
      fileName: "app-spec.md",
    });
    expect(expectedPrototypeArtifactMediaType("prototype/expense-review/decisions.md")).toBe(
      "text/markdown",
    );
    expect(expectedPrototypeArtifactMediaType("prototype/expense-review/index.html")).toBe(
      "text/html",
    );
    for (const path of [
      "prototype/Expense-review/app-spec.md",
      "prototype/expense-review/other.md",
      "prototype/expense-review/pages/index.html",
      "prototype/expense-review/../app-spec.md",
      "/prototype/expense-review/app-spec.md",
    ]) {
      expect(() => parsePrototypeArtifactPath(path)).toThrow("not allowed");
    }
  });

  it("reads back only the exact session, path, and digest", () => {
    const recorded = record();
    expect(
      exactPrototypeArtifact(recorded.artifacts, {
        digest: recorded.artifact.digest,
        path: recorded.artifact.path,
        revision: recorded.artifact.revision,
        sessionId,
      }),
    ).toBe(recorded.artifact);
    expect(() =>
      exactPrototypeArtifact(recorded.artifacts, {
        digest: "0".repeat(64),
        path: recorded.artifact.path,
        sessionId,
      }),
    ).toThrow("stale or unavailable");
    expect(() =>
      exactPrototypeArtifact(recorded.artifacts, {
        digest: recorded.artifact.digest,
        path: recorded.artifact.path,
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

  it("assembles ordered chunks into an uncapped artifact and rejects gaps, duplicates, and stale revisions", () => {
    const firstChunk = "first 🧾\n";
    const secondChunk = "second chunk\n";
    const thirdChunk = "final chunk";
    const fullContent = firstChunk + secondChunk + thirdChunk;
    const expectedDigest = sha256(fullContent);
    const first = recordPrototypeArtifactChunk({
      artifacts: [],
      callId: "chunk-0",
      chunkIndex: 0,
      content: firstChunk,
      expectedDigest,
      finalChunk: false,
      mediaType: "text/markdown",
      path: "prototype/expense-review/app-spec.md",
      sessionId,
    });
    expect(first).toMatchObject({ complete: false, nextChunkIndex: 1 });
    expect(() =>
      recordPrototypeArtifactChunk({
        artifacts: first.artifacts,
        baseRevision: first.artifact.revision,
        callId: "chunk-2-gap",
        chunkIndex: 2,
        content: thirdChunk,
        expectedDigest,
        finalChunk: true,
        mediaType: "text/markdown",
        path: first.artifact.path,
        sessionId,
      }),
    ).toThrow("out of order");
    expect(() =>
      recordPrototypeArtifactChunk({
        artifacts: first.artifacts,
        baseRevision: "0".repeat(64),
        callId: "chunk-1-stale",
        chunkIndex: 1,
        content: secondChunk,
        expectedDigest,
        finalChunk: false,
        mediaType: "text/markdown",
        path: first.artifact.path,
        sessionId,
      }),
    ).toThrow("stale");

    const second = recordPrototypeArtifactChunk({
      artifacts: first.artifacts,
      baseRevision: first.artifact.revision,
      callId: "chunk-1",
      chunkIndex: 1,
      content: secondChunk,
      expectedDigest,
      finalChunk: false,
      mediaType: "text/markdown",
      path: first.artifact.path,
      sessionId,
    });
    expect(second).toMatchObject({ complete: false, nextChunkIndex: 2 });
    const duplicate = recordPrototypeArtifactChunk({
      artifacts: second.artifacts,
      baseRevision: first.artifact.revision,
      callId: "chunk-1",
      chunkIndex: 1,
      content: secondChunk,
      expectedDigest,
      finalChunk: false,
      mediaType: "text/markdown",
      path: first.artifact.path,
      sessionId,
    });
    expect(duplicate).toMatchObject({ complete: false, nextChunkIndex: 2, reused: true });

    const complete = recordPrototypeArtifactChunk({
      artifacts: second.artifacts,
      baseRevision: second.artifact.revision,
      callId: "chunk-2",
      chunkIndex: 2,
      content: thirdChunk,
      expectedDigest,
      finalChunk: true,
      mediaType: "text/markdown",
      path: first.artifact.path,
      sessionId,
    });
    expect(complete).toMatchObject({
      artifact: { content: fullContent, digest: expectedDigest },
      complete: true,
    });
    expect(complete.artifact.transfer).toBeUndefined();
    expect(
      recordPrototypeArtifactChunk({
        artifacts: complete.artifacts,
        baseRevision: second.artifact.revision,
        callId: "chunk-2",
        chunkIndex: 2,
        content: thirdChunk,
        expectedDigest,
        finalChunk: true,
        mediaType: "text/markdown",
        path: first.artifact.path,
        sessionId,
      }),
    ).toMatchObject({ complete: true, reused: true });
    expect(
      exactPrototypeArtifact(complete.artifacts, {
        digest: expectedDigest,
        path: first.artifact.path,
        revision: complete.artifact.revision,
        sessionId,
      }),
    ).toBe(complete.artifact);
  });

  it("accepts aggregate content beyond the former 8 MiB ceiling when each chunk fits Eve's envelope", () => {
    const chunk = "a".repeat(4 * 1024 * 1024);
    const fullContent = `${chunk + chunk}end`;
    const expectedDigest = sha256(fullContent);
    const first = recordPrototypeArtifactChunk({
      artifacts: [],
      callId: "large-0",
      chunkIndex: 0,
      content: chunk,
      expectedDigest,
      finalChunk: false,
      mediaType: "text/html",
      path: "prototype/expense-review/index.html",
      sessionId,
    });
    const second = recordPrototypeArtifactChunk({
      artifacts: first.artifacts,
      baseRevision: first.artifact.revision,
      callId: "large-1",
      chunkIndex: 1,
      content: chunk,
      expectedDigest,
      finalChunk: false,
      mediaType: "text/html",
      path: first.artifact.path,
      sessionId,
    });
    const final = recordPrototypeArtifactChunk({
      artifacts: second.artifacts,
      baseRevision: second.artifact.revision,
      callId: "large-2",
      chunkIndex: 2,
      content: "end",
      expectedDigest,
      finalChunk: true,
      mediaType: "text/html",
      path: first.artifact.path,
      sessionId,
    });
    expect(final.complete).toBe(true);
    expect(Buffer.byteLength(final.artifact.content)).toBeGreaterThan(8 * 1024 * 1024);
    expect(final.artifact.digest).toBe(expectedDigest);
  });

  it("reads artifacts larger than one Eve event in digest-verified UTF-8 ranges", () => {
    const content = "🧾".repeat(2_700_000);
    const { artifact } = record({ content });
    const first = prototypeArtifactReadChunk(artifact, { offsetBytes: 0 });
    expect(first.complete).toBe(false);
    expect(first.byteOffset).toBe(0);
    expect(sha256(first.content)).toBe(first.chunkDigest);
    expect(first.nextOffsetBytes).toBeLessThan(Buffer.byteLength(content));
    const second = prototypeArtifactReadChunk(artifact, {
      offsetBytes: first.nextOffsetBytes,
    });
    expect(second.complete).toBe(true);
    expect(first.content + second.content).toBe(content);
    expect(sha256(first.content + second.content)).toBe(artifact.digest);
    expect(() =>
      prototypeArtifactReadChunk(artifact, { offsetBytes: first.nextOffsetBytes - 1 }),
    ).toThrow("UTF-8 character boundary");
  });

  it("changes the revision when bytes or the allowlisted path change", () => {
    const first = record();
    const changedBytes = record({
      artifacts: first.artifacts,
      callId: "call-2",
      content: "second revision",
    });
    const changedPath = record({
      artifacts: changedBytes.artifacts,
      callId: "call-3",
      content: "second revision",
      path: "prototype/expense-review/decisions.md",
    });
    expect(changedBytes.artifact.digest).not.toBe(first.artifact.digest);
    expect(changedBytes.artifact.revision).not.toBe(first.artifact.revision);
    expect(changedPath.artifact.digest).toBe(changedBytes.artifact.digest);
    expect(changedPath.artifact.revision).not.toBe(changedBytes.artifact.revision);
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

  it("recognizes only a complete, build-ready prototype bundle", () => {
    const index = record({
      content: "<!doctype html><title>Expense review</title>",
      mediaType: "text/html",
      path: "prototype/expense-review/index.html",
    });
    const decisions = record({
      artifacts: index.artifacts,
      content: "# Decisions\n",
      path: "prototype/expense-review/decisions.md",
    });
    const incomplete = record({ artifacts: decisions.artifacts });
    expect(
      completeBuildReadyPrototypeAppSpec({
        appId: "expense-review",
        artifacts: incomplete.artifacts,
      }),
    ).toBeUndefined();

    const content = `## Status and prototype\n\nReady.\n\n## User and outcome\n\nA.\n\n## Interfaces and navigation\n\nA.\n\n## Controls and behavior\n\nA.\n\n## Data model\n\nA.\n\n## Integrations and reconciliation\n\nA.\n\n## Temporal semantics\n\nA.\n\n## Writes, review, and authority\n\nA.\n\n## Access and tenancy\n\nA.\n\n## Agent behavior\n\nA.\n\n## Operational states\n\nA.\n\n## Defaults, non-goals, and risks\n\nA.\n\n## Acceptance walkthrough\n\nA.\n\n## Build handoff\n\n\`\`\`json\n{\n  "status": "build-ready"\n}\n\`\`\``;
    const complete = record({
      artifacts: incomplete.artifacts,
      callId: "call-4",
      content,
    });
    expect(
      completeBuildReadyPrototypeAppSpec({
        appId: "expense-review",
        artifacts: complete.artifacts,
      }),
    ).toMatchObject({ path: "prototype/expense-review/app-spec.md" });

    const durableIndex = {
      appId: index.artifact.appId,
      chunkCount: 1,
      contentBytes: Buffer.byteLength(index.artifact.content, "utf-8"),
      digest: index.artifact.digest,
      mediaType: index.artifact.mediaType,
      path: index.artifact.path,
      recordedByCallId: index.artifact.recordedByCallId,
      revision: index.artifact.revision,
      sessionId: index.artifact.sessionId,
      version: 2 as const,
    };
    const mixed = complete.artifacts.map((artifact) =>
      artifact.path === durableIndex.path ? durableIndex : artifact,
    );
    expect(
      completeBuildReadyPrototypeAppSpec({ appId: "expense-review", artifacts: mixed }),
    ).toMatchObject({ path: "prototype/expense-review/app-spec.md" });
    expect(
      completeBuildReadyPrototypeAppSpec({
        appId: "expense-review",
        artifacts: mixed.map((artifact) =>
          artifact.path === durableIndex.path
            ? {
                ...durableIndex,
                transfer: {
                  expectedDigest: durableIndex.digest,
                  lastCallId: "call",
                  lastChunkDigest: durableIndex.digest,
                  nextChunkIndex: 1,
                  receivedBytes: durableIndex.contentBytes,
                  rollingDigest: durableIndex.digest,
                  version: 2 as const,
                },
              }
            : artifact,
        ),
      }),
    ).toBeUndefined();

    const bundle = recordPrototypeArtifactBundle({
      appId: "expense-review",
      appSpecMarkdown: content,
      artifacts: [],
      callId: "call-bundle",
      decisionsMarkdown: "# Decisions\n",
      indexHtml: "<!doctype html><title>Expense review</title>",
      sessionId,
    });
    expect(bundle.artifacts.map(({ path }) => path)).toEqual([
      "prototype/expense-review/app-spec.md",
      "prototype/expense-review/decisions.md",
      "prototype/expense-review/index.html",
    ]);
    expect(bundle.appSpec.path).toBe("prototype/expense-review/app-spec.md");
    expect(
      recordPrototypeArtifactBundle({
        appId: "expense-review",
        appSpecMarkdown: content,
        artifacts: bundle.artifacts,
        callId: "call-bundle-retry",
        decisionsMarkdown: "# Decisions\n",
        indexHtml: "<!doctype html><title>Expense review</title>",
        sessionId,
      }).reused,
    ).toBe(true);
    let diagnostic: unknown;
    try {
      recordPrototypeArtifactBundle({
        appId: "expense-review",
        appSpecMarkdown: "Still exploring.",
        artifacts: [],
        callId: "call-incomplete-bundle",
        decisionsMarkdown: "# Decisions\n",
        indexHtml: "<!doctype html><title>Expense review</title>",
        sessionId,
      });
    } catch (error) {
      diagnostic = JSON.parse((error as Error).message);
    }
    expect(diagnostic).toMatchObject({
      code: "app_spec_invalid",
      instruction: expect.stringContaining("replace the complete Markdown artifact"),
      issues: expect.arrayContaining([expect.objectContaining({ code: "missing_heading" })]),
    });
  });
});
