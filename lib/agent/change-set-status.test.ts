import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { z } from "zod";

import changeSetStatus, {
  changedAppTextExport,
  baselineReviewableChanges,
  changedAppTextPaths,
  isCandidateExportTextPath,
  selectAppBaselineForReview,
  reviewableChanges,
  reviewExportChanges,
  assertReviewExportCursorSide,
  destinationReviewReadProgress,
  destinationReviewReadStatus,
} from "../../agent/tools/change_set_status";
import { overlayChanges } from "../repository/target-apply";
import { assertExistingAppReviewScope } from "../repository/reviewed-change-set";
import { assertCompleteGitHubDestinationReview } from "./workflow-state";

const digest = (value: string) => createHash("sha256").update(value, "utf-8").digest("hex");
const reviewInputSchema = (() => {
  const schema = changeSetStatus.inputSchema;
  if (!(schema instanceof z.ZodObject)) {
    throw new Error("The change-set tool requires its declared Zod input schema.");
  }
  return schema;
})();

describe("destination review progress readback", () => {
  const changeSetDigest = digest("current diff");
  const cursor = {
    changeIndex: 0,
    changeSetDigest,
    digest: digest("file"),
    offsetBytes: 12,
    path: "apps/replica/file.ts",
    side: "before" as const,
  };

  it("returns first-page calls without awarding unobserved coverage", () => {
    const status = destinationReviewReadStatus({ changeSetDigest });
    expect(status.changeSetDigest).toBe(changeSetDigest);
    for (const side of ["before", "after"] as const) {
      expect(status.sides[side]).toEqual({
        complete: false,
        nextCall: { contentSide: side, includeContent: true, view: "changes" },
        readable: null,
      });
      expect(reviewInputSchema.parse(status.sides[side].nextCall)).toEqual(
        status.sides[side].nextCall,
      );
    }
    expect(reviewInputSchema.parse({ view: "read-progress" })).toMatchObject({
      view: "read-progress",
    });
  });

  it("recovers the exact saved next call after a consumed-cursor retry fails", () => {
    const first = destinationReviewReadProgress({
      changeSetDigest,
      nextCursor: cursor,
      readable: true,
      side: "before",
    });
    const nextCursor = { ...cursor, offsetBytes: 24 };
    const advanced = destinationReviewReadProgress({
      changeSetDigest,
      cursor,
      nextCursor,
      previous: first,
      readable: true,
      side: "before",
    });
    const beforeReadback = structuredClone(advanced);
    expect(() =>
      destinationReviewReadProgress({
        changeSetDigest,
        cursor,
        nextCursor,
        previous: advanced,
        readable: true,
        side: "before",
      }),
    ).toThrow("saved cursor");
    const status = destinationReviewReadStatus({ changeSetDigest, previous: advanced });
    const { nextCall } = status.sides.before;
    expect(nextCall).toEqual({
      contentCursor: nextCursor,
      contentSide: "before",
      includeContent: true,
      view: "changes",
    });
    expect(reviewInputSchema.parse(nextCall)).toEqual(nextCall);
    expect(advanced).toEqual(beforeReadback);
    expect(() => {
      assertCompleteGitHubDestinationReview(advanced, changeSetDigest);
    }).toThrow("both complete sides");
    const beforeComplete = destinationReviewReadProgress({
      changeSetDigest,
      cursor: nextCall?.contentCursor,
      previous: advanced,
      readable: true,
      side: "before",
    });
    expect(
      destinationReviewReadStatus({ changeSetDigest, previous: beforeComplete }).sides.before,
    ).toEqual({ complete: true, nextCall: null, readable: true });
    expect(() => {
      assertCompleteGitHubDestinationReview(beforeComplete, changeSetDigest);
    }).toThrow("both complete sides");
    const complete = destinationReviewReadProgress({
      changeSetDigest,
      previous: beforeComplete,
      readable: true,
      side: "after",
    });
    expect(() => {
      assertCompleteGitHubDestinationReview(complete, changeSetDigest);
    }).not.toThrow();
  });

  it("does not expose stale completed coverage or cursors for a changed diff", () => {
    const previous = {
      afterComplete: true,
      afterReadable: true,
      beforeComplete: true,
      beforeCursor: cursor,
      beforeReadable: true,
      changeSetDigest,
    };
    const status = destinationReviewReadStatus({
      changeSetDigest: digest("new diff"),
      previous,
    });
    expect(status.sides.before.complete).toBe(false);
    expect(status.sides.after.complete).toBe(false);
    expect(status.sides.before.readable).toBeNull();
    expect(status.sides.before.nextCall).not.toHaveProperty("contentCursor");
    expect(previous.beforeComplete).toBe(true);
    expect(previous.beforeCursor).toEqual(cursor);
  });

  it("preserves unreadable state until actual content is read again", () => {
    const previous = destinationReviewReadProgress({
      changeSetDigest,
      readable: false,
      side: "before",
    });
    const status = destinationReviewReadStatus({ changeSetDigest, previous });
    expect(status.sides.before).toMatchObject({ complete: false, readable: false });
    expect(status.sides.before.nextCall).not.toHaveProperty("contentCursor");
    expect(previous.beforeComplete).toBe(false);
    expect(previous.beforeReadable).toBe(false);
  });

  it("copies saved cursors without sharing mutable references across readbacks", () => {
    const previous = destinationReviewReadProgress({
      changeSetDigest,
      nextCursor: cursor,
      readable: true,
      side: "before",
    });
    const status = destinationReviewReadStatus({ changeSetDigest, previous });
    if (status.sides.before.nextCall?.contentCursor !== undefined) {
      status.sides.before.nextCall.contentCursor.offsetBytes = 999;
    }
    expect(previous.beforeCursor?.offsetBytes).toBe(12);
    expect(
      destinationReviewReadStatus({ changeSetDigest, previous }).sides.before.nextCall,
    ).toHaveProperty("contentCursor.offsetBytes", 12);
  });
});

