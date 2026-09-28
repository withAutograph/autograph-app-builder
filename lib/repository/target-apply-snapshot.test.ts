import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import {
  inspectApplyOverlay,
  OVERLAY_SNAPSHOT_SCRIPT,
  reviewedOverlayTreeDigest,
} from "./target-apply";

it("keeps existing-app review stable across unrelated repository edits", () => {
  const appFile = { digest: "a".repeat(64), mode: "644", path: "apps/example/app/page.tsx" };
  const before = {
    files: [appFile, { digest: "b".repeat(64), mode: "644", path: ".config/app-specs/example.md" }],
    treeDigest: "before",
  };
  const after = {
    files: [appFile, { digest: "c".repeat(64), mode: "644", path: ".config/app-specs/example.md" }],
    treeDigest: "after",
  };
  expect(reviewedOverlayTreeDigest(before, "example", true)).toBe(
    reviewedOverlayTreeDigest(after, "example", true),
  );
  expect(reviewedOverlayTreeDigest(before, "example", false)).not.toBe(
    reviewedOverlayTreeDigest(after, "example", false),
  );
});

it("reports the source snapshot operation, cause, and repair when sandbox execution fails", async () => {
  const sandbox = {
    run: async () =>
      await Promise.resolve({ exitCode: 127, stderr: "bun: command not found", stdout: "" }),
  };
  await expect(inspectApplyOverlay(sandbox, "/workspace/repository")).rejects.toThrow(
    "Builder's source snapshot failed in /workspace/repository with exit 127. Cause: bun: command not found. Check the checkout, file permissions, and Bun runtime, then retry.",
  );
});

it("preserves full snapshot failure diagnostics while redacting secrets", async () => {
  const detail = `${"overlay snapshot detail ".repeat(70)} token=github_pat_12345678901234567890`;
  const sandbox = {
    run: async () => await Promise.resolve({ exitCode: 127, stderr: detail, stdout: "" }),
  };
  const failure = inspectApplyOverlay(sandbox, "/workspace/repository");

  await expect(failure).rejects.toThrow("token=[REDACTED]");
  await expect(failure).rejects.toThrow("overlay snapshot detail ".repeat(70));
});

it("keeps build output out of reviewed changes while retaining application source", () => {
  const root = mkdtempSync(path.join(tmpdir(), "app-builder-source-snapshot-"));
  try {
    const files = [
      "apps/example/app/page.tsx",
      "apps/example/.next/BUILD_ID",
      "apps/example/.next/server/app/page.js",
      ".next/cache/state.json",
      "apps/example/next.config.ts",
      "apps/example/.next-guide.md",
      ".git/index",
      ".turbo/cache/state.json",
      "apps/example/.turbo/turbo-test.log",
      "apps/example/node_modules/.vite/results.json",
      "target/debug/deps/schema_compiler.json",
      "packages/schema-compiler/target/debug/deps/schema_compiler.json",
      "apps/example/next-env.d.ts",
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
