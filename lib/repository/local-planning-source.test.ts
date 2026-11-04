import { z } from "zod";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  readlinkSync,
} from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { captureLocalPlanningSource } from "./local-planning-source";
import {
  initializeLocalPlanningGitBaseProgram,
  importLocalPlanningCurrentCommitProgram,
} from "./local-planning-git-base";
import { planningSourceReconciliationProgram } from "./planning-source-reconciliation";

const fixture = () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "owned-local-source-")));
  const source = path.join(directory, "source");
  const candidate = path.join(directory, "candidate");
  mkdirSync(source);
  const git = (root: string, ...args: string[]) =>
    execFileSync(
      "/usr/bin/git",
      ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", root, ...args],
      { encoding: "utf-8" },
    ).trim();
  const write = (root: string, file: string, bytes: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), bytes);
  };
  git(source, "init", "--quiet");
  git(source, "config", "user.name", "Fixture");
  git(source, "config", "user.email", "fixture@example.test");
  write(source, ".gitignore", ".app-builder/\n.env.local\nnode_modules/\n");
  write(source, "turbo.json", '{"globalPassThroughEnv":[]}\n');
  write(source, "shared.txt", "base\n");
  write(source, "apps/example/app/page.tsx", "source product\n");
  write(source, "apps/example/.config/mise/tasks/check", "source task\n");
  git(source, "add", ".");
  git(source, "commit", "--quiet", "-m", "base");
  const originalSha = git(source, "rev-parse", "HEAD");
  execFileSync("/usr/bin/git", ["clone", "--quiet", source, candidate]);
  git(candidate, "config", "user.name", "Fixture");
  git(candidate, "config", "user.email", "fixture@example.test");
  write(candidate, "apps/example/app/page.tsx", "saved product\n");
  write(candidate, "apps/example/.config/mise/tasks/check", "saved app task\n");
  write(candidate, "apps/example/schema/release/v1/release.json", "immutable\n");
  write(candidate, ".config/app-specs/example.md", "accepted product\n");
  write(candidate, ".env.local", "private retained\n");
  write(candidate, "node_modules/cache", "cache retained\n");
  const run = (targetSha: string, originalSourceSha = originalSha) =>
    spawnSync(
      process.execPath,
      [
        "-e",
        planningSourceReconciliationProgram,
        JSON.stringify({
          appId: "example",
          root: candidate,
          stateRoot: path.join(directory, "state"),
          sessionId: "saved-session",
          branchRef: "refs/app-builder/local-source",
          fetchRemote: false,
          localSource: true,
          originalSourceSha,
          targetSha,
        }),
      ],
      { cwd: candidate, encoding: "utf-8" },
    );
  const importCapture = async (capture: Awaited<ReturnType<typeof captureLocalPlanningSource>>) => {
    const current = capture.currentCommit();
    const packPath = path.join(directory, "current.pack");
    writeFileSync(packPath, Buffer.from(await new Response(current.streamPack()).arrayBuffer()));
    execFileSync(process.execPath, [
      "-e",
      importLocalPlanningCurrentCommitProgram,
      JSON.stringify({
        root: candidate,
        packPath,
        sourceSha: current.sourceSha,
        sourceTree: current.sourceTree,
      }),
    ]);
    const bundle = path.join(directory, "source.bundle");
    const bytes = await new Response(capture.streamBundle()).arrayBuffer();
    writeFileSync(bundle, Buffer.from(bytes));
    git(candidate, "fetch", "--quiet", "--no-write-fetch-head", bundle, capture.snapshotSha);
  };
  return {
    source,
    candidate,
    originalSha,
    git,
    write,
    run,
    importCapture,
    dispose: () => {
      rmSync(directory, { recursive: true, force: true });
    },
  };
};

