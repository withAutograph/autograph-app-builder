import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type { SandboxSession } from "eve/sandbox";
import type { SourceReceipt } from "./source-receipt";
import { safeSourcePath } from "./source-path";
import {
  inspectDevelopmentSourceGeneration,
  recordPreparedSandboxWorkspace,
} from "./supported-template";
import {
  localPlanningGitPresenceProgram,
  initializeLocalPlanningGitBaseProgram,
  importLocalPlanningCurrentCommitProgram,
} from "./local-planning-git-base";
import { getBuilderSandboxId } from "../sandbox/builder-sandbox";
import { processStdoutByteStream } from "./captured-process-output";
import { planningSourceReconciliationProgram } from "./planning-source-reconciliation";
import { ensureSandboxDirectories } from "./sandbox-filesystem";
import { sanitizeValidationDiagnosticText } from "./validation-output-sanitize";
import { z } from "zod";

const objectId = z.string().regex(/^[a-f0-9]{40}$/u);
const gitExecutable = existsSync("/usr/bin/git") ? "/usr/bin/git" : "/bin/git";
const fixedGitArgs = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "credential.helper=",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.file.allow=always",
];
const gitEnvironment = {
  NODE_ENV: process.env.NODE_ENV ?? "production",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_NO_LAZY_FETCH: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Autograph Builder",
  GIT_AUTHOR_EMAIL: "builder@autograph.so",
  GIT_COMMITTER_NAME: "Autograph Builder",
  GIT_COMMITTER_EMAIL: "builder@autograph.so",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  PATH: "/usr/bin:/bin",
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const runGit = (args: readonly string[], input?: string | Buffer) =>
  execFileSync(gitExecutable, [...fixedGitArgs, ...args], {
    encoding: "utf8",
    env: gitEnvironment,
    input,
    maxBuffer: Infinity,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  }).trim();

const assertStableCaptureGeneration = async (
  root: string,
  generation: Awaited<ReturnType<typeof inspectDevelopmentSourceGeneration>>,
  links: readonly [string, string][],
) => {
  const current = await inspectDevelopmentSourceGeneration(root);
  const currentLinks: [string, string][] = [];
  for (const name of current.names) {
    const absolute = path.join(root, name);
    if (lstatSync(absolute).isSymbolicLink()) {
      currentLinks.push([name, readlinkSync(absolute)]);
    }
  }
  const stable = [
    current.sourceSha === generation.sourceSha,
    current.workspaceDigest === generation.workspaceDigest,
    JSON.stringify(current.names) === JSON.stringify(generation.names),
    JSON.stringify(currentLinks) === JSON.stringify(links),
  ].every(Boolean);
  if (!stable) {
    throw new Error(
      "The local source changed while its planning bytes were captured. Prepare again; the app checkout is unchanged.",
    );
  }
};

const selectedLocalSourcePath = (root: string, name: string) => {
  if (!safeSourcePath(name) || name.split("/").includes(".git")) {
    throw new Error("Local source contains an unsafe file path.");
  }
  const absolute = path.join(root, name);
  const parent = realpathSync(path.dirname(absolute));
  if (parent !== root && !parent.startsWith(root + path.sep)) {
    throw new Error("Local source crosses its selected checkout boundary.");
  }
  return absolute;
};

/** Capture actual live bytes into private Git objects; original checkout, refs and index stay untouched. */
export const captureLocalPlanningSource = async (sourcePath: string, originalSourceSha: string) => {
  objectId.parse(originalSourceSha);
  const generation = await inspectDevelopmentSourceGeneration(sourcePath);
  const root = generation.sourcePath;
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "app-builder-local-planning-")));
  const gitDir = path.join(directory, "source.git");
  try {
    runGit([
      "clone",
      "--bare",
      "--shared",
      "--no-hardlinks",
      "--no-tags",
      "--template=",
      root,
      gitDir,
    ]);
    const git = (args: readonly string[], input?: string | Buffer) =>
      runGit(["--git-dir", gitDir, ...args], input);
    git(["cat-file", "-e", `${originalSourceSha}^{commit}`]);
    const sourceSha = objectId.parse(git(["rev-parse", "HEAD"]));
    if (sourceSha !== generation.sourceSha)
      throw new Error(
        "The local source advanced while its planning input was captured. Retry preparation; the app checkout is unchanged.",
      );
    git(["read-tree", "--empty"]);
    const regular: { name: string; absolute: string; mode: string }[] = [];
    const records: string[] = [];
    const links: [string, string][] = [];
    for (const name of generation.names) {
      const absolute = selectedLocalSourcePath(root, name);
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) {
        const target = readlinkSync(absolute);
        links.push([name, target]);
        const oid = objectId.parse(
          git(["hash-object", "-w", "--no-filters", "--stdin"], Buffer.from(target)),
        );
        records.push(`120000 ${oid}\t${name}`);
      } else if (info.isFile()) {
        // oxlint-disable-next-line eslint/no-bitwise -- Preserve the actual executable mode.
        regular.push({ name, absolute, mode: (info.mode & 0o111) === 0 ? "100644" : "100755" });
      } else
        throw new Error(
          "The local source contains a non-file Git entry that cannot be reconciled; the app checkout is unchanged.",
        );
    }
    // Batch argv for the operating system's command limit, without a total file limit.
    for (let offset = 0; offset < regular.length; offset += 256) {
      const batch = regular.slice(offset, offset + 256);
      const ids = git([
        "hash-object",
        "-w",
        "--no-filters",
        "--",
        ...batch.map((file) => file.absolute),
      ])
        .split("\n")
        .map((value) => objectId.parse(value));
      if (ids.length !== batch.length)
        throw new Error("Git did not capture every selected local source file.");
      for (const [index, file] of batch.entries()) {
        records.push(`${file.mode} ${ids[index]}\t${file.name}`);
      }
    }
    git(["update-index", "-z", "--index-info"], Buffer.from(records.join("\0") + "\0"));
    const snapshotTree = objectId.parse(git(["write-tree"]));
    await assertStableCaptureGeneration(root, generation, links);
    // This is a private planning tree, not host Git history. Parent only the
    // actual retained base so an incremental bundle never requires unrelated
    // merged host ancestors that the file-archive candidate does not possess.
    const snapshotSha = objectId.parse(
      git(
        ["commit-tree", snapshotTree, "-p", originalSourceSha],
        "Current local Builder planning source\n",
      ),
    );
    const originalBase = (expectedWorkspaceDigest: string) => {
      z.string()
        .regex(/^[a-f0-9]{64}$/u)
        .parse(expectedWorkspaceDigest);
      const baseTree = objectId.parse(git(["rev-parse", `${originalSourceSha}^{tree}`]));
      const entries = git(["ls-tree", "-rz", "-t", "--full-tree", originalSourceSha])
        .split("\0")
        .filter(Boolean)
        .map((line) => {
          const match =
            /^(?<mode>040000|100644|100755) (?<type>tree|blob) (?<oid>[a-f0-9]{40})\t(?<path>.+)$/u.exec(
              line,
            )?.groups;
          if (
            match === undefined ||
            !safeSourcePath(match.path) ||
            match.path.split("/").includes(".git")
          ) {
            throw new Error(
              "The retained original source has unsupported entries; no candidate metadata was changed.",
            );
          }
          return {
            mode: match.mode,
            type: match.type,
            oid: objectId.parse(match.oid),
            path: match.path,
          };
        });
      const blobs = [
        ...new Set(entries.flatMap((entry) => (entry.type === "blob" ? [entry.oid] : []))),
      ];
      const bytes = execFileSync(
        gitExecutable,
        [...fixedGitArgs, "--git-dir", gitDir, "cat-file", "--batch"],
        {
          env: gitEnvironment,
          input: blobs.join("\n") + "\n",
          maxBuffer: Infinity,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let offset = 0;
      const digests = new Map<string, string>();
      for (const expected of blobs) {
        const end = bytes.indexOf(10, offset);
        if (end === -1) {
          throw new Error("The retained original source object stream is incomplete.");
        }
        const header = /^(?<oid>[a-f0-9]{40}) blob (?<size>[0-9]+)$/u.exec(
          bytes.subarray(offset, end).toString("utf-8"),
        )?.groups;
        if (header === undefined || header.oid !== expected) {
          throw new Error("The retained original source object identity is invalid.");
        }
        const length = Number(header.size);
        offset = end + 1;
        if (
          !Number.isSafeInteger(length) ||
          offset + length >= bytes.length ||
          bytes[offset + length] !== 10
        ) {
          throw new Error("The retained original source object bytes are incomplete.");
        }
        digests.set(
          expected,
          createHash("sha256")
            .update(bytes.subarray(offset, offset + length))
            .digest("hex"),
        );
        offset += length + 1;
      }
      if (offset !== bytes.length) {
        throw new Error("The retained original source object stream has unexpected bytes.");
      }
      const files = entries
        .filter((entry) => entry.type === "blob")
        .toSorted((a, b) => {
          if (a.path < b.path) {
            return -1;
          }
          if (a.path > b.path) {
            return 1;
          }
          return 0;
        })
        .map((entry) => {
          const digest = digests.get(entry.oid);
          if (digest === undefined) {
            throw new Error("The original source object digest is missing.");
          }
          return {
            mode: entry.mode,
            objectId: digest.slice(0, 40),
            path: entry.path,
            sha256: digest,
          };
        });
      if (hash(JSON.stringify(files)) !== expectedWorkspaceDigest) {
        throw new Error(
          "The retained original source Git bytes do not match the saved planning baseline. The candidate is unchanged; recover its original source artifact before reconciling.",
        );
      }
      const objects = [
        ...new Set([originalSourceSha, baseTree, ...entries.map((entry) => entry.oid)]),
      ];
      const prefix = path.join(directory, "original-base");
      const packId = objectId.parse(git(["pack-objects", prefix], objects.join("\n") + "\n"));
      return {
        sourceSha: originalSourceSha,
        sourceTree: baseTree,
        streamPack: () => processStdoutByteStream("/bin/cat", [`${prefix}-${packId}.pack`]),
      };
    };
    const currentCommit = () => {
      const sourceTree = objectId.parse(git(["rev-parse", `${sourceSha}^{tree}`]));
      const objects = [
        sourceSha,
        ...git(["rev-list", "--objects", "--no-object-names", sourceTree]).split("\n"),
      ];
      const prefix = path.join(directory, "current-commit");
      const packId = objectId.parse(git(["pack-objects", prefix], `${objects.join("\n")}\n`));
      return {
        sourceSha,
        sourceTree,
        streamPack: () => processStdoutByteStream("/bin/cat", [`${prefix}-${packId}.pack`]),
      };
    };
    const reference = `refs/app-builder/local-source/${snapshotSha}`;
    git(["update-ref", reference, snapshotSha]);
    return {
      generation,
      originalBase,
      currentCommit,
      sourceSha,
      snapshotSha,
      snapshotTree,
      needsBundle: snapshotSha !== originalSourceSha,
      streamBundle: () =>
        processStdoutByteStream(
          gitExecutable,
          [
            ...fixedGitArgs,
            "--git-dir",
            gitDir,
            "bundle",
            "create",
            "-",
            reference,
            `^${originalSourceSha}`,
          ],
          { env: gitEnvironment },
        ),
      dispose: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
};

const reconciliationOutcome = z.strictObject({
  changed: z.boolean(),
  checkpointRef: z.string(),
  sourceSha: objectId,
  sourceTree: objectId,
});
/** Reuse the one owned three-way reconciliation engine. No provider/GitHub operation or old approval is replayed. */
export const reconcileLocalPlanningSource = async (input: {
  assertCurrent: () => void;
  sandbox: SandboxSession;
  sessionId: string;
  appId: string;
  callId: string;
  originalSourceSha: string;
  originalWorkspaceDigest: string;
  sourceOverlay?: { sourceSha: string; workspaceDigest: string };
  workspaceId: string;
  receipt: Pick<SourceReceipt, "sourceSha" | "sourceTree" | "eligibilityDigest">;
  capture: Awaited<ReturnType<typeof captureLocalPlanningSource>>;
}) => {
  const { capture, sandbox } = input;
  if (capture.sourceSha !== input.receipt.sourceSha)
    throw new Error(
      "The selected local source advanced during capture. Prepare again; the candidate is retained.",
    );
  input.assertCurrent();
  if (getBuilderSandboxId(sandbox) !== input.workspaceId) {
    throw new Error("The original local source belongs to another saved workspace.");
  }
  const presence = await sandbox.run({
    command: `node -e ${quote(localPlanningGitPresenceProgram)} ${quote(JSON.stringify({ root: "/workspace/repository" }))}`,
    workingDirectory: "/workspace",
  });
  input.assertCurrent();
  if (presence.exitCode !== 0) {
    throw new Error(
      `The saved local candidate Git boundary is unavailable; its source is retained. ${sanitizeValidationDiagnosticText(presence.stderr || presence.stdout)}`,
    );
  }
  if (!z.strictObject({ present: z.boolean() }).parse(JSON.parse(presence.stdout)).present) {
    const baseline = capture.originalBase(input.originalWorkspaceDigest);
    if (baseline.sourceSha !== input.originalSourceSha) {
      throw new Error("The verified original Git base does not match this saved planning source.");
    }
    const pack = `.app-builder/local-source/${hash(input.sessionId)}/original-${baseline.sourceSha}.pack`;
    await ensureSandboxDirectories(sandbox, [path.posix.dirname(pack)]);
    input.assertCurrent();
    await sandbox.writeFile({ path: pack, content: baseline.streamPack() });
    input.assertCurrent();
    const initialization = {
      root: "/workspace/repository",
      stateRoot: `/workspace/.app-builder/local-source/${hash(input.sessionId)}`,
      packPath: `/workspace/${pack}`,
      sourceSha: baseline.sourceSha,
      sourceTree: baseline.sourceTree,
    };
    const initialized = await sandbox.run({
      command: `node -e ${quote(initializeLocalPlanningGitBaseProgram)} ${quote(JSON.stringify(initialization))}`,
      workingDirectory: "/workspace",
    });
    input.assertCurrent();
    if (initialized.exitCode !== 0) {
      throw new Error(
        `The proven original Git baseline could not be installed; candidate bytes are retained. ${sanitizeValidationDiagnosticText(initialized.stderr || initialized.stdout)}`,
      );
    }
  }
  if (capture.sourceSha !== input.originalSourceSha) {
    const current = capture.currentCommit();
    const pack = `.app-builder/local-source/${hash(input.sessionId)}/current-${current.sourceSha}.pack`;
    await ensureSandboxDirectories(sandbox, [path.posix.dirname(pack)]);
    input.assertCurrent();
    await sandbox.writeFile({ path: pack, content: current.streamPack() });
    input.assertCurrent();
    const currentIdentity = {
      root: "/workspace/repository",
      packPath: `/workspace/${pack}`,
      sourceSha: current.sourceSha,
      sourceTree: current.sourceTree,
    };
    const imported = await sandbox.run({
      command: `node -e ${quote(importLocalPlanningCurrentCommitProgram)} ${quote(JSON.stringify(currentIdentity))}`,
      workingDirectory: "/workspace",
    });
    input.assertCurrent();
    if (imported.exitCode !== 0) {
      throw new Error(
        `Current captured source identity could not be retained; candidate files are unchanged. ${sanitizeValidationDiagnosticText(imported.stderr || imported.stdout)}`,
      );
    }
  }
  const bundle = `.app-builder/local-source/${hash(input.sessionId)}/${capture.snapshotSha}.bundle`;
  if (capture.needsBundle) {
    await ensureSandboxDirectories(sandbox, [path.posix.dirname(bundle)]);
    input.assertCurrent();
    await sandbox.writeFile({ path: bundle, content: capture.streamBundle() });
  }
  input.assertCurrent();
  const oldCommit = quote(`${objectId.parse(input.originalSourceSha)}^{commit}`);
  const commands = [
    `git -c core.hooksPath=/dev/null -c protocol.allow=never -c protocol.file.allow=always -c credential.helper= cat-file -e ${oldCommit}`,
  ];
  if (capture.needsBundle) {
    const bundlePath = quote(`/workspace/${bundle}`);
    commands.push(
      `git -c core.hooksPath=/dev/null -c protocol.allow=never -c protocol.file.allow=always -c credential.helper= fetch --quiet --no-tags --no-write-fetch-head --no-recurse-submodules ${bundlePath} ${quote(capture.snapshotSha)}`,
    );
  }
  const imported = await sandbox.run({
    command: commands.join(" && "),
    workingDirectory: "/workspace/repository",
  });
  if (imported.exitCode !== 0)
    throw new Error(
      `Builder could not read the original private source base or import current local planning objects. The candidate is retained. ${sanitizeValidationDiagnosticText(imported.stderr || imported.stdout)}`,
    );
  const request = {
    appId: input.appId,
    branchRef: "refs/app-builder/local-source",
    fetchRemote: false,
    localSource: true,
    ...(input.sourceOverlay === undefined
      ? {}
      : {
          managedOverlayWorkspaceDigest: z
            .string()
            .regex(/^[a-f0-9]{64}$/u)
            .parse(input.sourceOverlay.workspaceDigest),
          managedOverlayManifestPath: "/workspace/.app-builder/source-files.json",
        }),
    originalSourceSha: objectId.parse(input.originalSourceSha),
    root: "/workspace/repository",
    sessionId: input.sessionId,
    stateRoot: "/workspace/.app-builder/source-reconciliation",
    targetSha: capture.snapshotSha,
  };
  input.assertCurrent();
  const reconciled = await sandbox.run({
    command: `node -e ${quote(planningSourceReconciliationProgram)} ${quote(JSON.stringify(request))}`,
    workingDirectory: "/workspace/repository",
  });
  if (reconciled.exitCode !== 0)
    throw new Error(
      `Builder could not reconcile current local source. Original app and platform bytes remain checkpointed; resolve the reported conflict and prepare again. ${sanitizeValidationDiagnosticText(reconciled.stderr || reconciled.stdout)}`,
    );
  const outcome = reconciliationOutcome.parse(JSON.parse(reconciled.stdout));
  const { generation } = capture;
  input.assertCurrent();
  const workspace = await recordPreparedSandboxWorkspace({
    sandbox,
    callId: input.callId,
    sourcePath: generation.sourcePath,
    sourceSha: input.receipt.sourceSha,
    sourceTree: generation.generation,
    eligibilityDigest: input.receipt.eligibilityDigest,
    workspaceDigest: generation.workspaceDigest,
  });
  input.assertCurrent();
  await sandbox.writeTextFile({
    path: ".app-builder/source-files.json",
    content: JSON.stringify(generation.sourceFiles) + "\n",
  });
  input.assertCurrent();
  await sandbox.writeTextFile({
    path: ".app-builder/source-checksums.sha256",
    content:
      generation.sourceFiles.map((file) => `${file.sha256}  repository/${file.path}`).join("\n") +
      "\n",
  });
  return {
    workspace,
    ...outcome,
    selectedSourceSha: input.receipt.sourceSha,
    selectedSourceTree: input.receipt.sourceTree,
    sourceSnapshotTree: capture.snapshotTree,
  };
};
