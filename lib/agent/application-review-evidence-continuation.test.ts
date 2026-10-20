import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createApplicationReviewEvidence } from "./application-review-evidence";
import type { ApplicationReviewEvidence } from "./application-source-review";
import type { ProductSourceReviewInput } from "./product-source-review";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const sourcePath = "apps/example/source.ts";
const reviewInput: ProductSourceReviewInput = {
  originalRequest: "Keep the requested source behavior.",
  clarifications: [],
  appSpec: "Keep the requested source behavior.",
  appSpecDigest: "spec",
  sourceDigest: "source",
  files: [],
  omissions: [],
};
const sourceReference = (result: Awaited<ReturnType<ApplicationReviewEvidence["readSource"]>>) => ({
  kind: "source",
  path: result.path,
  digest: result.digest,
  startLine: result.startLine,
  endLine: result.endLine,
  startColumn: result.startColumn,
  endColumn: result.endColumn,
  contentDigest: digest(result.content),
  nextCursor: result.nextCursor,
});
const fixture = (
  source: string,
  restoredSourceReads: readonly unknown[] = [],
  options: { abortSignal?: AbortSignal; actualSource?: string } = {},
) => {
  const readFile = vi.fn(({ path }: { path: string }) =>
    Promise.resolve(
      path === `repository/${sourcePath}`
        ? new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(options.actualSource ?? source));
              controller.close();
            },
          })
        : null,
    ),
  );
  const evidence = createApplicationReviewEvidence({
    reviewInput,
    observed: {
      treeDigest: "observed",
      files: [{ path: sourcePath, mode: "644", digest: digest(source) }],
    },
    changedPaths: [sourcePath],
    visiblePaths: [sourcePath],
    applyRoot: "/workspace/repository",
    sandbox: { readFile },
    abortSignal: options.abortSignal,
    restoredSourceReads,
  });
  return { evidence, readFile };
};
const longSource = Array.from({ length: 7000 }, (_, index) => `value_${index}_🚀`).join(" ");

describe("durable review source citation windows", () => {
  it("restores partial long-line citations from exact private references after a new round", async () => {
    const first = fixture(longSource);
    const page = await first.evidence.readSource({
      path: sourcePath,
      cursor: { line: 1, column: longSource.indexOf("value_100_") + 1, endLine: 1 },
    });
    const citation = {
      path: sourcePath,
      startLine: 1,
      endLine: 1,
      excerpt: page.content.slice(0, 80),
    };
    expect(await fixture(longSource).evidence.verifySourceCitation(citation)).toBe(false);
    const restored = fixture(longSource, structuredClone([sourceReference(page)]));
    expect(restored.readFile).not.toHaveBeenCalled();
    expect(await restored.evidence.verifySourceCitation(citation)).toBe(true);
    expect(await restored.evidence.verifySourceCitation(citation)).toBe(true);
    expect(restored.readFile).toHaveBeenCalledTimes(1);
    expect(
      await restored.evidence.verifySourceCitation({ ...citation, excerpt: "value_0_🚀" }),
    ).toBe(false);
  });

  it("restores an exclusive end immediately after a newline without widening the window", async () => {
    const source = Array.from({ length: 250 }, (_, index) => `line_${index + 1}_tail\n`).join("");
    const first = fixture(source);
    const page = await first.evidence.readSource({ path: sourcePath });
    const lastLine = page.endLine;
    const restored = fixture(source, [sourceReference(page)]);
    expect(
      await restored.evidence.verifySourceCitation({
        path: sourcePath,
        startLine: lastLine,
        endLine: lastLine,
        excerpt: `${lastLine}_tail`,
      }),
    ).toBe(true);
    expect(
      await restored.evidence.verifySourceCitation({
        path: sourcePath,
        startLine: lastLine + 1,
        endLine: lastLine + 1,
        excerpt: `${lastLine + 1}_tail`,
      }),
    ).toBe(false);
  });

  it("ignores mismatched or malformed references while keeping fresh source reads available", async () => {
    const page = await fixture(longSource).evidence.readSource({ path: sourcePath, endLine: 1 });
    const reference = sourceReference(page);
    const citation = {
      path: sourcePath,
      startLine: 1,
      endLine: 1,
      excerpt: page.content.slice(0, 80),
    };
    const invalid = [
      { ...reference, digest: "different-source" },
      { ...reference, contentDigest: digest("different-window") },
      { ...reference, path: "apps/other/source.ts" },
      { ...reference, kind: "requirement" },
      { ...reference, startColumn: -1 },
      { ...reference, endColumn: longSource.length + 20 },
      { ...reference, endLine: 2 },
      { ...reference, startColumn: 2 },
      { ...reference, endColumn: reference.endColumn - 1 },
      null,
    ];
    for (const changed of invalid) {
      const restored = fixture(longSource, [changed]);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each independent malformed reference must preserve the same citation behavior.
      expect(await restored.evidence.verifySourceCitation(citation)).toBe(false);
      // oxlint-disable-next-line eslint/no-await-in-loop -- A bad restored reference must not prevent an ordinary correcting read.
      await restored.evidence.readSource({ path: sourcePath, endLine: 1 });
      // oxlint-disable-next-line eslint/no-await-in-loop -- Verify the concrete correcting read, not a source-shape assertion.
      expect(await restored.evidence.verifySourceCitation(citation)).toBe(true);
    }
  });

  it("does not load source for references until an actual read or citation needs that path", async () => {
    const page = await fixture(longSource).evidence.readSource({ path: sourcePath, endLine: 1 });
    const restored = fixture(longSource, [sourceReference(page)]);
    expect(
      await restored.evidence.verifyRequirementQuote({ documentId: "original", quote: "Keep" }),
    ).toBe(true);
    expect(restored.readFile).not.toHaveBeenCalled();
    const citation = {
      path: sourcePath,
      startLine: 1,
      endLine: 1,
      excerpt: page.content.slice(0, 80),
    };
    expect(
      await Promise.all([
        restored.evidence.verifySourceCitation(citation),
        restored.evidence.verifySourceCitation(citation),
      ]),
    ).toEqual([true, true]);
    expect(restored.readFile).toHaveBeenCalledTimes(1);
  });

  it("retains current byte verification and Stop even when an exact old reference is supplied", async () => {
    const page = await fixture(longSource).evidence.readSource({ path: sourcePath, endLine: 1 });
    const citation = {
      path: sourcePath,
      startLine: 1,
      endLine: 1,
      excerpt: page.content.slice(0, 80),
    };
    await expect(
      fixture(longSource, [sourceReference(page)], {
        actualSource: `${longSource} changed`,
      }).evidence.verifySourceCitation(citation),
    ).rejects.toThrow("source changed");
    const controller = new AbortController();
    controller.abort(new Error("Stopped"));
    const restored = fixture(longSource, [sourceReference(page)], {
      abortSignal: controller.signal,
    });
    await expect(restored.evidence.verifySourceCitation(citation)).rejects.toThrow("Stopped");
    expect(restored.readFile).not.toHaveBeenCalled();
  });
});
