/* oxlint-disable eslint/no-bitwise, eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Recovery verifies each immutable input and ordered local Git operation before publishing. */
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { t as readTar } from "tar";
import { z } from "zod";
import { readLocalOperatorArtifactAuthority } from "../provisioning/local-operator-artifact-store";
import { readLocalEveCycleBinding } from "../eve/local-cycle-binding";
import {
  committedDevelopmentInventory,
  localBaselineGit,
  localBaselineProcessExit,
  retainLocalSourceBaseline,
} from "./local-source-baseline-store";
import { safeSourcePath } from "./source-path";

const gitExecutable = "/usr/bin/git";
const gitExecutablePath = "/usr/bin:/bin";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sourcePath = z
  .string()
  .refine(
    (value) =>
      safeSourcePath(value) &&
      !value
        .split("/")
        .some((segment) =>
          [".git", "node_modules", ".eve", ".vercel", ".aws", ".ssh"].includes(segment),
        ) &&
      !/(?:^|\/)\.env(?:\.|$)/u.test(value),
    "Unsafe source path",
  );
export const localSourceRecoveryRequestSchema = z.strictObject({
  originalSourceRoot: z.string(),
  originalSourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
  workspaceDigest: digest,
  archives: z.array(
    z.strictObject({
      path: z.string(),
      sha256: digest,
      files: z.array(
        z.strictObject({ path: sourcePath, mode: z.enum(["100644", "100755"]), sha256: digest }),
      ),
      ignoredMetadata: z.array(z.strictObject({ path: sourcePath, sha256: digest })).default([]),
    }),
  ),
});
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const cleanGit = (root: string, args: string[], input?: string) =>
  execFileSync(
    gitExecutable,
    ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", root, ...args],
    {
      input,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        NODE_ENV: "test",
        PATH: gitExecutablePath,
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );

const archiveFileHash = async (filename: string) => {
  const streamHash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) {
    if (!Buffer.isBuffer(chunk)) {
      throw new TypeError("source_baseline_invalid_archive_stream");
    }
    streamHash.update(chunk);
  }
  return streamHash.digest("hex");
};

