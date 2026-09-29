import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  changedAppTextExport,
  baselineReviewableChanges,
  changedAppTextPaths,
  isCandidateExportTextPath,
  reviewableChanges,
} from "../../agent/tools/change_set_status";
import { assertExistingAppReviewScope } from "../repository/reviewed-change-set";

const digest = (value: string) => createHash("sha256").update(value, "utf-8").digest("hex");

describe("reviewed candidate export", () => {
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
