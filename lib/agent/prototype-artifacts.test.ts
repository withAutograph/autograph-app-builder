import { describe, expect, it } from "vitest";

import {
  completeBuildReadyPrototypeAppSpec,
  exactPrototypeArtifact,
  expectedPrototypeArtifactMediaType,
  parsePrototypeArtifactPath,
  recordPrototypeArtifactBundle,
  recordPrototypeArtifactRevision,
} from "./prototype-artifacts";

const sessionId = "session-1";

function record(
  input: Partial<Parameters<typeof recordPrototypeArtifactRevision>[0]> = {}
) {
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
    expect(
      parsePrototypeArtifactPath("prototype/expense-review/app-spec.md")
    ).toEqual({ appId: "expense-review", fileName: "app-spec.md" });
    expect(
      expectedPrototypeArtifactMediaType(
        "prototype/expense-review/decisions.md"
      )
    ).toBe("text/markdown");
    expect(
      expectedPrototypeArtifactMediaType("prototype/expense-review/index.html")
    ).toBe("text/html");
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
      })
    ).toBe(recorded.artifact);
    expect(() =>
      exactPrototypeArtifact(recorded.artifacts, {
        digest: "0".repeat(64),
        path: recorded.artifact.path,
        sessionId,
      })
    ).toThrow("stale or unavailable");
    expect(() =>
      exactPrototypeArtifact(recorded.artifacts, {
        digest: recorded.artifact.digest,
        path: recorded.artifact.path,
        sessionId: "session-2",
      })
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
    expect(changedPath.artifact.revision).not.toBe(
      changedBytes.artifact.revision
    );
  });

  it("rejects media-type drift and a second app id in one session", () => {
    expect(() => record({ mediaType: "text/html" })).toThrow("media type");
    const first = record();
    expect(() =>
      record({
        artifacts: first.artifacts,
        path: "prototype/vendor-review/app-spec.md",
      })
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
      })
    ).toBeUndefined();

    const content = `## Status and prototype\n\nReady.\n\n## User and outcome\n\nA.\n\n## Interfaces and navigation\n\nA.\n\n## Controls and behavior\n\nA.\n\n## Data model\n\nA.\n\n## Integrations and reconciliation\n\nA.\n\n## Temporal semantics\n\nA.\n\n## Writes, review, and authority\n\nA.\n\n## Access and tenancy\n\nA.\n\n## Agent behavior\n\nA.\n\n## Operational states\n\nA.\n\n## Defaults, non-goals, and risks\n\nA.\n\n## Acceptance walkthrough\n\nA.\n\n## Build handoff\n\n\`\`\`json\n{\n  "status": "build-ready",\n  "owner": "operations",\n  "schema": { "kind": "none" },\n  "additionalPublicRoutes": [],\n  "optionalCapabilities": { "integrations": [], "hostedResources": [] }\n}\n\`\`\``;
    const complete = record({
      artifacts: incomplete.artifacts,
      callId: "call-4",
      content,
    });
    expect(
      completeBuildReadyPrototypeAppSpec({
        appId: "expense-review",
        artifacts: complete.artifacts,
      })
    ).toMatchObject({ path: "prototype/expense-review/app-spec.md" });

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
      }).reused
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
      instruction: expect.stringContaining(
        "replace the complete Markdown artifact"
      ),
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "missing_heading" }),
      ]),
    });
  });
});