export const recoverLocalSourceBaseline = async (input: {
  runsRoot: string;
  request: z.input<typeof localSourceRecoveryRequestSchema>;
}) => {
  const request = localSourceRecoveryRequestSchema.parse(input.request);
  if (!path.isAbsolute(input.runsRoot) || path.resolve(input.runsRoot) !== input.runsRoot) {
    throw new Error("source_baseline_authority_unavailable");
  }
  const authority = await readLocalOperatorArtifactAuthority({
    APP_BUILDER_EXECUTION_MODE: "development",
    APP_BUILDER_EXECUTION_BUNDLE: "local-development",
    APP_BUILDER_LOCAL_ADAPTER: "1",
    EVE_HOSTED_ADAPTER: "0",
    APP_BUILDER_SANDBOX_PROVIDER: "vercel",
    APP_BUILDER_DEV_RUNS_ROOT: input.runsRoot,
  });
  if (authority === undefined) {
    throw new Error("source_baseline_authority_unavailable");
  }
  const cycleFile = path.join(authority.stateRoot, "eve-cycle");
  const cycle = readLocalEveCycleBinding(cycleFile);
  const originalRoot = await realpath(request.originalSourceRoot);
  const originalTree = cleanGit(originalRoot, ["rev-parse", `${request.originalSourceSha}^{tree}`])
    .toString()
    .trim();
  const scratch = await mkdtemp(path.join(authority.stateRoot, ".source-baseline-recovery-"));
  const gitRoot = path.join(scratch, "source.git");
  await mkdir(gitRoot, { mode: 0o700 });
  localBaselineGit(gitRoot, ["init", "--bare", "--quiet"]);
  await writeFile(path.join(gitRoot, "shallow"), `${request.originalSourceSha}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  // Transfer genuine tree/blob objects only. The new root capture commit is distinct
  // from the historical source commit; shallow missing history is never invented.
  const objects = [
    request.originalSourceSha,
    originalTree,
    ...cleanGit(originalRoot, ["ls-tree", "-r", "-t", request.originalSourceSha])
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(/\s/u)[2]),
  ];
  const producer = spawn(gitExecutable, ["-C", originalRoot, "pack-objects", "--stdout"], {
    env: {
      NODE_ENV: "test",
      PATH: gitExecutablePath,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const consumer = spawn(
    gitExecutable,
    ["--git-dir", gitRoot, "index-pack", "--stdin", "--strict"],
    {
      env: {
        NODE_ENV: "test",
        PATH: gitExecutablePath,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      stdio: ["pipe", "ignore", "pipe"],
    },
  );
  const produced = localBaselineProcessExit(producer);
  const consumed = localBaselineProcessExit(consumer);
  producer.stderr.resume();
  consumer.stderr.resume();
  producer.stdin.end(`${[...new Set(objects)].join("\n")}\n`);
  await pipeline(producer.stdout, consumer.stdin);
  const producedCode = await produced;
  const consumedCode = await consumed;
  if (producedCode !== 0 || consumedCode !== 0) {
    throw new Error("source_baseline_original_objects_unavailable");
  }
  localBaselineGit(gitRoot, ["read-tree", originalTree]);
  const overlays = new Set<string>();
  const archiveProofs: { path: string; sha256: string; files: number }[] = [];
  for (const archive of request.archives) {
    const archivePath = await realpath(archive.path);
    if ((await archiveFileHash(archivePath)) !== archive.sha256) {
      throw new Error("source_baseline_archive_hash_mismatch");
    }
    const declared = new Map(archive.files.map((file) => [file.path, file]));
    const ignored = new Map(archive.ignoredMetadata.map((file) => [file.path, file]));
    if (
      declared.size !== archive.files.length ||
      ignored.size !== archive.ignoredMetadata.length ||
      [...declared.keys()].some((name) => ignored.has(name))
    ) {
      throw new Error("source_baseline_duplicate_archive_path");
    }
    const seen = new Set<string>();
    const pending: Promise<void>[] = [];
    const entryErrors: Error[] = [];
    await readTar({
      file: archivePath,
      onReadEntry(entry) {
        const name = entry.path.replace(/\/$/u, "");
        if (!sourcePath.safeParse(name).success) {
          entryErrors.push(new Error("source_baseline_unsafe_archive_path"));
          entry.resume();
          return;
        }
        if (entry.type === "Directory") {
          entry.resume();
          return;
        }
        if (entry.type !== "File" || seen.has(name)) {
          entryErrors.push(new Error("source_baseline_unsupported_archive_entry"));
          entry.resume();
          return;
        }
        seen.add(name);
        const file = declared.get(name);
        const metadata = ignored.get(name);
        if (file === undefined && metadata === undefined) {
          entryErrors.push(new Error("source_baseline_undeclared_archive_entry"));
          entry.resume();
          return;
        }
        pending.push(
          (async () => {
            try {
              const chunks: Buffer[] = [];
              for await (const chunk of entry) {
                chunks.push(Buffer.from(chunk));
              }
              const bytes = Buffer.concat(chunks);
              if (hash(bytes) !== (file ?? metadata)?.sha256) {
                throw new Error("source_baseline_file_hash_mismatch");
              }
              if (file === undefined) {
                return;
              }
              if (
                overlays.has(name) ||
                ((entry.mode ?? 0) & 0o111 ? "100755" : "100644") !== file.mode
              ) {
                throw new Error("source_baseline_conflicting_archive_path");
              }
              overlays.add(name);
              const oid = localBaselineGit(gitRoot, ["hash-object", "-w", "--stdin"], bytes)
                .toString()
                .trim();
              localBaselineGit(gitRoot, [
                "update-index",
                "--add",
                "--cacheinfo",
                file.mode,
                oid,
                name,
              ]);
            } catch (error) {
              entryErrors.push(
                error instanceof Error ? error : new Error("source_baseline_archive_read_failed"),
              );
            }
          })(),
        );
      },
    });
    await Promise.all(pending);
    if ((await archiveFileHash(archivePath)) !== archive.sha256) {
      throw new Error("source_baseline_archive_changed");
    }
    if (entryErrors[0] !== undefined) {
      throw entryErrors[0];
    }
    if (seen.size !== declared.size + ignored.size) {
      throw new Error("source_baseline_archive_inventory_incomplete");
    }
    archiveProofs.push({ path: archivePath, sha256: archive.sha256, files: declared.size });
  }
  const tree = localBaselineGit(gitRoot, ["write-tree"]).toString().trim();
  const captured = execFileSync(
    gitExecutable,
    [
      "--git-dir",
      gitRoot,
      "-c",
      "user.name=Autograph Source Baseline Recovery",
      "-c",
      "user.email=source-baseline-recovery@invalid.example",
      "-c",
      "commit.gpgsign=false",
      "commit-tree",
      tree,
      "-p",
      request.originalSourceSha,
    ],
    {
      input: "Explicit source-only baseline recovery capture\n",
      env: {
        NODE_ENV: "test",
        PATH: gitExecutablePath,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    },
  )
    .toString()
    .trim();
  const actual = await committedDevelopmentInventory(gitRoot, captured);
  if (actual.workspaceDigest !== request.workspaceDigest) {
    throw new Error("source_baseline_frozen_digest_mismatch");
  }
  if (readLocalEveCycleBinding(cycleFile) !== cycle) {
    throw new Error("source_baseline_authority_changed");
  }
  const manifest = {
    version: 1 as const,
    kind: "local-planning-source-baseline" as const,
    originalSourceSha: request.originalSourceSha,
    workspaceDigest: request.workspaceDigest,
    sourceSha: captured,
    sourceTree: tree,
    provenance: {
      kind: "recovered-source-archives",
      originalSourceRoot: originalRoot,
      originalSourceTree: originalTree,
      archives: archiveProofs,
      files: actual.files,
    },
  };
  const pack = spawn(gitExecutable, ["--git-dir", gitRoot, "pack-objects", "--stdout", "--revs"], {
    env: {
      NODE_ENV: "test",
      PATH: gitExecutablePath,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  pack.stderr.resume();
  const packed = localBaselineProcessExit(pack);
  pack.stdin.end(`${captured}\n`);
  const packFile = path.join(scratch, "capture.pack");
  await pipeline(pack.stdout, createWriteStream(packFile, { mode: 0o600, flags: "wx" }));
  const packedCode = await packed;
  if (packedCode !== 0) {
    throw new Error("source_baseline_pack_failed");
  }
  const packInput = createReadStream(packFile);
  const chunks = packInput[Symbol.asyncIterator]();
  const result = await retainLocalSourceBaseline({
    authority,
    manifest,
    pack: new ReadableStream<Uint8Array>({
      async pull(controller) {
        const item = await chunks.next();
        if (item.done === true) {
          controller.close();
          return;
        }
        if (!Buffer.isBuffer(item.value)) {
          throw new TypeError("source_baseline_invalid_pack_stream");
        }
        controller.enqueue(item.value);
      },
      cancel() {
        packInput.destroy();
      },
    }),
  });
  await writeFile(
    path.join(scratch, "result.json"),
    `${JSON.stringify({ root: result.root, sourceSha: result.manifest.sourceSha, workspaceDigest: result.manifest.workspaceDigest })}\n`,
    { mode: 0o600, flag: "wx" },
  );
  return result;
};
