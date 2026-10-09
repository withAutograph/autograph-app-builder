import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { readChangeSetReviewPage, resolveChangeSetReviewCursor } from "./change-set-review-pages";
import type { ChangeSetReviewCursor, ChangeSetReviewPageInput } from "./change-set-review-pages";
import { EVE_MAX_PAYLOAD_BYTES, serializedNativeActionResultBytes } from "../eve/payload-envelope";
import { destinationReviewReadProgress } from "../../agent/tools/change_set_status";
import type { OverlayChange } from "../repository/target-apply";

const digest = (content: string) => createHash("sha256").update(content, "utf-8").digest("hex");
const metadata = { callId: "call_owned", toolName: "change_set_status", turnId: "turn_owned" };
const source = (changes: readonly OverlayChange[]): ChangeSetReviewPageInput["changeSet"] => ({
  changedContentDigest: digest(JSON.stringify(changes)),
  changes,
  digest: digest(`review:${JSON.stringify(changes)}`),
  postTreeDigest: digest("post"),
  preTreeDigest: digest("pre"),
  sourceReceiptDigest: digest("original-source"),
  sourceSha: "79952fedea119831cc30beab504d3d7d6b271209",
  sourceTree: "1".repeat(40),
  validationDigest: digest("validated"),
});
const inputFor = (
  changes: readonly OverlayChange[],
  contents: ReadonlyMap<string, string>,
  maxBytes = 2400,
): ChangeSetReviewPageInput => ({
  changeSet: source(changes),
  includeContent: true,
  isTextPath: (path) => path.endsWith(".ts"),
  maxBytes,
  metadata,
  readText: async (path) => await Promise.resolve(contents.get(path) ?? null),
  reviewed: false,
  sessionId: "original-session",
  side: "after",
});