describe("local planning base adoption", () => {
  it("streams actual dirty source through the existing merge while retaining saved app bytes and original checkout state", async () => {
    const f = fixture();
    try {
      f.write(f.source, "turbo.json", '{"globalPassThroughEnv":["CARGO_HOME"]}\n');
      f.git(f.source, "add", "turbo.json");
      f.git(f.source, "commit", "--quiet", "-m", "toolchain passthrough");
      f.write(f.source, "dirty-platform.txt", "current uncommitted source\n");
      f.write(
        f.source,
        "apps/example/schema/release/v1/release.json",
        "unrelated source release\n",
      );
      f.write(f.source, "apps/example/upstream-product.txt", "unrelated source app addition\n");
      symlinkSync("missing-target", path.join(f.source, "local-link"));
      const status = f.git(f.source, "status", "--porcelain");
      const head = f.git(f.source, "rev-parse", "HEAD");
      const capture = await captureLocalPlanningSource(f.source, f.originalSha);
      try {
        expect(capture.sourceSha).toBe(head);
        expect(capture.snapshotSha).not.toBe(head);
        await f.importCapture(capture);
        const outcome = f.run(capture.snapshotSha);
        expect(outcome.stderr).toBe("");
        expect(outcome.status).toBe(0);
        const result = z.object({ checkpointRef: z.string() }).parse(JSON.parse(outcome.stdout));
        expect(readFileSync(path.join(f.candidate, "turbo.json"), "utf-8")).toContain("CARGO_HOME");
        expect(readFileSync(path.join(f.candidate, "dirty-platform.txt"), "utf-8")).toBe(
          "current uncommitted source\n",
        );
        expect(readlinkSync(path.join(f.candidate, "local-link"))).toBe("missing-target");
        expect(() =>
          readFileSync(path.join(f.candidate, "apps/example/upstream-product.txt")),
        ).toThrow();
        for (const [file, bytes] of [
          ["apps/example/app/page.tsx", "saved product\n"],
          ["apps/example/.config/mise/tasks/check", "saved app task\n"],
          ["apps/example/schema/release/v1/release.json", "immutable\n"],
          [".config/app-specs/example.md", "accepted product\n"],
          [".env.local", "private retained\n"],
          ["node_modules/cache", "cache retained\n"],
        ]) {
          expect(readFileSync(path.join(f.candidate, file), "utf-8")).toBe(bytes);
        }
        expect(
          f.git(f.candidate, "show", `${result.checkpointRef}:apps/example/app/page.tsx`),
        ).toBe("saved product");
        expect(f.git(f.source, "rev-parse", "HEAD")).toBe(head);
        expect(f.git(f.source, "status", "--porcelain")).toBe(status);
        const firstCheckpoint = result.checkpointRef;
        f.write(f.source, "dirty-platform.txt", "next ordinary local edit\n");
        const next = await captureLocalPlanningSource(f.source, head);
        try {
          await f.importCapture(next);
          const second = f.run(next.snapshotSha, head);
          expect(second.stderr).toBe("");
          expect(second.status).toBe(0);
          expect(readFileSync(path.join(f.candidate, "dirty-platform.txt"), "utf-8")).toBe(
            "next ordinary local edit\n",
          );
          const secondCheckpoint = z
            .object({ checkpointRef: z.string() })
            .parse(JSON.parse(second.stdout)).checkpointRef;
          expect(secondCheckpoint).not.toBe(firstCheckpoint);
          expect(f.git(f.candidate, "show", `${firstCheckpoint}:apps/example/app/page.tsx`)).toBe(
            "saved product",
          );
          expect(f.git(f.candidate, "show", `${secondCheckpoint}:dirty-platform.txt`)).toBe(
            "current uncommitted source",
          );
          const retry = f.run(next.snapshotSha, head);
          expect(retry.stderr).toBe("");
          expect(retry.status).toBe(0);
          const retryCheckpoint = z
            .object({ checkpointRef: z.string() })
            .parse(JSON.parse(retry.stdout)).checkpointRef;
          expect(f.git(f.candidate, "show", `${retryCheckpoint}:apps/example/app/page.tsx`)).toBe(
            "saved product",
          );
        } finally {
          next.dispose();
        }
      } finally {
        capture.dispose();
      }
    } finally {
      f.dispose();
    }
  });
  it("preserves the candidate and its checkpoint on a concrete shared-file conflict", async () => {
    const f = fixture();
    try {
      f.write(f.source, "shared.txt", "new shared source\n");
      f.write(f.candidate, "shared.txt", "saved authored edit\n");
      const capture = await captureLocalPlanningSource(f.source, f.originalSha);
      try {
        await f.importCapture(capture);
        const result = f.run(capture.snapshotSha);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("conflicts with authored changes");
        expect(f.git(f.candidate, "rev-parse", "HEAD")).toBe(f.originalSha);
        expect(readFileSync(path.join(f.candidate, "shared.txt"), "utf-8")).toBe(
          "saved authored edit\n",
        );
        const ref = f.git(
          f.candidate,
          "for-each-ref",
          "--format=%(refname)",
          "refs/app-builder/local-source-checkpoints/",
        );
        expect(f.git(f.candidate, "show", `${ref}:shared.txt`)).toBe("saved authored edit");
      } finally {
        capture.dispose();
      }
    } finally {
      f.dispose();
    }
  });
  it("rejects an actually moving source before returning mismatched generation metadata", async () => {
    const f = fixture();
    const writer = spawn(
      process.execPath,
      [
        "-e",
        `const fs=require('node:fs');let n=0;const write=()=>fs.writeFileSync(process.argv[1],String(n++));write();process.stdout.write('ready');setInterval(write,1);`,
        path.join(f.source, "shared.txt"),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      await once(writer.stdout, "data");
      await expect(captureLocalPlanningSource(f.source, f.originalSha)).rejects.toThrow(
        "local source changed",
      );
      expect(f.git(f.candidate, "rev-parse", "HEAD")).toBe(f.originalSha);
      expect(readFileSync(path.join(f.candidate, "apps/example/app/page.tsx"), "utf-8")).toBe(
        "saved product\n",
      );
    } finally {
      writer.kill();
      await once(writer, "exit");
      f.dispose();
    }
  });
  it("reports a missing old Git base without replacing any saved app bytes", async () => {
    const f = fixture();
    try {
      await expect(captureLocalPlanningSource(f.source, "f".repeat(40))).rejects.toThrow();
      expect(readFileSync(path.join(f.candidate, "apps/example/app/page.tsx"), "utf-8")).toBe(
        "saved product\n",
      );
      expect(f.git(f.candidate, "rev-parse", "HEAD")).toBe(f.originalSha);
    } finally {
      f.dispose();
    }
  });
});

describe("retained dirty planning baseline", () => {
  it("uses real owned snapshot Git bytes as a distinct base while preserving historical identity", async () => {
    const f = fixture();
    let capture: Awaited<ReturnType<typeof captureLocalPlanningSource>> | undefined;
    try {
      f.write(f.source, "dirty-initial.txt", "initial dirty bytes\n");
      f.write(f.candidate, "dirty-initial.txt", "initial dirty bytes\n");
      const initial = await captureLocalPlanningSource(f.source, f.originalSha);
      const expected = initial.generation.workspaceDigest;
      initial.dispose();
      const stateRoot = path.join(path.dirname(f.source), "retained");
      const snapshot = path.join(stateRoot, "runs", "run-ABC123", "source");
      mkdirSync(path.dirname(snapshot), { recursive: true, mode: 0o700 });
      execFileSync("/usr/bin/git", ["clone", "--quiet", f.source, snapshot]);
      chmodSync(snapshot, 0o700);
      chmodSync(path.join(snapshot, ".git"), 0o700);
      f.git(snapshot, "config", "user.name", "Fixture");
      f.git(snapshot, "config", "user.email", "fixture@example.test");
      f.write(snapshot, "dirty-initial.txt", "initial dirty bytes\n");
      f.git(snapshot, "add", ".");
      f.git(snapshot, "commit", "--quiet", "-m", "real retained initial snapshot");
      const retainedSha = f.git(snapshot, "rev-parse", "HEAD");
      // Filesystem drift does not authorize baseline bytes; committed objects do.
      f.write(snapshot, "dirty-initial.txt", "later mutable snapshot file\n");
      f.write(f.source, "dirty-initial.txt", "new platform bytes\n");
      capture = await captureLocalPlanningSource(f.source, f.originalSha, {
        readAuthority: () =>
          Promise.resolve({ kind: "local", ownerUid: process.getuid?.() ?? -1, stateRoot }),
      });
      const baseline = capture.originalBase(expected);
      expect(baseline.originalSourceSha).toBe(f.originalSha);
      expect(baseline.sourceSha).toBe(retainedSha);
      expect(baseline.sourceSha).not.toBe(f.originalSha);
      const packPath = path.join(path.dirname(f.source), "retained-base.pack");
      writeFileSync(packPath, Buffer.from(await new Response(baseline.streamPack()).arrayBuffer()));
      rmSync(path.join(f.candidate, ".git"), { recursive: true });
      execFileSync(process.execPath, [
        "-e",
        initializeLocalPlanningGitBaseProgram,
        JSON.stringify({
          root: f.candidate,
          stateRoot: path.join(stateRoot, "initialization"),
          packPath,
          sourceSha: baseline.sourceSha,
          sourceTree: baseline.sourceTree,
          originalSourceSha: baseline.originalSourceSha,
        }),
      ]);
      expect(f.git(f.candidate, "rev-parse", "HEAD")).toBe(retainedSha);
      expect(f.git(f.candidate, "cat-file", "-t", f.originalSha)).toBe("commit");
      expect(f.git(f.candidate, "rev-parse", `${f.originalSha}^{tree}`)).toBe(
        f.git(f.source, "rev-parse", `${f.originalSha}^{tree}`),
      );
      await f.importCapture(capture);
      const reconciled = f.run(capture.snapshotSha);
      expect(reconciled.status, reconciled.stderr).toBe(0);
      expect(readFileSync(path.join(f.candidate, "apps/example/app/page.tsx"), "utf-8")).toBe(
        "saved product\n",
      );
      expect(f.git(snapshot, "status", "--porcelain")).toContain("dirty-initial.txt");
      const observedCapture = capture;
      expect(() => observedCapture.originalBase("f".repeat(64))).toThrow(
        "recover its original source artifact",
      );
    } finally {
      capture?.dispose();
      f.dispose();
    }
  });
  it("recovers actually retained originally tracked ignored bytes only after exact inventory proof", async () => {
    const f = fixture();
    let capture: Awaited<ReturnType<typeof captureLocalPlanningSource>> | undefined;
    try {
      f.write(f.source, ".gitignore", "ignored-tracked.txt\n");
      f.write(f.source, "ignored-tracked.txt", "original copied bytes\n");
      f.git(f.source, "add", "-f", "ignored-tracked.txt", ".gitignore");
      f.git(f.source, "commit", "--quiet", "-m", "tracked ignored source");
      const originalSha = f.git(f.source, "rev-parse", "HEAD");
      const initial = await captureLocalPlanningSource(f.source, originalSha);
      const expected = initial.generation.workspaceDigest;
      initial.dispose();
      const stateRoot = path.join(path.dirname(f.source), "retained");
      const snapshot = path.join(stateRoot, "runs", "run-ABC123", "source");
      mkdirSync(path.dirname(snapshot), { recursive: true, mode: 0o700 });
      execFileSync("/usr/bin/git", ["clone", "--quiet", f.source, snapshot]);
      chmodSync(snapshot, 0o700);
      chmodSync(path.join(snapshot, ".git"), 0o700);
      f.git(snapshot, "config", "user.name", "Fixture");
      f.git(snapshot, "config", "user.email", "fixture@example.test");
      // An actual dirty starting file belongs to the original workspace too.
      f.write(snapshot, "dirty-start.txt", "retained dirty start\n");
      f.write(f.source, "dirty-start.txt", "retained dirty start\n");
      const fullInitial = await captureLocalPlanningSource(f.source, originalSha);
      const fullExpected = fullInitial.generation.workspaceDigest;
      fullInitial.dispose();
      expect(fullExpected).not.toBe(expected);
      f.git(snapshot, "rm", "--cached", "ignored-tracked.txt");
      f.git(snapshot, "add", "dirty-start.txt");
      f.git(
        snapshot,
        "commit",
        "--quiet",
        "-m",
        "genuine copied snapshot with ignored index omission",
      );
      const snapshotSha = f.git(snapshot, "rev-parse", "HEAD");
      f.write(f.source, "shared.txt", "new platform source\n");
      capture = await captureLocalPlanningSource(f.source, originalSha, {
        readAuthority: () =>
          Promise.resolve({ kind: "local", ownerUid: process.getuid?.() ?? -1, stateRoot }),
      });
      const baseline = capture.originalBase(fullExpected);
      expect(baseline.originalSourceSha).toBe(originalSha);
      expect(baseline.sourceSha).not.toBe(snapshotSha);
      expect(baseline.sourceSha).not.toBe(originalSha);
      expect(f.git(snapshot, "rev-parse", "HEAD")).toBe(snapshotSha);
      f.write(snapshot, "ignored-tracked.txt", "changed retained bytes\n");
      const observedCapture = capture;
      expect(() => observedCapture.originalBase(fullExpected)).toThrow(
        "recover its original source artifact",
      );
    } finally {
      capture?.dispose();
      f.dispose();
    }
  });
});
