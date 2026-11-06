import { z } from "zod";
import { execFileSync, spawnSync } from "node:child_process";
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
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectDevelopmentSourceGeneration } from "./development-source-generation";
import { captureLocalPlanningSource, reconcileLocalPlanningSource } from "./local-planning-source";
import { localSourceBaselineManifestSchema } from "./local-source-baseline-contract";
import { retainPreparedLocalSourceBaseline } from "./local-source-baseline-retention";
import type { SandboxSession } from "eve/sandbox";
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
          branchRef: "refs/app-builder/local-source",
          fetchRemote: false,
          localSource: true,
          originalSourceSha,
          root: candidate,
          sessionId: "saved-session",
          stateRoot: path.join(directory, "state"),
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
        packPath,
        root: candidate,
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
    candidate,
    dispose: () => {
      rmSync(directory, { force: true, recursive: true });
    },
    git,
    importCapture,
    originalSha,
    run,
    source,
    write,
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
    let firstObservation = true;
    const inspectSource: typeof inspectDevelopmentSourceGeneration = async (root) => {
      const generation = await inspectDevelopmentSourceGeneration(root);
      if (firstObservation) {
        firstObservation = false;
        f.write(f.source, "shared.txt", "changed after initial source observation\n");
      }
      return generation;
    };
    try {
      await expect(
        captureLocalPlanningSource(f.source, f.originalSha, { inspectSource }),
      ).rejects.toThrow("local source changed");
      expect(f.git(f.candidate, "rev-parse", "HEAD")).toBe(f.originalSha);
      expect(readFileSync(path.join(f.candidate, "apps/example/app/page.tsx"), "utf-8")).toBe(
        "saved product\n",
      );
    } finally {
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
      mkdirSync(path.dirname(snapshot), { mode: 0o700, recursive: true });
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
        readAuthority: async () => ({
          kind: "local",
          ownerUid: process.getuid?.() ?? -1,
          stateRoot,
        }),
      });
      const baseline = capture.originalBase(expected);
      expect(baseline.originalSourceSha).toBe(f.originalSha);
      expect(baseline.sourceSha).toBe(retainedSha);
      expect(baseline.sourceSha).not.toBe(f.originalSha);
      const artifact = path.join(stateRoot, "source-baselines", f.originalSha, expected);
      mkdirSync(artifact, { mode: 0o700, recursive: true });
      const artifactGit = path.join(artifact, "source.git");
      execFileSync("/usr/bin/git", ["clone", "--bare", "--quiet", snapshot, artifactGit]);
      chmodSync(artifactGit, 0o700);
      writeFileSync(
        path.join(artifact, "manifest.json"),
        JSON.stringify({
          kind: "local-planning-source-baseline",
          originalSourceSha: f.originalSha,
          provenance: { kind: "recovered-source" },
          sourceSha: baseline.sourceSha,
          sourceTree: baseline.sourceTree,
          version: 1,
          workspaceDigest: expected,
        }),
        { mode: 0o600 },
      );
      expect(capture.originalBase(expected).sourceSha).toBe(retainedSha);
      const packPath = path.join(path.dirname(f.source), "retained-base.pack");
      writeFileSync(packPath, Buffer.from(await new Response(baseline.streamPack()).arrayBuffer()));
      rmSync(path.join(f.candidate, ".git"), { recursive: true });
      execFileSync(process.execPath, [
        "-e",
        initializeLocalPlanningGitBaseProgram,
        JSON.stringify({
          originalSourceSha: baseline.originalSourceSha,
          packPath,
          root: f.candidate,
          sourceSha: baseline.sourceSha,
          sourceTree: baseline.sourceTree,
          stateRoot: path.join(stateRoot, "initialization"),
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
      mkdirSync(path.dirname(snapshot), { mode: 0o700, recursive: true });
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
        readAuthority: async () => ({
          kind: "local",
          ownerUid: process.getuid?.() ?? -1,
          stateRoot,
        }),
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
  it("does not infer historical symlink targets from a legacy regular-file digest", async () => {
    const f = fixture();
    let capture: Awaited<ReturnType<typeof captureLocalPlanningSource>> | undefined;
    try {
      symlinkSync("shared.txt", path.join(f.source, "source-link"));
      f.git(f.source, "add", "source-link");
      f.git(f.source, "commit", "--quiet", "-m", "actual linked source");
      const sha = f.git(f.source, "rev-parse", "HEAD");
      capture = await captureLocalPlanningSource(f.source, sha);
      const observed = capture;
      expect(() => observed.originalBase(observed.generation.workspaceDigest)).toThrow(
        "recover its original source artifact",
      );
      // A new preparation can retain the actual separately captured tree.
      expect(observed.capturedBase().sourceSha).toBe(observed.snapshotSha);
    } finally {
      capture?.dispose();
      f.dispose();
    }
  });
  it("retains each new generation across successive real reconciliations and later Git metadata recovery", async () => {
    const f = fixture();
    const directory = path.dirname(f.source);
    const stateRoot = path.join(directory, "baseline-custody");
    mkdirSync(stateRoot, { mode: 0o700 });
    const authority = { kind: "local" as const, ownerUid: process.getuid?.() ?? -1, stateRoot };
    const readAuthority = async () => authority;
    const localPath = (name: string) => {
      const mapped = name
        .replaceAll("/workspace/repository", f.candidate)
        .replaceAll("/workspace", directory);
      const resolved = path.resolve(directory, mapped);
      if (resolved !== directory && !resolved.startsWith(directory + path.sep)) {
        throw new Error("Fixture source escaped owned root");
      }
      return resolved;
    };
    const unavailable = async () => {
      throw new Error("Unexpected process/stream operation in source-only fixture");
    };
    const sandbox: SandboxSession & { id: string } = {
      id: "saved-workspace",
      readBinaryFile: async ({ path: name }) => {
        try {
          return readFileSync(localPath(name));
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return null;
          }
          throw error;
        }
      },
      readFile: unavailable,
      readTextFile: async ({ path: name }) => {
        try {
          return readFileSync(localPath(name), "utf-8");
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return null;
          }
          throw error;
        }
      },
      removePath: async ({ path: name, recursive, force }) => {
        rmSync(localPath(name), { force, recursive });
      },
      resolvePath: localPath,
      run: async ({ command, workingDirectory }) => {
        const mapped = command
          .replaceAll("/workspace/repository", f.candidate)
          .replaceAll("/workspace", directory);
        const result = spawnSync("/bin/sh", ["-c", mapped], {
          cwd: localPath(workingDirectory ?? "/workspace"),
          encoding: "utf-8",
          env: { ...process.env, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` },
        });
        if (result.status === null) {
          throw new Error("Fixture command did not finish");
        }
        return {
          exitCode: result.status,
          stderr: result.stderr,
          stdout: result.stdout,
        };
      },
      spawn: unavailable,
      writeBinaryFile: async ({ path: name, content }) => {
        const file = localPath(name);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, content);
      },
      writeFile: async ({ path: name, content }) => {
        const file = localPath(name);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, Buffer.from(await new Response(content).arrayBuffer()));
      },
      writeTextFile: async ({ path: name, content }) => {
        const file = localPath(name);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, content);
      },
    };
    const retainedReceipts: { sourceSha: string; workspaceDigest: string; sourceTree: string }[] =
      [];
    const reconcile = async (previousSha: string, previousDigest: string, revision: number) => {
      const capture = await captureLocalPlanningSource(f.source, previousSha, { readAuthority });
      try {
        const result = await reconcileLocalPlanningSource(
          {
            appId: "example",
            assertCurrent: () => {},
            callId: `revision-${revision}`,
            capture,
            originalSourceSha: previousSha,
            originalWorkspaceDigest: previousDigest,
            receipt: {
              eligibilityDigest: capture.generation.eligibilityDigest,
              sourceSha: capture.sourceSha,
              sourceTree: capture.snapshotTree,
            },
            sandbox,
            sessionId: "saved-session",
            workspaceId: sandbox.id,
          },
          {
            retainBaseline: async (generation, dependencies) => {
              await retainPreparedLocalSourceBaseline(generation, {
                ...dependencies,
                readAuthority,
              });
            },
          },
        );
        const manifest = localSourceBaselineManifestSchema.parse(
          JSON.parse(
            readFileSync(
              path.join(
                stateRoot,
                "source-baselines",
                capture.sourceSha,
                capture.generation.workspaceDigest,
                "manifest.json",
              ),
              "utf-8",
            ),
          ),
        );
        expect(manifest.originalSourceSha).toBe(capture.sourceSha);
        retainedReceipts.push({
          sourceSha: capture.sourceSha,
          sourceTree: capture.snapshotTree,
          workspaceDigest: capture.generation.workspaceDigest,
        });
        expect(readFileSync(path.join(f.candidate, "apps/example/app/page.tsx"), "utf-8")).toBe(
          "saved product\n",
        );
        expect(
          readFileSync(
            path.join(f.candidate, "apps/example/schema/release/v1/release.json"),
            "utf-8",
          ),
        ).toBe("immutable\n");
        return result;
      } finally {
        capture.dispose();
      }
    };
    try {
      const original = await captureLocalPlanningSource(f.source, f.originalSha, { readAuthority });
      const originalDigest = original.generation.workspaceDigest;
      original.dispose();
      f.write(f.source, "shared.txt", "platform revision one\n");
      f.git(f.source, "add", "shared.txt");
      f.git(f.source, "commit", "--quiet", "-m", "first platform revision");
      const first = await reconcile(f.originalSha, originalDigest, 1);
      const firstCheckpoint = f.git(f.candidate, "rev-parse", first.checkpointRef);
      const firstReceipt = JSON.stringify(retainedReceipts[0]);
      f.write(f.source, "platform-two.txt", "platform revision two\n");
      f.git(f.source, "add", "platform-two.txt");
      f.git(f.source, "commit", "--quiet", "-m", "second platform revision");
      f.write(f.source, "second-dirty.txt", "genuine uncommitted generation two source\n");
      const second = await reconcile(first.workspace.sourceSha, first.workspace.workspaceDigest, 2);
      expect(f.git(f.candidate, "rev-parse", first.checkpointRef)).toBe(firstCheckpoint);
      expect(JSON.stringify(retainedReceipts[0])).toBe(firstReceipt);
      // Exercise the supported missing-Git recovery path using generation two,
      // rather than falling back to the original first-generation source.
      rmSync(path.join(f.candidate, ".git"), { recursive: true });
      f.write(f.source, "platform-three.txt", "platform revision three\n");
      f.git(f.source, "add", "platform-three.txt");
      f.git(f.source, "commit", "--quiet", "-m", "third platform revision");
      const third = await reconcile(
        second.workspace.sourceSha,
        second.workspace.workspaceDigest,
        3,
      );
      expect(third.restoredOriginalBase?.originalSourceSha).toBe(second.workspace.sourceSha);
      expect(third.restoredOriginalBase?.sourceSha).not.toBe(second.workspace.sourceSha);
      expect(readFileSync(path.join(f.candidate, "second-dirty.txt"), "utf-8")).toBe(
        "genuine uncommitted generation two source\n",
      );
      expect(third.workspace.sourceSha).not.toBe(f.originalSha);
      expect(readFileSync(path.join(f.candidate, "platform-three.txt"), "utf-8")).toBe(
        "platform revision three\n",
      );
      expect(retainedReceipts).toHaveLength(3);
    } finally {
      f.dispose();
    }
  });
});
