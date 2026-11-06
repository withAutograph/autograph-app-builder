import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { c as createTar } from "tar";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { recoverLocalSourceBaseline } from "./recover-local-source-baseline";
import { committedDevelopmentInventory } from "./local-source-baseline-store";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});
const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const git = (root: string, args: string[]) =>
  execFileSync("/usr/bin/git", ["-C", root, ...args], {
    env: {
      GIT_AUTHOR_EMAIL: "fixture@invalid.example",
      GIT_AUTHOR_NAME: "Source Fixture",
      GIT_COMMITTER_EMAIL: "fixture@invalid.example",
      GIT_COMMITTER_NAME: "Source Fixture",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: root,
      NODE_ENV: "test",
      PATH: "/usr/bin:/bin",
    },
  })
    .toString()
    .trim();
const fixture = async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "source-recovery-")));
  roots.push(root);
  await chmod(root, 0o700);
  const state = path.join(root, "state");
  const runsRoot = path.join(state, "runs");
  const source = path.join(root, "source");
  const overlay = path.join(root, "overlay");
  await Promise.all(
    [state, runsRoot, source, overlay].map(async (file) => {
      await mkdir(file, { mode: 0o700, recursive: true });
    }),
  );
  await writeFile(path.join(state, "eve-cycle"), "a".repeat(64), { mode: 0o600 });
  await writeFile(path.join(source, "README.md"), "Original source\n");
  git(source, ["init", "-q"]);
  git(source, ["add", "."]);
  git(source, ["-c", "commit.gpgsign=false", "commit", "-qm", "Original fixture"]);
  const originalSourceSha = git(source, ["rev-parse", "HEAD"]);
  await mkdir(path.join(overlay, "apps/example"), { recursive: true });
  await writeFile(path.join(overlay, "apps/example/run.sh"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  const archive = path.join(root, "source.tar.gz");
  await createTar({ cwd: overlay, file: archive, gzip: true }, ["apps/example/run.sh"]);
  const files = [
    { content: "Original source\n", mode: "100644", path: "README.md" },
    { content: "#!/bin/sh\nexit 0\n", mode: "100755", path: "apps/example/run.sh" },
  ].map((file) => ({
    mode: file.mode,
    objectId: sha(file.content).slice(0, 40),
    path: file.path,
    sha256: sha(file.content),
  }));
  return {
    archive,
    request: {
      archives: [
        {
          files: [
            {
              mode: "100755" as const,
              path: "apps/example/run.sh",
              sha256: sha("#!/bin/sh\nexit 0\n"),
            },
          ],
          path: archive,
          sha256: sha(await readFile(archive)),
        },
      ],
      originalSourceRoot: source,
      originalSourceSha,
      workspaceDigest: sha(JSON.stringify(files)),
    },
    root,
    runsRoot,
    source,
    state,
  };
};

it("recovers real Git/archive bytes into a distinct owner-bound capture and replays without replacing it", async () => {
  const f = await fixture();
  const recovered = await recoverLocalSourceBaseline(f);
  expect(recovered.root).toBe(
    path.join(f.state, "source-baselines", f.request.originalSourceSha, f.request.workspaceDigest),
  );
  expect(recovered.manifest.sourceSha).not.toBe(f.request.originalSourceSha);
  const observed = await committedDevelopmentInventory(
    path.join(recovered.root, "source.git"),
    recovered.manifest.sourceSha,
  );
  expect(observed.workspaceDigest).toBe(f.request.workspaceDigest);
  const replay = await recoverLocalSourceBaseline(f);
  expect(replay.manifest).toEqual(recovered.manifest);
  const scratchDirectories = await readdir(f.state);
  await Promise.all(
    scratchDirectories
      .filter((directory) => directory.startsWith(".source-baseline-recovery-"))
      .map(async (directory) => {
        const diagnostic = z
          .json()
          .parse(JSON.parse(await readFile(path.join(f.state, directory, "result.json"), "utf-8")));
        expect(diagnostic).toEqual({
          root: recovered.root,
          sourceSha: recovered.manifest.sourceSha,
          workspaceDigest: recovered.manifest.workspaceDigest,
        });
      }),
  );
  git(f.source, [
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-qm",
    "Distinct genuine source",
  ]);
  const other = await recoverLocalSourceBaseline({
    ...f,
    request: { ...f.request, originalSourceSha: git(f.source, ["rev-parse", "HEAD"]) },
  });
  expect(other.root).not.toBe(recovered.root);
  expect(other.manifest.workspaceDigest).toBe(recovered.manifest.workspaceDigest);
});

it("rejects bad archive bytes and wrong frozen digest without publishing a baseline", async () => {
  const f = await fixture();
  await expect(
    recoverLocalSourceBaseline({
      ...f,
      request: { ...f.request, workspaceDigest: "0".repeat(64) },
    }),
  ).rejects.toThrow("frozen_digest");
  await expect(
    recoverLocalSourceBaseline({
      ...f,
      request: { ...f.request, archives: [{ ...f.request.archives[0], sha256: "0".repeat(64) }] },
    }),
  ).rejects.toThrow("archive_hash");
});

it("rejects duplicate declarations, traversal and changed executable modes", async () => {
  const f = await fixture();
  const [archive] = f.request.archives;
  if (archive === undefined) {
    throw new Error("Missing fixture archive");
  }
  const [file] = archive.files;
  if (file === undefined) {
    throw new Error("Missing fixture file");
  }
  await expect(
    recoverLocalSourceBaseline({
      ...f,
      request: { ...f.request, archives: [{ ...archive, files: [file, file] }] },
    }),
  ).rejects.toThrow("duplicate_archive_path");
  await expect(
    recoverLocalSourceBaseline({
      ...f,
      request: {
        ...f.request,
        archives: [{ ...archive, files: [{ ...file, path: "../outside" }] }],
      },
    }),
  ).rejects.toThrow();
  await expect(
    recoverLocalSourceBaseline({
      ...f,
      request: { ...f.request, archives: [{ ...archive, files: [{ ...file, mode: "100644" }] }] },
    }),
  ).rejects.toThrow("conflicting_archive_path");
});

it("rejects archive symlinks without interpreting their target", async () => {
  const f = await fixture();
  const linked = path.join(f.root, "linked");
  await mkdir(linked);
  await symlink("/outside/private", path.join(linked, "link"));
  const archive = path.join(f.root, "linked.tar.gz");
  await createTar({ cwd: linked, file: archive, gzip: true }, ["link"]);
  await expect(
    recoverLocalSourceBaseline({
      ...f,
      request: {
        ...f.request,
        archives: [
          { files: [], ignoredMetadata: [], path: archive, sha256: sha(await readFile(archive)) },
        ],
      },
    }),
  ).rejects.toThrow("unsupported_archive_entry");
});
