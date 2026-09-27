import { describe, expect, it } from "vitest";

import {
  boundedChangedAppTextExport,
  changedAppTextPaths,
  isCandidateExportTextPath,
  reviewableChanges,
} from "../../agent/tools/change_set_status";
import { assertExistingAppReviewScope } from "../repository/reviewed-change-set";

describe("reviewed candidate export", () => {
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
  it("keeps the review payload bounded and names every omitted changed file", async () => {
    const content = new Map([
      ["apps/replica/app/page.tsx", "updated page"],
      ["apps/replica/schema/release/large.json", "x".repeat(600 * 1024)],
    ]);
    const reads: string[] = [];
    const exported = await boundedChangedAppTextExport(
      [
        { kind: "modified", path: "apps/replica/app/page.tsx" },
        { kind: "modified", path: "apps/replica/schema/release/large.json" },
        { kind: "added", path: "apps/replica/public/logo.png" },
        { kind: "modified", path: "apps/other/schema/release/huge.json" },
      ],
      "replica",
      async (path) => {
        reads.push(path);
        return await Promise.resolve(content.get(path) ?? null);
      },
    );
    expect(reads).toEqual(["apps/replica/app/page.tsx", "apps/replica/schema/release/large.json"]);
    expect(exported.exportFiles).toEqual([
      { content: "updated page", path: "apps/replica/app/page.tsx" },
    ]);
    expect(exported.exportOmissions.map(({ path }) => path)).toEqual([
      "apps/replica/schema/release/large.json",
      "apps/replica/public/logo.png",
    ]);
    expect(exported.exportOmissions[0]?.reason).toContain("614400 bytes");
    expect(exported.exportOmissions[1]?.reason).toBe("changed non-text artifact");
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
