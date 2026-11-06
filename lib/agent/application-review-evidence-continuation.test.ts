import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createApplicationReviewEvidence } from "./application-review-evidence";
import type { ApplicationReviewEvidence } from "./application-source-review";
import type { ProductSourceReviewInput } from "./product-source-review";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const sourcePath = "apps/example/source.ts";
const reviewInput: ProductSourceReviewInput = {
  appSpec: "Keep the requested source behavior.",
  appSpecDigest: "spec",
  clarifications: [],
  files: [],
  omissions: [],
  originalRequest: "Keep the requested source behavior.",
  sourceDigest: "source",
};
const sourceReference = (result: Awaited<ReturnType<ApplicationReviewEvidence["readSource"]>>) => ({
  contentDigest: digest(result.content),
  digest: result.digest,
  endColumn: result.endColumn,
  endLine: result.endLine,
  kind: "source",
  nextCursor: result.nextCursor,
  path: result.path,
  startColumn: result.startColumn,
  startLine: result.startLine,
});
const fixture = (
  source: string,
  restoredSourceReads: readonly unknown[] = [],
  options: { abortSignal?: AbortSignal; actualSource?: string } = {},
) => {
  const readFile = vi.fn(async ({ path }: { path: string }) =>
    path === `repository/${sourcePath}`
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(options.actualSource ?? source));
            controller.close();
          },
        })
      : null,
  );
  const evidence = createApplicationReviewEvidence({
    abortSignal: options.abortSignal,
    applyRoot: "/workspace/repository",
    changedPaths: [sourcePath],
    observed: {
      files: [{ digest: digest(source), mode: "644", path: sourcePath }],
      treeDigest: "observed",
    },
    restoredSourceReads,
    reviewInput,
    sandbox: { readFile },
    visiblePaths: [sourcePath],
  });
  return { evidence, readFile };
};
const longSource = Array.from({ length: 7000 }, (_, index) => `value_${index}_🚀`).join(" ");

describe("durable review source citation windows", () => {
  it("restores partial long-line citations from exact private references after a new round", async () => {
    const first = fixture(longSource);
    const page = await first.evidence.readSource({
      cursor: { column: longSource.indexOf("value_100_") + 1, endLine: 1, line: 1 },
      path: sourcePath,
    });
    const citation = {
      endLine: 1,
      excerpt: page.content.slice(0, 80),
      path: sourcePath,
      startLine: 1,
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
        endLine: lastLine,
        excerpt: `${lastLine}_tail`,
        path: sourcePath,
        startLine: lastLine,
      }),
    ).toBe(true);
    expect(
      await restored.evidence.verifySourceCitation({
        endLine: lastLine + 1,
        excerpt: `${lastLine + 1}_tail`,
        path: sourcePath,
        startLine: lastLine + 1,
      }),
    ).toBe(false);
  });

  it("ignores mismatched or malformed references while keeping fresh source reads available", async () => {
    const page = await fixture(longSource).evidence.readSource({ endLine: 1, path: sourcePath });
    const reference = sourceReference(page);
    const citation = {
      endLine: 1,
      excerpt: page.content.slice(0, 80),
      path: sourcePath,
      startLine: 1,
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
      await restored.evidence.readSource({ endLine: 1, path: sourcePath });
      // oxlint-disable-next-line eslint/no-await-in-loop -- Verify the concrete correcting read, not a source-shape assertion.
      expect(await restored.evidence.verifySourceCitation(citation)).toBe(true);
    }
  });

  it("does not load source for references until an actual read or citation needs that path", async () => {
    const page = await fixture(longSource).evidence.readSource({ endLine: 1, path: sourcePath });
    const restored = fixture(longSource, [sourceReference(page)]);
    expect(
      await restored.evidence.verifyRequirementQuote({ documentId: "original", quote: "Keep" }),
    ).toBe(true);
    expect(restored.readFile).not.toHaveBeenCalled();
    const citation = {
      endLine: 1,
      excerpt: page.content.slice(0, 80),
      path: sourcePath,
      startLine: 1,
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
    const page = await fixture(longSource).evidence.readSource({ endLine: 1, path: sourcePath });
    const citation = {
      endLine: 1,
      excerpt: page.content.slice(0, 80),
      path: sourcePath,
      startLine: 1,
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
