import { localPlanningSourceArchiveFixture as fixture } from "./local-planning-source-test-fixture";
/* oxlint-disable eslint/require-await -- The fixture executes the real archive/Git/merge programs; immediate async filesystem ports model the provider API. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { captureLocalPlanningSource, reconcileLocalPlanningSource } from "./local-planning-source";
import { prepareDevelopmentSandboxWorkspace } from "./supported-template";

test("normal file-archive preparation recovers its proven original Git base and retains app/data/cache during shared replan", async () => {
  const f = await fixture();
  try {
    expect(existsSync(path.join(f.candidate, ".git"))).toBe(false);
    f.write(f.source, "shared.txt", "current shared source\n");
    f.git("add", "shared.txt");
    f.git("commit", "--quiet", "-m", "shared repair");
    f.write(f.source, "dirty-platform.txt", "captured uncommitted repair\n");
    const capture = await captureLocalPlanningSource(f.source, f.original.sourceSha);
    try {
      const result = await reconcileLocalPlanningSource({
        appId: "example",
        assertCurrent: () => {},
        callId: "normal-replan",
        capture,
        originalSourceSha: f.original.sourceSha,
        originalWorkspaceDigest: f.original.workspaceDigest,
        receipt: {
          eligibilityDigest: capture.generation.eligibilityDigest,
          sourceSha: capture.sourceSha,
          sourceTree: capture.generation.generation,
        },
        sandbox: f.sandbox,
        sessionId: "saved-session",
        workspaceId: f.original.workspaceId,
      });
      expect(readFileSync(path.join(f.candidate, "shared.txt"), "utf-8")).toBe(
        "current shared source\n",
      );
      expect(readFileSync(path.join(f.candidate, "dirty-platform.txt"), "utf-8")).toBe(
        "captured uncommitted repair\n",
      );
      for (const [file, bytes] of [
        ["apps/example/app/page.tsx", "saved private app\n"],
        ["apps/example/.config/mise/tasks/check", "saved app task\n"],
        ["apps/example/schema/release/v1/release.json", "saved immutable release\n"],
        [".config/app-specs/example.md", "saved product\n"],
        [".env.local", "private retained\n"],
        ["node_modules/cache", "retained dependency cache\n"],
      ]) {
        expect(readFileSync(path.join(f.candidate, file), "utf-8")).toBe(bytes);
      }
      const saved = execFileSync(
        "/usr/bin/git",
        ["-C", f.candidate, "show", `${result.checkpointRef}:apps/example/app/page.tsx`],
        { encoding: "utf-8" },
      );
      expect(saved).toBe("saved private app\n");
      expect(result.workspace.workspaceId).toBe(f.original.workspaceId);
    } finally {
      capture.dispose();
    }
  } finally {
    f.dispose();
  }
});
test("a dirty original baseline with no matching retained Git artifact fails before candidate metadata or source changes", async () => {
  const f = await fixture();
  try {
    const capture = await captureLocalPlanningSource(f.source, f.original.sourceSha);
    try {
      await expect(
        reconcileLocalPlanningSource({
          appId: "example",
          assertCurrent: () => {},
          callId: "normal-replan",
          capture,
          originalSourceSha: f.original.sourceSha,
          originalWorkspaceDigest: "f".repeat(64),
          receipt: {
            eligibilityDigest: capture.generation.eligibilityDigest,
            sourceSha: capture.sourceSha,
            sourceTree: capture.generation.generation,
          },
          sandbox: f.sandbox,
          sessionId: "saved-session",
          workspaceId: f.original.workspaceId,
        }),
      ).rejects.toThrow("do not match");
      expect(existsSync(path.join(f.candidate, ".git"))).toBe(false);
      expect(readFileSync(path.join(f.candidate, "apps/example/app/page.tsx"), "utf-8")).toBe(
        "saved private app\n",
      );
    } finally {
      capture.dispose();
    }
  } finally {
    f.dispose();
  }
});
test("foreign workspace identity never initializes or rewrites the retained candidate", async () => {
  const f = await fixture();
  try {
    const capture = await captureLocalPlanningSource(f.source, f.original.sourceSha);
    try {
      await expect(
        reconcileLocalPlanningSource({
          appId: "example",
          assertCurrent: () => {},
          callId: "normal-replan",
          capture,
          originalSourceSha: f.original.sourceSha,
          originalWorkspaceDigest: f.original.workspaceDigest,
          receipt: {
            eligibilityDigest: capture.generation.eligibilityDigest,
            sourceSha: capture.sourceSha,
            sourceTree: capture.generation.generation,
          },
          sandbox: f.sandbox,
          sessionId: "saved-session",
          workspaceId: "foreign-workspace",
        }),
      ).rejects.toThrow("another saved workspace");
      expect(existsSync(path.join(f.candidate, ".git"))).toBe(false);
    } finally {
      capture.dispose();
    }
  } finally {
    f.dispose();
  }
});

test("archive recovery imports a clean merged host tree without excluded ancestor prerequisites", async () => {
  const f = await fixture();
  try {
    const branch = f.git("symbolic-ref", "--short", "HEAD");
    f.git("checkout", "--quiet", "-b", "independent-repair", `${f.original.sourceSha}^`);
    f.write(f.source, "independent.txt", "independent merged repair\n");
    f.git("add", ".");
    f.git("commit", "--quiet", "-m", "independent repair");
    f.git("checkout", "--quiet", branch);
    f.git("merge", "--quiet", "--no-ff", "independent-repair", "-m", "merge independent source");
    const reviewedHostHead = f.git("rev-parse", "HEAD");
    const capture = await captureLocalPlanningSource(f.source, f.original.sourceSha);
    try {
      expect(capture.sourceSha).toBe(reviewedHostHead);
      expect(capture.snapshotSha).not.toBe(reviewedHostHead);
      expect(capture.snapshotTree).toBe(f.git("rev-parse", "HEAD^{tree}"));
      const result = await reconcileLocalPlanningSource({
        appId: "example",
        assertCurrent: () => {},
        callId: "merged-replan",
        capture,
        originalSourceSha: f.original.sourceSha,
        originalWorkspaceDigest: f.original.workspaceDigest,
        receipt: {
          eligibilityDigest: capture.generation.eligibilityDigest,
          sourceSha: capture.sourceSha,
          sourceTree: capture.generation.generation,
        },
        sandbox: f.sandbox,
        sessionId: "saved-session",
        workspaceId: f.original.workspaceId,
      });
      expect(readFileSync(path.join(f.candidate, "independent.txt"), "utf-8")).toBe(
        "independent merged repair\n",
      );
      for (const [file, bytes] of [
        ["apps/example/app/page.tsx", "saved private app\n"],
        ["apps/example/.config/mise/tasks/check", "saved app task\n"],
        ["apps/example/schema/release/v1/release.json", "saved immutable release\n"],
        [".config/app-specs/example.md", "saved product\n"],
        [".env.local", "private retained\n"],
        ["node_modules/cache", "retained dependency cache\n"],
      ]) {
        expect(readFileSync(path.join(f.candidate, file), "utf-8")).toBe(bytes);
      }
      const parent = execFileSync(
        "/usr/bin/git",
        ["-C", f.candidate, "rev-parse", `${capture.snapshotSha}^`],
        { encoding: "utf-8" },
      ).trim();
      expect(parent).toBe(f.original.sourceSha);
      const retained = execFileSync(
        "/usr/bin/git",
        [
          "-C",
          f.candidate,
          "rev-parse",
          `refs/app-builder/reviewed-local-sources/${reviewedHostHead}`,
        ],
        { encoding: "utf-8" },
      ).trim();
      expect(retained).toBe(reviewedHostHead);
      f.write(f.source, "later.txt", "second ordinary source repair\n");
      f.git("add", "later.txt");
      f.git("commit", "--quiet", "-m", "second source repair");
      const later = await captureLocalPlanningSource(f.source, reviewedHostHead);
      try {
        await reconcileLocalPlanningSource({
          appId: "example",
          assertCurrent: () => {},
          callId: "repeat-replan",
          capture: later,
          originalSourceSha: reviewedHostHead,
          originalWorkspaceDigest: capture.generation.workspaceDigest,
          receipt: {
            eligibilityDigest: later.generation.eligibilityDigest,
            sourceSha: later.sourceSha,
            sourceTree: later.generation.generation,
          },
          sandbox: f.sandbox,
          sessionId: "saved-session",
          workspaceId: f.original.workspaceId,
        });
        expect(readFileSync(path.join(f.candidate, "later.txt"), "utf-8")).toBe(
          "second ordinary source repair\n",
        );
        expect(readFileSync(path.join(f.candidate, "apps/example/app/page.tsx"), "utf-8")).toBe(
          "saved private app\n",
        );
        expect(
          execFileSync(
            "/usr/bin/git",
            [
              "-C",
              f.candidate,
              "rev-parse",
              `refs/app-builder/reviewed-local-sources/${reviewedHostHead}`,
            ],
            { encoding: "utf-8" },
          ).trim(),
        ).toBe(reviewedHostHead);
      } finally {
        later.dispose();
      }

      expect(result.workspace.workspaceId).toBe(f.original.workspaceId);
    } finally {
      capture.dispose();
    }
  } finally {
    f.dispose();
  }
});
test("recorded dirty source transport is recognized without adopting mixed candidate files as a base", async () => {
  const f = await fixture();
  try {
    f.write(f.source, "shared.txt", "intermediate dirty shared source\n");
    const overlay = await prepareDevelopmentSandboxWorkspace(f.source, f.sandbox, "source-overlay");
    expect(overlay.sourceSha).toBe(f.original.sourceSha);
    expect(overlay.workspaceDigest).not.toBe(f.original.workspaceDigest);
    f.write(f.candidate, "authored-shared.txt", "actual authored shared extension\n");
    f.write(f.source, "shared.txt", "new shared source\n");
    const capture = await captureLocalPlanningSource(f.source, f.original.sourceSha);
    try {
      const result = await reconcileLocalPlanningSource({
        appId: "example",
        assertCurrent: () => {},
        callId: "recognized-source-overlay",
        capture,
        originalSourceSha: f.original.sourceSha,
        originalWorkspaceDigest: f.original.workspaceDigest,
        receipt: {
          eligibilityDigest: capture.generation.eligibilityDigest,
          sourceSha: capture.sourceSha,
          sourceTree: capture.generation.generation,
        },
        sandbox: f.sandbox,
        sessionId: "saved-session",
        sourceOverlay: { sourceSha: overlay.sourceSha, workspaceDigest: overlay.workspaceDigest },
        workspaceId: f.original.workspaceId,
      });
      expect(readFileSync(path.join(f.candidate, "shared.txt"), "utf-8")).toBe(
        "new shared source\n",
      );
      expect(readFileSync(path.join(f.candidate, "authored-shared.txt"), "utf-8")).toBe(
        "actual authored shared extension\n",
      );
      for (const [file, bytes] of [
        ["apps/example/app/page.tsx", "saved private app\n"],
        ["apps/example/.config/mise/tasks/check", "saved app task\n"],
        ["apps/example/schema/release/v1/release.json", "saved immutable release\n"],
        [".config/app-specs/example.md", "saved product\n"],
        [".env.local", "private retained\n"],
        ["node_modules/cache", "retained dependency cache\n"],
      ]) {
        expect(readFileSync(path.join(f.candidate, file), "utf-8")).toBe(bytes);
      }
      expect(
        execFileSync(
          "/usr/bin/git",
          ["-C", f.candidate, "show", `${result.checkpointRef}:shared.txt`],
          { encoding: "utf-8" },
        ),
      ).toBe("intermediate dirty shared source\n");
    } finally {
      capture.dispose();
    }
  } finally {
    f.dispose();
  }
});

test("recognized overlay never erases a genuine shared edit or accepts a foreign transport digest", async () => {
  const f = await fixture();
  try {
    f.write(f.source, "shared.txt", "intermediate source\n");
    const overlay = await prepareDevelopmentSandboxWorkspace(f.source, f.sandbox, "source-overlay");
    f.write(f.candidate, "shared.txt", "actual authored shared edit\n");
    f.write(f.source, "shared.txt", "new conflicting source\n");
    const capture = await captureLocalPlanningSource(f.source, f.original.sourceSha);
    try {
      const input = {
        appId: "example",
        assertCurrent: () => {},
        callId: "authored-conflict",
        capture,
        originalSourceSha: f.original.sourceSha,
        originalWorkspaceDigest: f.original.workspaceDigest,
        receipt: {
          eligibilityDigest: capture.generation.eligibilityDigest,
          sourceSha: capture.sourceSha,
          sourceTree: capture.generation.generation,
        },
        sandbox: f.sandbox,
        sessionId: "saved-session",
        sourceOverlay: { sourceSha: overlay.sourceSha, workspaceDigest: overlay.workspaceDigest },
        workspaceId: f.original.workspaceId,
      };
      await expect(reconcileLocalPlanningSource(input)).rejects.toThrow(
        "conflicts with authored changes",
      );
      expect(readFileSync(path.join(f.candidate, "shared.txt"), "utf-8")).toBe(
        "actual authored shared edit\n",
      );
      await expect(
        reconcileLocalPlanningSource({
          ...input,
          sourceOverlay: { ...input.sourceOverlay, workspaceDigest: "0".repeat(64) },
        }),
      ).rejects.toThrow("Recorded source overlay does not match");
      expect(readFileSync(path.join(f.candidate, "apps/example/app/page.tsx"), "utf-8")).toBe(
        "saved private app\n",
      );
    } finally {
      capture.dispose();
    }
  } finally {
    f.dispose();
  }
});
