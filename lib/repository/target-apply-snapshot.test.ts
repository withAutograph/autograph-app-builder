import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import { OVERLAY_SNAPSHOT_SCRIPT } from "./target-apply";

it("keeps Next runtime output out of reviewed changes while retaining application source", () => {
  const root = mkdtempSync(path.join(tmpdir(), "app-builder-source-snapshot-"));
  try {
    const files = [
      "apps/example/app/page.tsx",
      "apps/example/.next/BUILD_ID",
      "apps/example/.next/server/app/page.js",
      ".next/cache/state.json",
      "apps/example/next.config.ts",
      "apps/example/.next-guide.md",
    ];
    for (const file of files) {
      mkdirSync(path.join(root, file, ".."), { recursive: true });
      writeFileSync(path.join(root, file), file);
    }
    const output = execFileSync(process.execPath, ["-e", OVERLAY_SNAPSHOT_SCRIPT], {
      cwd: root,
      encoding: "utf-8",
    });
    expect(
      output
        .trim()
        .split("\n")
        .map((line) => line.split("\t")[2]),
    ).toEqual([
      "apps/example/.next-guide.md",
      "apps/example/app/page.tsx",
      "apps/example/next.config.ts",
    ]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
