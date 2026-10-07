import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appBaselineMarkerPath,
  appBaselineProjectionProgram,
  appBaselineReceiptSchema,
  appBaselineReviewPreTree,
  assertAppBaselineAuthority,
  readableAppBaselinePaths,
  readAppBaselineMarker,
} from "./app-baseline";
import type { AppBaselineSelection } from "./app-baseline";
import { assertExistingAppReviewScope } from "./reviewed-change-set";
import { overlayChanges } from "./target-apply";
/* oxlint-disable sonarjs/no-os-command-from-path -- Exercise the repository's Git dependency using fixed arguments in disposable fixtures. */

const { dirname, join } = nodePath;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});
const digest = (content: string) => createHash("sha256").update(content).digest("hex");
const fixture = (releaseCollision = false) => {
  const workspace = mkdtempSync(join(tmpdir(), "builder-baseline-test-"));
  roots.push(workspace);
  const root = join(workspace, "repository");
  mkdirSync(root);
  const git = (...args: string[]) =>
    // oxlint-disable-next-line sonarjs/no-os-command-from-path -- Exercise the repository's Git dependency with fixed arguments in a disposable fixture.
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-C", root, ...args],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  const write = (file: string, value: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), value);
  };
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "fixture",
    );
    return { commitSha: git("rev-parse", "HEAD"), treeSha: git("rev-parse", "HEAD^{tree}") };
  };
  git("init", "-q");
  write("apps/spend-review/app/page.tsx", "agreed demo page");
  write("apps/spend-review/schema/spend-review.cue", "demo CUE");
  write("apps/spend-review/schema/index.ts", "selected old release");
  write("apps/spend-review/schema/release/old/runtime.ts", "immutable old release");
  write(".config/app-specs/spend-review.md", "agreed demo spec");
  write(".config/app-specs/spend-review.cue", "agreed demo spec CUE");
  write("packages/runtime/index.ts", "old shared runtime");
  write("config/routing.json", "old shared routing");
  const historical = commit();
  write("apps/spend-review/app/page.tsx", "later manually authored page");
  write("apps/spend-review/app/manual.ts", "later manually authored module");
  write("apps/spend-review/schema/spend-review.cue", "later schema");
  write("apps/spend-review/schema/index.ts", "selected later release");
  write("apps/spend-review/schema/release/later/runtime.ts", "immutable later release");
  write(".config/app-specs/spend-review.md", "later manual spec");
  write(
    "apps/spend-review/.config/mise/tasks/test-local-acceptance",
    "current app acceptance task",
  );
  write("apps/spend-review/.config/mise/tasks/test", "current app test task");
  write("packages/runtime/index.ts", "new shared runtime");
  write("config/routing.json", "new shared routing");
  if (releaseCollision) {
    write("apps/spend-review/schema/release/old/runtime.ts", "rewritten archive");
  }
  const platform = { ...commit(), ref: "refs/heads/platform-runtime" };
  const selection: AppBaselineSelection = {
    appId: "spend-review",
    historical: {
      ...historical,
      name: "arrusted",
      owner: "example",
      pullRequestNumber: 1500,
      repositoryId: "100",
    },
    selectedByCallId: "select-baseline",
    sessionId: "session-one",
    source: { kind: "merged-pr", pullRequestNumber: 1500 },
  };
  const markerPath = join(workspace, appBaselineMarkerPath(selection.appId));
  const scriptPath = join(workspace, "projection.cjs");
  const program = (callId: string) =>
    appBaselineProjectionProgram({ callId, markerPath, platform, root, selection });
  const run = (callId = "prepare-baseline", preload?: string) => {
    writeFileSync(scriptPath, program(callId));
    const args = preload === undefined ? [scriptPath] : ["--require", preload, scriptPath];
    return appBaselineReceiptSchema.parse(
      JSON.parse(
        execFileSync(process.execPath, args, {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ),
    );
  };
  const sandbox = {
    readTextFile: async ({ path }: { path: string }) =>
      await Promise.resolve(
        existsSync(join(workspace, path)) ? readFileSync(join(workspace, path), "utf-8") : null,
      ),
  };
  return { git, markerPath, platform, root, run, sandbox, selection, workspace, write };
};

describe("initial app baseline projection", () => {
  it("restores the agreed app before inspection while preserving the actual platform and immutable archives", async () => {
    const f = fixture();
    const receipt = f.run();
    expect(readFileSync(join(f.root, "apps/spend-review/app/page.tsx"), "utf-8")).toBe(
      "agreed demo page",
    );
    expect(existsSync(join(f.root, "apps/spend-review/app/manual.ts"))).toBe(false);
    expect(readFileSync(join(f.root, "apps/spend-review/schema/index.ts"), "utf-8")).toBe(
      "selected old release",
    );
    expect(readFileSync(join(f.root, ".config/app-specs/spend-review.md"), "utf-8")).toBe(
      "agreed demo spec",
    );
    expect(
      readFileSync(
        join(f.root, "apps/spend-review/.config/mise/tasks/test-local-acceptance"),
        "utf-8",
      ),
    ).toBe("current app acceptance task");
    expect(readFileSync(join(f.root, "apps/spend-review/.config/mise/tasks/test"), "utf-8")).toBe(
      "current app test task",
    );
    expect(readFileSync(join(f.root, "packages/runtime/index.ts"), "utf-8")).toBe(
      "new shared runtime",
    );
    expect(readFileSync(join(f.root, "config/routing.json"), "utf-8")).toBe("new shared routing");
    expect(
      readFileSync(join(f.root, "apps/spend-review/schema/release/later/runtime.ts"), "utf-8"),
    ).toBe("immutable later release");
    expect(f.git("rev-parse", "HEAD")).toBe(f.platform.commitSha);
    expect(receipt).toMatchObject({
      historical: f.selection.historical,
      platform: f.platform,
      retainedReleaseFiles: 2,
      sessionId: "session-one",
    });
    expect(receipt.historical.commitSha).not.toBe(receipt.platform.commitSha);
    const allowed = await readableAppBaselinePaths(f.sandbox, f.selection, [
      "apps/spend-review/app/page.tsx",
      "apps/spend-review/schema/release/old/runtime.ts",
      "/workspace/repository/apps/spend-review/schema/release/later/runtime.ts",
      "apps/spend-review/app/../schema/release/later/runtime.ts",
    ]);
    expect(allowed).toEqual([
      "apps/spend-review/app/page.tsx",
      "apps/spend-review/schema/release/old/runtime.ts",
    ]);
    expect(JSON.stringify(await readAppBaselineMarker(f.sandbox, f.selection))).not.toContain(
      "later manually authored",
    );
  });

  it("retains authored work on an exact retry and binds the final review to the actual platform base", async () => {
    const f = fixture();
    const first = f.run();
    f.write("apps/spend-review/app/page.tsx", "Builder authored authenticated page");
    const second = f.run("later-retry");
    expect(second).toEqual(first);
    expect(readFileSync(join(f.root, "apps/spend-review/app/page.tsx"), "utf-8")).toBe(
      "Builder authored authenticated page",
    );
    const preTree = await appBaselineReviewPreTree(f.sandbox, f.selection, [
      { digest: digest("agreed demo page"), mode: "644", path: "apps/spend-review/app/page.tsx" },
      { digest: digest("unchanged shared"), mode: "644", path: "packages/untouched.ts" },
    ]);
    expect(preTree.find(({ path }) => path === "apps/spend-review/app/page.tsx")?.digest).toBe(
      digest("later manually authored page"),
    );
    const postTree = preTree
      .filter(({ path }) => path !== "apps/spend-review/app/manual.ts")
      .map((file) =>
        file.path === "apps/spend-review/app/page.tsx"
          ? { ...file, digest: digest("Builder authored authenticated page") }
          : file,
      );
    expect(
      overlayChanges(
        { files: preTree, treeDigest: "unused" },
        { files: postTree, treeDigest: "unused" },
      ),
    ).toMatchObject([
      { kind: "deleted", path: "apps/spend-review/app/manual.ts" },
      {
        after: { digest: digest("Builder authored authenticated page") },
        before: { digest: digest("later manually authored page") },
        kind: "modified",
        path: "apps/spend-review/app/page.tsx",
      },
    ]);
    const review = {
      approvedPaths: ["apps/spend-review/app/page.tsx", ".config/app-specs/spend-review.md"],
      sourceSha: f.platform.commitSha,
    };
    expect(() => {
      assertExistingAppReviewScope(review, "spend-review", "existing-repository", first);
    }).not.toThrow();
    expect(() => {
      assertExistingAppReviewScope(
        { ...review, sourceSha: f.selection.historical.commitSha },
        "spend-review",
        "existing-repository",
        first,
      );
    }).toThrow("outside");
    expect(() => {
      assertExistingAppReviewScope(
        { ...review, approvedPaths: ["config/routing.json"] },
        "spend-review",
        "existing-repository",
        first,
      );
    }).toThrow("outside");
  });

  it("recovers an interrupted private projection before exposing the app and preserves original provenance", () => {
    const f = fixture();
    const preload = join(f.workspace, "interrupt.cjs");
    writeFileSync(
      preload,
      `const fs = require('node:fs'); const rename = fs.renameSync; fs.renameSync = (from, to) => { rename(from, to); if (to.endsWith('/app/page.tsx')) throw new Error('fixture process interrupted'); };`,
    );
    expect(() => f.run("original-prepare", preload)).toThrow("fixture process interrupted");
    expect(existsSync(f.markerPath)).toBe(false);
    expect(existsSync(`${f.markerPath}.plan`)).toBe(true);
    const receipt = f.run("recovery-prepare");
    expect(receipt.projectedByCallId).toBe("original-prepare");
    expect(readFileSync(join(f.root, "apps/spend-review/app/page.tsx"), "utf-8")).toBe(
      "agreed demo page",
    );
    expect(existsSync(`${f.markerPath}.plan`)).toBe(false);
  });

  it("rejects an occupied checkout or a checked-release collision without rewriting app source", () => {
    const occupied = fixture();
    occupied.write("apps/spend-review/app/page.tsx", "existing authored work");
    expect(() => occupied.run()).toThrow("workspace already contains edits");
    expect(readFileSync(join(occupied.root, "apps/spend-review/app/page.tsx"), "utf-8")).toBe(
      "existing authored work",
    );
    const collision = fixture(true);
    expect(() => collision.run()).toThrow("checked historical release has different bytes");
    expect(readFileSync(join(collision.root, "apps/spend-review/app/page.tsx"), "utf-8")).toBe(
      "later manually authored page",
    );
    expect(
      readFileSync(
        join(collision.root, "apps/spend-review/schema/release/old/runtime.ts"),
        "utf-8",
      ),
    ).toBe("rewritten archive");
  });

  it("rejects symlink aliases into shared source and corrupted provenance", async () => {
    const f = fixture();
    rmSync(join(f.root, "apps/spend-review/app"), { recursive: true });
    symlinkSync(join(f.root, "packages/runtime"), join(f.root, "apps/spend-review/app"));
    expect(() => f.run()).toThrow();
    expect(readFileSync(join(f.root, "packages/runtime/index.ts"), "utf-8")).toBe(
      "new shared runtime",
    );
    const prepared = fixture();
    prepared.run();
    const marker = await readAppBaselineMarker(prepared.sandbox, prepared.selection);
    if (marker === undefined || marker.platformFiles[0] === undefined) {
      throw new Error("Fixture marker is missing");
    }
    marker.platformFiles[0].digest = "0".repeat(64);
    writeFileSync(prepared.markerPath, JSON.stringify(marker));
    await expect(readAppBaselineMarker(prepared.sandbox, prepared.selection)).rejects.toThrow(
      "different app baseline",
    );
  });

  it("streams a valid source blob beyond Node's default command output buffer", () => {
    const f = fixture();
    const content = "backend persistence source\n".repeat(100_000);
    f.write("apps/spend-review/schema/release/later/large.ts", content);
    f.git("add", ".");
    f.git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "large archive",
    );
    f.platform.commitSha = f.git("rev-parse", "HEAD");
    f.platform.treeSha = f.git("rev-parse", "HEAD^{tree}");
    expect(f.run().retainedReleaseFiles).toBe(3);
    expect(
      readFileSync(join(f.root, "apps/spend-review/schema/release/later/large.ts"), "utf-8"),
    ).toBe(content);
  });

  it("rejects a baseline from another session or repository before provider work", () => {
    const f = fixture();
    const authority = {
      repository: f.selection.historical,
      selection: f.selection,
      sessionId: "session-one",
    };
    expect(() => {
      assertAppBaselineAuthority(authority);
    }).not.toThrow();
    expect(() => {
      assertAppBaselineAuthority({ ...authority, sessionId: "session-other" });
    }).toThrow("different Builder session or repository");
    expect(() => {
      assertAppBaselineAuthority({
        ...authority,
        repository: { ...authority.repository, repositoryId: "999" },
      });
    }).toThrow("different Builder session or repository");
  });
});