describe("native review result pages", () => {
  it("pages a source result larger than the provider frame and reconstructs every UTF-8 byte", async () => {
    const path = "apps/replica/schema/data-server.ts";
    const content = 'export const value = "\\\n☀️";\n'.repeat(500_000);
    const input = inputFor(
      [{ after: { digest: digest(content), mode: "644" }, kind: "added", path }],
      new Map([[path, content]]),
      EVE_MAX_PAYLOAD_BYTES,
    );
    expect(serializedNativeActionResultBytes({ content }, metadata)).toBeGreaterThan(
      EVE_MAX_PAYLOAD_BYTES,
    );
    let cursor: ChangeSetReviewCursor | undefined;
    const pieces: string[] = [];
    let pageCount = 0;
    do {
      // oxlint-disable-next-line eslint/no-await-in-loop -- A saved cursor is the only next page.
      const page = await readChangeSetReviewPage({ ...input, cursor });
      expect(serializedNativeActionResultBytes(page, metadata)).toBeLessThanOrEqual(
        EVE_MAX_PAYLOAD_BYTES,
      );
      expect(page.reviewReference.sessionId).toBe("original-session");
      pieces.push(...page.exportFiles.map((file) => file.content));
      cursor = page.contentCursor;
      pageCount += 1;
    } while (cursor !== undefined);
    expect(pageCount).toBeGreaterThan(1);
    expect(pieces.join("")).toBe(content);
    expect(digest(pieces.join(""))).toBe(digest(content));
  });

  it("pages every change's metadata without narrowing the selected app", async () => {
    const changes = Array.from({ length: 80 }, (_, index) => ({
      after: { digest: digest(`file${index}`), mode: "644" },
      kind: "added" as const,
      path: `apps/replica/file-${index}.ts`,
    }));
    const input = { ...inputFor(changes, new Map()), includeContent: false };
    const paths: string[] = [];
    let cursor: ChangeSetReviewCursor | undefined;
    do {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Metadata pages retain ordered continuation.
      const page = await readChangeSetReviewPage({ ...input, cursor });
      expect(serializedNativeActionResultBytes(page, metadata)).toBeLessThanOrEqual(
        input.maxBytes ?? EVE_MAX_PAYLOAD_BYTES,
      );
      paths.push(...page.approvedPaths);
      cursor = page.contentCursor;
    } while (cursor !== undefined);
    expect(paths).toEqual(changes.map((change) => change.path));
  });

  it.each(["text", "binary", "missing", "empty"] as const)(
    "defers a %s change when its body cannot fit after prior file content",
    async (kind) => {
      const firstPath = "apps/replica/a.ts";
      const secondPath = kind === "binary" ? "apps/replica/b.png" : "apps/replica/b.ts";
      const finalPath = "apps/replica/c.ts";
      const firstContent = "a".repeat(1400);
      const secondContent = kind === "empty" ? "" : "second source";
      const changes = [
        {
          after: { digest: digest(firstContent), mode: "644" },
          kind: "added" as const,
          path: firstPath,
        },
        {
          after: { digest: digest(secondContent), mode: "644" },
          kind: "added" as const,
          path: secondPath,
        },
        {
          before: { digest: digest("removed"), mode: "644" },
          kind: "deleted" as const,
          path: finalPath,
        },
      ];
      const contents = new Map([[firstPath, firstContent]]);
      if (kind !== "missing" && kind !== "binary") {
        contents.set(secondPath, secondContent);
      }
      const trial = await readChangeSetReviewPage(inputFor(changes, contents, 20_000));
      const secondMetadataOnly = {
        ...trial,
        absentPaths: [],
        approvedPaths: [firstPath, secondPath],
        changes: changes.slice(0, 2),
        contentCursor: {
          changeIndex: 2,
          changeSetDigest: source(changes).digest,
          digest: source(changes).digest,
          offsetBytes: 0,
          path: finalPath,
          side: "after" as const,
        },
        exportFiles: trial.exportFiles.filter((file) => file.path === firstPath),
        exportOmissions: [],
      };
      const firstComplete = {
        ...secondMetadataOnly,
        approvedPaths: [firstPath],
        changes: [changes[0]],
        contentCursor: {
          changeIndex: 1,
          changeSetDigest: inputFor(changes, contents).changeSet.digest,
          digest: digest(secondContent),
          offsetBytes: 0,
          path: secondPath,
          side: "after" as const,
        },
      };
      const budget = Math.max(
        serializedNativeActionResultBytes(secondMetadataOnly, metadata),
        serializedNativeActionResultBytes(firstComplete, metadata),
      );
      const input = inputFor(changes, contents, budget);
      const first = await readChangeSetReviewPage(input);
      expect(first.approvedPaths).toEqual([firstPath]);
      expect(first.exportFiles[0]?.content).toBe(firstContent);
      expect(first.contentCursor?.path).toBe(secondPath);
      const next = await readChangeSetReviewPage({ ...input, cursor: first.contentCursor });
      expect(next.approvedPaths).toEqual([secondPath, finalPath]);
      expect(next.contentCursor).toBeUndefined();
      if (kind === "binary" || kind === "missing") {
        expect(next.exportOmissions[0]?.path).toBe(secondPath);
      } else {
        expect(next.exportFiles[0]?.content).toBe(secondContent);
      }
      expect(serializedNativeActionResultBytes(first, metadata)).toBeLessThanOrEqual(budget);
      expect(serializedNativeActionResultBytes(next, metadata)).toBeLessThanOrEqual(budget);
    },
  );

  it("preserves before/after absence and binary omission metadata", async () => {
    const changes: OverlayChange[] = [
      { after: { digest: digest("new"), mode: "644" }, kind: "added", path: "apps/replica/new.ts" },
      {
        before: { digest: digest("binary"), mode: "644" },
        kind: "deleted",
        path: "apps/replica/old.png",
      },
    ];
    const before = await readChangeSetReviewPage({
      ...inputFor(changes, new Map()),
      side: "before",
    });
    expect(before.absentPaths).toEqual(["apps/replica/new.ts"]);
    expect(before.exportOmissions).toEqual([
      { path: "apps/replica/old.png", reason: "changed non-text artifact" },
    ]);
    const after = await readChangeSetReviewPage(
      inputFor(changes, new Map([["apps/replica/new.ts", "new"]])),
    );
    expect(after.absentPaths).toEqual(["apps/replica/old.png"]);
  });

  it("rejects stale/index-mutated/other-side cursors and supports legacy after continuations", () => {
    const changeSet = source([
      { after: { digest: digest("text"), mode: "644" }, kind: "added", path: "apps/replica/a.ts" },
    ]);
    const legacy = { digest: digest("text"), offsetBytes: 0, path: "apps/replica/a.ts" };
    expect(resolveChangeSetReviewCursor({ changeSet, cursor: legacy, side: "after" })).toEqual({
      index: 0,
      offsetBytes: 0,
    });
    expect(() =>
      resolveChangeSetReviewCursor({ changeSet, cursor: legacy, side: "before" }),
    ).toThrow("other content side");
    expect(() =>
      resolveChangeSetReviewCursor({
        changeSet,
        cursor: { ...legacy, changeIndex: 5 },
        side: "after",
      }),
    ).toThrow("recorded change path");
    expect(() =>
      resolveChangeSetReviewCursor({
        changeSet,
        cursor: { ...legacy, changeSetDigest: digest("stale") },
        side: "after",
      }),
    ).toThrow("changed review");
  });

  it("keeps missing text sticky across metadata/content continuation and clears it only on restart", async () => {
    const firstPath = "apps/replica/a.ts";
    const changes = [
      { after: { digest: digest("a"), mode: "644" }, kind: "added" as const, path: firstPath },
      {
        after: { digest: digest("b".repeat(5000)), mode: "644" },
        kind: "added" as const,
        path: "apps/replica/b.ts",
      },
    ];
    const input = inputFor(changes, new Map([["apps/replica/b.ts", "b".repeat(5000)]]));
    const first = await readChangeSetReviewPage(input);
    expect(first.exportOmissions[0]?.path).toBe(firstPath);
    let progress = destinationReviewReadProgress({
      changeSetDigest: input.changeSet.digest,
      nextCursor: first.contentCursor,
      readable: false,
      side: "after",
    });
    let cursor = first.contentCursor;
    while (cursor !== undefined) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Continuation must retain prior omission state.
      const page = await readChangeSetReviewPage({ ...input, cursor });
      progress = destinationReviewReadProgress({
        changeSetDigest: input.changeSet.digest,
        cursor,
        nextCursor: page.contentCursor,
        previous: progress,
        readable: true,
        side: "after",
      });
      cursor = page.contentCursor;
    }
    expect(progress.afterComplete).toBe(false);
    expect(progress.afterReadable).toBe(false);
  });
});