describe("reviewed candidate export", () => {
  it("exports before content for modifications and deletions while identifying additions as absent", async () => {
    const changes = [
      {
        after: { digest: digest("new"), mode: "644" },
        kind: "added" as const,
        path: "apps/replica/added.ts",
      },
      {
        before: { digest: digest("old deleted"), mode: "644" },
        kind: "deleted" as const,
        path: "apps/replica/deleted.ts",
      },
      {
        after: { digest: digest("new modified"), mode: "644" },
        before: { digest: digest("old modified"), mode: "644" },
        kind: "modified" as const,
        path: "apps/replica/modified.ts",
      },
    ];
    const contents = new Map([
      ["apps/replica/deleted.ts", "old deleted"],
      ["apps/replica/modified.ts", "old modified"],
    ]);
    const exported = await changedAppTextExport(
      reviewExportChanges(changes, "before"),
      "replica",
      async (path) => await Promise.resolve(contents.get(path) ?? null),
    );
    expect(exported.exportFiles.map(({ path, content }) => ({ content, path }))).toEqual([
      { content: "old deleted", path: "apps/replica/deleted.ts" },
      { content: "old modified", path: "apps/replica/modified.ts" },
    ]);
    expect(changedAppTextPaths(reviewExportChanges(changes, "after"), "replica")).toEqual([
      "apps/replica/added.ts",
      "apps/replica/modified.ts",
    ]);
  });

  it("binds content cursors to their side and preserves legacy after cursors", () => {
    const cursor = { digest: digest("same bytes"), offsetBytes: 12, path: "apps/replica/file.ts" };
    expect(() => {
      assertReviewExportCursorSide(cursor, "after");
    }).not.toThrow();
    expect(() => {
      assertReviewExportCursorSide(cursor, "before");
    }).toThrow("other content side");
    expect(() => {
      assertReviewExportCursorSide({ ...cursor, side: "before" }, "after");
    }).toThrow("other content side");
  });

  it("records both complete destination sides only after following each saved cursor", () => {
    const cursor = {
      digest: digest("base"),
      offsetBytes: 12,
      path: "apps/replica/file.ts",
      side: "before" as const,
    };
    const first = destinationReviewReadProgress({
      changeSetDigest: "review",
      nextCursor: cursor,
      readable: true,
      side: "before",
    });
    expect(first.beforeComplete).toBe(false);
    expect(() =>
      destinationReviewReadProgress({
        changeSetDigest: "review",
        cursor: { ...cursor, offsetBytes: 13 },
        previous: first,
        readable: true,
        side: "before",
      }),
    ).toThrow("saved cursor");
    const before = destinationReviewReadProgress({
      changeSetDigest: "review",
      cursor,
      previous: first,
      readable: true,
      side: "before",
    });
    const complete = destinationReviewReadProgress({
      changeSetDigest: "review",
      previous: before,
      readable: true,
      side: "after",
    });
    expect(complete).toMatchObject({ afterComplete: true, beforeComplete: true });
    expect(
      destinationReviewReadProgress({
        changeSetDigest: "changed-review",
        previous: complete,
        readable: false,
        side: "before",
      }),
    ).toMatchObject({ afterComplete: false, beforeComplete: false });
  });
  it.each(["before", "after"] as const)(
    "keeps an unreadable early %s page incomplete until the side is restarted",
    (side) => {
      const cursor = {
        digest: digest("page"),
        offsetBytes: 12,
        path: "apps/replica/file.ts",
        side,
      };
      const first = destinationReviewReadProgress({
        changeSetDigest: "review",
        nextCursor: cursor,
        readable: false,
        side,
      });
      const last = destinationReviewReadProgress({
        changeSetDigest: "review",
        cursor,
        previous: first,
        readable: true,
        side,
      });
      const completeKey = side === "before" ? "beforeComplete" : "afterComplete";
      const readableKey = side === "before" ? "beforeReadable" : "afterReadable";
      expect(last[completeKey]).toBe(false);
      expect(last[readableKey]).toBe(false);
      const restart = destinationReviewReadProgress({
        changeSetDigest: "review",
        nextCursor: cursor,
        previous: last,
        readable: true,
        side,
      });
      expect(restart[completeKey]).toBe(false);
      expect(restart[readableKey]).toBe(true);
      const complete = destinationReviewReadProgress({
        changeSetDigest: "review",
        cursor,
        previous: restart,
        readable: true,
        side,
      });
      expect(complete[completeKey]).toBe(true);
      expect(complete[readableKey]).toBe(true);
    },
  );

  it("keeps baseline review limited to the app and its conventional specs while excluding tool output", () => {
    const changes = [
      "apps/replica/app/page.tsx",
      ".config/app-specs/replica.cue",
      "config/routing.json",
      "apps/other/app/page.tsx",
      "apps/replica/.next/server/page.js",
      "apps/replica/next-env.d.ts",
    ].map((path) => ({ kind: "modified" as const, path }));
    expect(baselineReviewableChanges(changes, "replica").map(({ path }) => path)).toEqual([
      "apps/replica/app/page.tsx",
      ".config/app-specs/replica.cue",
    ]);
  });
  it("keeps platform-baseline app changes after source refresh and gates stale planning specs", () => {
    const sourceSha = "b".repeat(40);
    const baseline = {
      receipt: {
        appId: "replica",
        platform: { commitSha: "a".repeat(40) },
      },
      selection: {},
    };
    const pagePath = "apps/replica/app/page.tsx";
    const specPath = ".config/app-specs/replica.md";
    const changes = overlayChanges(
      {
        files: [
          { digest: digest("platform N page"), mode: "644", path: pagePath },
          { digest: digest("platform N spec"), mode: "644", path: specPath },
        ],
        treeDigest: "platform-N",
      },
      {
        files: [
          {
            digest: digest("projected H page kept unchanged by apply"),
            mode: "644",
            path: pagePath,
          },
          { digest: digest("current spec"), mode: "644", path: specPath },
        ],
        treeDigest: "observed-A",
      },
    );

    const selected = selectAppBaselineForReview(baseline, "replica");
    expect(selected).toBe(baseline);
    expect(
      baselineReviewableChanges(
        changes,
        "replica",
        selected?.receipt?.platform.commitSha === sourceSha,
      ).map(({ path }) => path),
    ).toEqual([pagePath]);
    expect(changes.find(({ path }) => path === pagePath)).toMatchObject({
      before: { digest: digest("platform N page") },
      kind: "modified",
      path: pagePath,
    });

    expect(
      baselineReviewableChanges(
        changes,
        "replica",
        selected?.receipt?.platform.commitSha === "a".repeat(40),
      ).map(({ path }) => path),
    ).toEqual([specPath, pagePath]);
  });
  it("includes baseline-owned conventional spec changes in the reviewed export", async () => {
    const specPath = ".config/app-specs/replica.cue";
    const exported = await changedAppTextExport(
      [
        {
          after: { digest: digest("Builder authored spec"), mode: "644" },
          kind: "modified",
          path: specPath,
        },
        {
          after: { digest: digest("unrelated"), mode: "644" },
          kind: "modified",
          path: ".config/app-specs/other.cue",
        },
      ],
      "replica",
      async () => await Promise.resolve("Builder authored spec"),
      { extraPaths: [specPath] },
    );
    expect(exported.exportFiles.map(({ path }) => path)).toEqual([specPath]);
  });
  it("rejects a legacy existing-repository review that includes planning or build output", () => {
    const review = {
      approvedPaths: [".config/app-specs/replica.md", "apps/replica/app/page.tsx"],
    };
    expect(() => {
      assertExistingAppReviewScope(review, "replica", "existing-repository");
    }).toThrow(".config/app-specs/replica.md, outside apps/replica/");
    expect(() => {
      assertExistingAppReviewScope(review, "replica", "fresh-template");
    }).not.toThrow();
    review.approvedPaths = ["apps/replica/app/page.tsx"];
    expect(() => {
      assertExistingAppReviewScope(review, "replica", "existing-repository");
    }).not.toThrow();
  });
  it("reviews only selected existing-app source and omits tooling output", () => {
    const changes = [
      { kind: "modified" as const, path: "apps/replica/app/page.tsx" },
      { kind: "modified" as const, path: "apps/other/app/page.tsx" },
      { kind: "modified" as const, path: ".config/app-specs/replica.md" },
      { kind: "modified" as const, path: ".git/index" },
      { kind: "added" as const, path: "target/debug/build-output" },
      { kind: "added" as const, path: "apps/replica/.turbo/turbo-test.log" },
      { kind: "added" as const, path: "apps/replica/node_modules/.vite/results.json" },
      { kind: "modified" as const, path: "apps/replica/next-env.d.ts" },
      { kind: "modified" as const, path: "apps/replica/schema/release/release-manifest.json" },
    ];
    expect(reviewableChanges(changes, "replica", true).map(({ path }) => path)).toEqual([
      "apps/replica/app/page.tsx",
      "apps/replica/schema/release/release-manifest.json",
    ]);
    expect(reviewableChanges(changes, "replica", false).map(({ path }) => path)).toEqual([
      "apps/replica/app/page.tsx",
      "apps/other/app/page.tsx",
      ".config/app-specs/replica.md",
      "apps/replica/schema/release/release-manifest.json",
    ]);
  });
  it("exports only changed app-owned text files, not the entire schema history", () => {
    expect(
      changedAppTextPaths(
        [
          { kind: "modified", path: "apps/replica/app/page.tsx" },
          { kind: "added", path: "apps/replica/app/actions.ts" },
          { kind: "deleted", path: "apps/replica/app/old.ts" },
          { kind: "modified", path: "apps/other/app/page.tsx" },
          { kind: "modified", path: "apps/replica/public/logo.png" },
        ],
        "replica",
      ),
    ).toEqual(["apps/replica/app/page.tsx", "apps/replica/app/actions.ts"]);
  });
  it("exports large changed files in digest-bound chunks without dropping them", async () => {
    const content = new Map([
      ["apps/replica/app/page.tsx", "updated page"],
      ["apps/replica/schema/release/large.json", "é".repeat(6 * 1024 * 1024)],
    ]);
    const reads: string[] = [];
    const changes = [
      {
        after: { digest: digest("updated page"), mode: "100644" },
        kind: "modified" as const,
        path: "apps/replica/app/page.tsx",
      },
      {
        after: {
          digest: digest(content.get("apps/replica/schema/release/large.json") ?? ""),
          mode: "100644",
        },
        kind: "modified" as const,
        path: "apps/replica/schema/release/large.json",
      },
      {
        after: { digest: "unused", mode: "100644" },
        kind: "added" as const,
        path: "apps/replica/public/logo.png",
      },
      {
        after: { digest: "unused", mode: "100644" },
        kind: "modified" as const,
        path: "apps/other/schema/release/huge.json",
      },
    ];
    const exported = await changedAppTextExport(changes, "replica", async (path) => {
      reads.push(path);
      return await Promise.resolve(content.get(path) ?? null);
    });
    expect(reads).toEqual(["apps/replica/app/page.tsx", "apps/replica/schema/release/large.json"]);
    expect(exported.exportFiles[0]).toMatchObject({
      content: "updated page",
      digest: digest("updated page"),
      offsetBytes: 0,
      path: "apps/replica/app/page.tsx",
    });
    expect(exported.exportFiles[1]?.path).toBe("apps/replica/schema/release/large.json");
    expect(exported.exportFiles[1]?.content.length).toBeLessThan(
      content.get("apps/replica/schema/release/large.json")?.length ?? 0,
    );
    expect(exported.contentCursor).toMatchObject({
      digest: digest(content.get("apps/replica/schema/release/large.json") ?? ""),
      path: "apps/replica/schema/release/large.json",
    });
    expect(exported.exportOmissions).toEqual([
      { path: "apps/replica/public/logo.png", reason: "changed non-text artifact" },
    ]);
    const continuation = await changedAppTextExport(
      changes,
      "replica",
      async (path) => await Promise.resolve(content.get(path) ?? null),
      {
        cursor: exported.contentCursor,
      },
    );
    expect(continuation.exportFiles[0]?.offsetBytes).toBe(exported.contentCursor?.offsetBytes);
    expect(continuation.exportFiles[0]?.digest).toBe(
      digest(content.get("apps/replica/schema/release/large.json") ?? ""),
    );
  });
  it("rejects a changed reviewed file and an altered chunk cursor digest", async () => {
    const expected = "reviewed";
    const change = {
      after: { digest: createHash("sha256").update(expected).digest("hex"), mode: "100644" },
      kind: "modified" as const,
      path: "apps/replica/app/page.tsx",
    };
    await expect(
      changedAppTextExport([change], "replica", async () => await Promise.resolve("changed")),
    ).rejects.toThrow("changed during export");
    await expect(
      changedAppTextExport([change], "replica", async () => await Promise.resolve(expected), {
        cursor: { digest: "0".repeat(64), offsetBytes: 0, path: change.path },
      }),
    ).rejects.toThrow("cursor digest does not match");
  });
  it.each([
    "apps/replica/app/page.tsx",
    "apps/replica/package.json",
    "apps/replica/next.config.mjs",
    "apps/replica/Dockerfile",
    "apps/replica/.gitignore",
    "apps/replica/hk.pkl",
  ])("includes auditable text source %s", (path) => {
    expect(isCandidateExportTextPath(path)).toBe(true);
  });

  it.each([
    "apps/replica/public/logo.png",
    "apps/replica/font.woff2",
    "apps/replica/.next/server/app/page.js",
    "apps/replica/node_modules/.vite/vitest/results.json",
    "apps/replica/dist/manifest.json",
    "apps/replica/coverage/coverage-final.json",
    "apps/replica/storybook-static/index.html",
  ])("omits non-text artifact %s", (path) => {
    expect(isCandidateExportTextPath(path)).toBe(false);
  });
});
