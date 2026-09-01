import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  lstat,
  link,
  mkdtemp,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
  chmod,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  assertExactProposal,
  assertExactReviewedChangeSet,
  assertCanonicalLocalPublicationJournal,
  contentDigest,
  createLocalPublicationProposal,
  exactProposalMatch,
  LOCAL_PUBLICATION_MAX_CHANGE_BYTES,
  LOCAL_PUBLICATION_MAX_DIRTY_BYTES,
  LOCAL_PUBLICATION_MAX_FILE_BYTES,
  pathsOverlap,
  proposalFromJournal,
  receiptDigest,
  stableDigest,
  unrelatedProjectionDigest,
  type DestinationSnapshot,
  type DirtyPathSnapshot,
  type LocalPublicationFailureReceipt,
  type LocalPublicationJournal,
  type LocalPublicationPendingReceipt,
  type LocalPublicationProposal,
  type LocalPublicationResult,
  type LocalPublicationSuccessReceipt,
  type PublicationPathEvidence,
} from "./local-publication";
import type { ReviewedChangeSetReceipt } from "./reviewed-change-set";
import {
  resolveAllowedRepository,
  SUPPORTED_REPOSITORY_CONTRACT,
} from "./supported-template";
import {
  inspectSourceContractDigest,
  type SourceReceipt,
} from "./source-receipt";
import { safeSourcePath } from "./source-path";
import { compareOverlayPaths } from "./target-apply";

type FileState = {
  kind: "absent" | "regular" | "directory" | "symlink" | "special";
  mode?: string;
  bytes?: Uint8Array;
  digest?: string;
};

export type LocalPublicationFaultHooks = {
  beforeMutation?: (path: string, index: number) => void | Promise<void>;
  afterMutation?: (path: string, index: number) => void | Promise<void>;
  beforeRollback?: (path: string, index: number) => void | Promise<void>;
  beforeGitApply?: () => void | Promise<void>;
  afterGitApply?: () => void | Promise<void>;
  dispatchGitApply?: () => void | Promise<void>;
  beforeUncertainClassification?: (
    path: string,
    index: number,
  ) => void | Promise<void>;
  afterPendingJournal?: () => void | Promise<void>;
  beforeTerminalJournalWrite?: (
    status: "succeeded" | "failed",
  ) => void | Promise<void>;
  preservePendingOnFailure?: boolean;
};

function fixedGitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_EXTERNAL_DIFF",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
  ])
    delete environment[name];
  return environment;
}

function fixedGitApply(
  root: string,
  patch: Uint8Array,
  options: { reverse?: boolean; check?: boolean } = {},
): void {
  const result = spawnSync(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "diff.external=",
      "-c",
      "core.attributesfile=/dev/null",
      "-C",
      root,
      "apply",
      ...(options.reverse ? ["--reverse"] : []),
      ...(options.check ? ["--check"] : []),
      "--binary",
      "--whitespace=nowarn",
      "-",
    ],
    {
      input: patch,
      env: fixedGitEnvironment(),
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.status !== 0)
    throw new Error(
      `Fixed git apply failed: ${result.stderr.toString("utf8").trim() || "unknown error"}`,
    );
}

async function materializePatchFile(
  root: string,
  side: "old" | "new",
  path: string,
  state: { bytes: Uint8Array; mode: string } | undefined,
): Promise<void> {
  if (state === undefined) return;
  const target = resolve(root, side, path);
  await mkdir(dirname(target), { recursive: true, mode: 0o755 });
  await writeFile(target, state.bytes, {
    flag: "wx",
    mode: Number.parseInt(state.mode, 8),
  });
  await chmod(target, Number.parseInt(state.mode, 8));
}

async function buildExactGitPatch(input: {
  gitDirectoryPath: string;
  executionPaths: readonly string[];
  changes: LocalPublicationProposal["changes"];
  preimages: ReadonlyMap<string, FileState>;
  overlay: ReadonlyMap<string, Uint8Array>;
}): Promise<Uint8Array> {
  const scratchParent = resolve(input.gitDirectoryPath, "app-builder");
  await mkdir(scratchParent, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(resolve(scratchParent, "publication-patch-"));
  const chunks: Buffer[] = [];
  try {
    for (const path of input.executionPaths) {
      const change = input.changes.find(
        (candidate) => candidate.path === path,
      )!;
      const item = await mkdtemp(resolve(scratch, "item-"));
      await Promise.all([
        mkdir(resolve(item, "old")),
        mkdir(resolve(item, "new")),
      ]);
      const before = input.preimages.get(path)!;
      await materializePatchFile(
        item,
        "old",
        path,
        before.kind === "regular" &&
          before.bytes !== undefined &&
          before.mode !== undefined
          ? { bytes: before.bytes, mode: before.mode }
          : undefined,
      );
      const afterBytes = input.overlay.get(path);
      await materializePatchFile(
        item,
        "new",
        path,
        change.after !== undefined && afterBytes !== undefined
          ? { bytes: afterBytes, mode: change.after.mode }
          : undefined,
      );
      const result = spawnSync(
        "git",
        [
          "diff",
          "--no-index",
          "--binary",
          "--no-prefix",
          "--no-renames",
          "--",
          "old",
          "new",
        ],
        { cwd: item, env: fixedGitEnvironment(), maxBuffer: 64 * 1024 * 1024 },
      );
      if (result.status !== 1)
        throw new Error(
          `Could not build the exact publication patch for ${path}.`,
        );
      chunks.push(result.stdout);
    }
    return Buffer.concat(chunks);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function git(path: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", path, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

function fieldAfter(record: string, spaceCount: number): string {
  let offset = 0;
  for (let count = 0; count < spaceCount; count += 1) {
    offset = record.indexOf(" ", offset);
    if (offset < 0)
      throw new Error("Git returned malformed porcelain-v2 status.");
    offset += 1;
  }
  return record.slice(offset);
}

export type ParsedGitStatus = {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  indexMode?: string;
  indexObjectId?: string;
};

function statusMetadata(record: string): {
  indexMode?: string;
  indexObjectId?: string;
} {
  const fields = record.split(" ");
  const indexMode = fields[4];
  const indexObjectId = fields[7];
  return indexMode !== undefined && indexObjectId !== undefined
    ? { indexMode, indexObjectId }
    : {};
}

/** Parse `git status --porcelain=v2 -z`; rename records consume two NUL fields. */
export function parseGitStatusV2(output: string): readonly ParsedGitStatus[] {
  const records = output.split("\0");
  const result: ParsedGitStatus[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === "" || record.startsWith("# ") || record.startsWith("! "))
      continue;
    if (record.startsWith("? ")) {
      result.push({
        path: record.slice(2),
        indexStatus: "?",
        worktreeStatus: "?",
      });
      continue;
    }
    if (record.startsWith("1 ")) {
      const xy = record.slice(2, 4);
      result.push({
        path: fieldAfter(record, 8),
        ...statusMetadata(record),
        indexStatus: xy[0] ?? ".",
        worktreeStatus: xy[1] ?? ".",
      });
      continue;
    }
    if (record.startsWith("2 ")) {
      const xy = record.slice(2, 4);
      const path = fieldAfter(record, 9);
      const originalPath = records[index + 1];
      if (originalPath === undefined || originalPath === "")
        throw new Error("Git returned a truncated rename record.");
      index += 1;
      result.push({
        path,
        originalPath,
        ...statusMetadata(record),
        indexStatus: xy[0] ?? ".",
        worktreeStatus: xy[1] ?? ".",
      });
      continue;
    }
    if (record.startsWith("u ")) {
      const xy = record.slice(2, 4);
      result.push({
        path: fieldAfter(record, 10),
        ...statusMetadata(record),
        indexStatus: xy[0] ?? "U",
        worktreeStatus: xy[1] ?? "U",
      });
      continue;
    }
    throw new Error("Git returned an unsupported porcelain-v2 status record.");
  }
  return result.toSorted((left, right) =>
    compareOverlayPaths(left.path, right.path),
  );
}

async function fileState(
  path: string,
  includeBytes = true,
): Promise<FileState> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return { kind: "symlink" };
    if (stat.isDirectory())
      return { kind: "directory", mode: (stat.mode & 0o777).toString(8) };
    if (!stat.isFile())
      return { kind: "special", mode: (stat.mode & 0o777).toString(8) };
    if (stat.size > LOCAL_PUBLICATION_MAX_FILE_BYTES)
      throw new Error(`File exceeds the local-publication size limit: ${path}`);
    const bytes = includeBytes ? await readFile(path) : undefined;
    return {
      kind: "regular",
      mode: (stat.mode & 0o777).toString(8),
      ...(bytes === undefined ? {} : { bytes, digest: contentDigest(bytes) }),
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "absent" };
    throw error;
  }
}

async function dirtyEntry(
  root: string,
  parsed: ParsedGitStatus,
): Promise<DirtyPathSnapshot> {
  if (
    !safeSourcePath(parsed.path) ||
    (parsed.originalPath !== undefined && !safeSourcePath(parsed.originalPath))
  )
    throw new Error("Git reported an unsafe dirty path.");
  const state = await fileState(resolve(root, parsed.path));
  return {
    ...parsed,
    kind: state.kind,
    ...(state.mode === undefined ? {} : { mode: state.mode }),
    ...(state.bytes === undefined
      ? {}
      : {
          size: state.bytes.byteLength,
          contentDigest: state.digest,
          contentBase64: Buffer.from(state.bytes).toString("base64"),
        }),
  };
}

export async function inspectLocalPublicationDestination(input: {
  destinationPath: string;
  sourceReceipt: SourceReceipt;
}): Promise<DestinationSnapshot> {
  if (resolve(input.destinationPath) !== input.sourceReceipt.sourcePath)
    throw new Error(
      "The destination must be the canonical original source path, not a symlink or alias.",
    );
  const canonicalPath = await resolveAllowedRepository(input.destinationPath);
  if (canonicalPath !== input.sourceReceipt.sourcePath)
    throw new Error(
      "The selected destination is not the exact original source checkout.",
    );
  const [headSha, headTree] = [
    git(canonicalPath, ["rev-parse", "HEAD"]).trim(),
    git(canonicalPath, ["rev-parse", "HEAD^{tree}"]).trim(),
  ];
  const headReference = git(canonicalPath, [
    "rev-parse",
    "--symbolic-full-name",
    "HEAD",
  ]).trim();
  const gitDirectoryPath = await realpath(
    git(canonicalPath, ["rev-parse", "--absolute-git-dir"]).trim(),
  );
  const [rootStat, gitDirectoryStat] = await Promise.all([
    lstat(canonicalPath),
    lstat(gitDirectoryPath),
  ]);
  const indexPath = await gitOwnedPath(canonicalPath, "index");
  const indexFileDigest = contentDigest(await readFile(indexPath));
  const remoteDigest = stableDigest(git(canonicalPath, ["remote", "-v"]));
  if (!rootStat.isDirectory() || !gitDirectoryStat.isDirectory())
    throw new Error("The repository root or Git directory is not a directory.");
  const parsed = parseGitStatusV2(
    git(canonicalPath, [
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
    ]),
  );
  const dirty = await Promise.all(
    parsed.map((entry) => dirtyEntry(canonicalPath, entry)),
  );
  const indexPaths = [
    ...new Set(
      parsed
        .flatMap((entry) => [entry.path, entry.originalPath])
        .filter((path): path is string => path !== undefined),
    ),
  ].toSorted(compareOverlayPaths);
  const index = indexPaths.map((path) => {
    const entries = execFileSync(
      "git",
      ["-C", canonicalPath, "ls-files", "--stage", "-z", "--", path],
      { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 },
    );
    return {
      path,
      entriesBase64: entries.toString("base64"),
      digest: contentDigest(entries),
    };
  });
  const totalBytes = dirty.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  if (totalBytes > LOCAL_PUBLICATION_MAX_DIRTY_BYTES)
    throw new Error(
      "The unrelated dirty snapshot exceeds the local-publication size limit.",
    );
  const dirtyDigest = stableDigest(dirty);
  const stable = {
    canonicalPath,
    rootIdentity: {
      device: rootStat.dev.toString(),
      inode: rootStat.ino.toString(),
    },
    gitDirectoryPath,
    gitDirectoryIdentity: {
      device: gitDirectoryStat.dev.toString(),
      inode: gitDirectoryStat.ino.toString(),
    },
    headSha,
    headTree,
    headReference,
    indexFileDigest,
    remoteDigest,
    contractDigest: inspectSourceContractDigest(
      canonicalPath,
      headSha,
      SUPPORTED_REPOSITORY_CONTRACT.requiredPaths,
    ),
    dirty,
    index,
    dirtyDigest,
  };
  return { ...stable, statusDigest: stableDigest(stable) };
}

export async function deriveLocalPublicationProposal(input: {
  destinationPath: string;
  sourceReceipt: SourceReceipt;
  review: ReviewedChangeSetReceipt;
}): Promise<LocalPublicationProposal> {
  const destination = await inspectLocalPublicationDestination(input);
  return createLocalPublicationProposal({
    sourceReceipt: input.sourceReceipt,
    destination,
    review: input.review,
  });
}

function assertFileMatches(
  state: FileState,
  expected: { mode: string; digest: string } | undefined,
): boolean {
  return expected === undefined
    ? state.kind === "absent"
    : state.kind === "regular" &&
        state.mode === expected.mode &&
        state.digest === expected.digest;
}

async function safeTarget(
  root: string,
  relativePath: string,
  createParents: boolean,
  createdDirs: string[],
): Promise<string> {
  if (!safeSourcePath(relativePath))
    throw new Error("The approved path is unsafe.");
  const target = resolve(root, relativePath);
  if (!within(root, target))
    throw new Error("The approved path escapes the destination.");
  const segments = relativePath.split("/").slice(0, -1);
  let cursor = root;
  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    const state = await fileState(cursor, false);
    if (state.kind === "absent" && createParents) {
      await mkdir(cursor, { mode: 0o755 });
      createdDirs.push(cursor);
    } else if (state.kind === "absent") {
      continue;
    } else if (state.kind !== "directory") {
      throw new Error(
        "The approved path traverses a symlink or non-directory entry.",
      );
    }
  }
  const leaf = await fileState(target, false);
  if (
    leaf.kind === "symlink" ||
    leaf.kind === "directory" ||
    leaf.kind === "special"
  )
    throw new Error("The approved path names a symlink or non-regular entry.");
  return target;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(
  path: string,
  bytes: Uint8Array,
  mode: string,
  expectedPreimage?: FileState,
): Promise<void> {
  const temporary = `${path}.app-builder-${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", Number.parseInt(mode, 8));
  try {
    await handle.writeFile(bytes);
    await handle.chmod(Number.parseInt(mode, 8));
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  if (
    expectedPreimage !== undefined &&
    !sameFileState(await fileState(path), expectedPreimage)
  ) {
    await unlink(temporary).catch(() => undefined);
    throw new Error(
      "The file changed while its atomic replacement was prepared.",
    );
  }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

function sameFileState(left: FileState, right: FileState): boolean {
  return (
    left.kind === right.kind &&
    left.mode === right.mode &&
    left.digest === right.digest
  );
}

async function gitOwnedPath(root: string, name: string): Promise<string> {
  return resolve(
    git(root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      name,
    ]).trim(),
  );
}

async function writeJournal(
  path: string,
  journal: LocalPublicationJournal,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await atomicWrite(path, Buffer.from(`${JSON.stringify(journal)}\n`), "644");
}

async function createInitialJournal(
  path: string,
  journal: LocalPublicationPendingReceipt,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const candidate = `${path}.pending-${randomUUID()}`;
  await atomicWrite(
    candidate,
    Buffer.from(`${JSON.stringify(journal)}\n`),
    "644",
  );
  try {
    // A hard link is an atomic no-overwrite compare-and-swap on this filesystem.
    await link(candidate, path);
    await syncDirectory(dirname(path));
  } finally {
    await unlink(candidate).catch(() => undefined);
  }
}

export async function readLocalPublicationJournal(
  destinationPath: string,
): Promise<LocalPublicationJournal | undefined> {
  const root = await resolveAllowedRepository(destinationPath);
  const path = await gitOwnedPath(root, "app-builder/local-publication.json");
  try {
    const journal = JSON.parse(
      await readFile(path, "utf8"),
    ) as LocalPublicationJournal;
    assertJournal(journal);
    return journal;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("The durable local-publication journal is unreadable.", {
      cause: error,
    });
  }
}

function assertJournal(journal: LocalPublicationJournal): void {
  if (
    journal === null ||
    typeof journal !== "object" ||
    (journal.status !== "pending" &&
      journal.status !== "succeeded" &&
      journal.status !== "failed")
  )
    throw new Error(
      "The durable local-publication journal has an unsupported state.",
    );
  assertCanonicalLocalPublicationJournal(journal);
}

async function acquireLock(root: string): Promise<() => Promise<void>> {
  const lockPath = await gitOwnedPath(
    root,
    "app-builder/local-publication.lock",
  );
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch {
    throw new Error("A local-publication attempt is already in progress.");
  }
  return async () => {
    await rmdir(lockPath).catch(() => undefined);
  };
}

function pathEvidence(
  proposal: LocalPublicationProposal,
): readonly PublicationPathEvidence[] {
  return proposal.changes.map((change) => ({
    path: change.path,
    operation: change.kind,
    ...(change.before === undefined ? {} : { before: change.before }),
    ...(change.after === undefined ? {} : { after: change.after }),
  }));
}

async function verifyPreconditions(input: {
  proposal: LocalPublicationProposal;
  sourceReceipt: SourceReceipt;
  review: ReviewedChangeSetReceipt;
}): Promise<DestinationSnapshot> {
  assertExactProposal(input.proposal);
  assertExactReviewedChangeSet(input.review);
  if (
    input.proposal.sourceReceiptDigest !== input.sourceReceipt.digest ||
    input.proposal.reviewDigest !== input.review.digest ||
    input.proposal.changeSetDigest !== input.review.changeSetDigest
  )
    throw new Error(
      "The source, review, or approved proposal changed before publication.",
    );
  const snapshot = await inspectLocalPublicationDestination({
    destinationPath: input.proposal.destinationPath,
    sourceReceipt: input.sourceReceipt,
  });
  const current = createLocalPublicationProposal({
    sourceReceipt: input.sourceReceipt,
    destination: snapshot,
    review: input.review,
  });
  if (!exactProposalMatch(current, input.proposal))
    throw new Error("The destination preconditions changed after approval.");
  for (const change of input.proposal.changes) {
    const target = await safeTarget(
      snapshot.canonicalPath,
      change.path,
      false,
      [],
    );
    if (!assertFileMatches(await fileState(target), change.before))
      throw new Error(`The approved preimage changed for ${change.path}.`);
  }
  return snapshot;
}

export async function verifyPublishedChangeSet(input: {
  receipt: LocalPublicationSuccessReceipt;
  sourceReceipt: SourceReceipt;
  review: ReviewedChangeSetReceipt;
}): Promise<void> {
  assertCanonicalLocalPublicationJournal(input.receipt);
  assertExactProposal(proposalFromJournal(input.receipt));
  assertExactReviewedChangeSet(input.review);
  if (
    input.receipt.sourceReceiptDigest !== input.sourceReceipt.digest ||
    input.receipt.reviewDigest !== input.review.digest ||
    input.receipt.changeSetDigest !== input.review.changeSetDigest ||
    input.receipt.destinationPath !== input.sourceReceipt.sourcePath
  )
    throw new Error(
      "The successful publication no longer matches the exact workflow or review.",
    );
  const root = await resolveAllowedRepository(input.receipt.destinationPath);
  if (
    git(root, ["rev-parse", "HEAD"]).trim() !== input.receipt.baseSha ||
    git(root, ["rev-parse", "HEAD^{tree}"]).trim() !== input.receipt.sourceTree
  )
    throw new Error(
      "The destination Git identity changed after local publication.",
    );
  for (const change of input.receipt.changes) {
    const target = await safeTarget(root, change.path, false, []);
    if (!assertFileMatches(await fileState(target), change.after))
      throw new Error(
        `The local-publication postimage changed for ${change.path}.`,
      );
  }
  if (
    input.receipt.postconditionDigest !==
    stableDigest(
      input.receipt.pathEvidence.map(({ path, after: postimage }) => ({
        path,
        postimage,
      })),
    )
  )
    throw new Error("The local-publication postcondition digest is malformed.");
  const destination = await inspectLocalPublicationDestination({
    destinationPath: root,
    sourceReceipt: input.sourceReceipt,
  });
  if (
    destination.statusDigest !== input.receipt.afterStatusDigest ||
    unrelatedProjectionDigest(destination, input.receipt.approvedPaths) !==
      input.receipt.unrelatedProjectionDigest
  )
    throw new Error(
      "The destination status or unrelated-work projection changed after publication.",
    );
  const durable = await readLocalPublicationJournal(root);
  if (
    durable?.status !== "succeeded" ||
    durable.digest !== input.receipt.digest
  )
    throw new Error(
      "The durable local-publication journal does not match the success receipt.",
    );
}

export async function publishReviewedChangeSet(input: {
  proposal: LocalPublicationProposal;
  sourceReceipt: SourceReceipt;
  review: ReviewedChangeSetReceipt;
  readOverlayFile: (path: string) => Promise<Uint8Array | null>;
  publishedByCallId: string;
  hooks?: LocalPublicationFaultHooks;
}): Promise<LocalPublicationResult> {
  if (process.env.APP_BUILDER_LOCAL_PUBLICATION !== "1")
    throw new Error(
      "Local publication is disabled until APP_BUILDER_LOCAL_PUBLICATION=1 is explicitly configured.",
    );
  const { digest: proposalDigest, ...proposalFields } = input.proposal;
  let release: (() => Promise<void>) | undefined;
  const preimages = new Map<string, FileState>();
  const overlay = new Map<string, Uint8Array>();
  let patch: Uint8Array | undefined;
  let appliedPaths: string[] = [];
  let mutationDispatched = false;
  let mutationCallReturned = false;
  let beforeStatusDigest = "unobserved";
  let pendingWritten = false;
  let failureMessage = "Local publication failed before mutation.";
  const evidence = pathEvidence(input.proposal);
  try {
    release = await acquireLock(input.proposal.destinationPath);
    const existing = await readLocalPublicationJournal(
      input.proposal.destinationPath,
    );
    if (existing !== undefined)
      throw new Error(
        `A durable local-publication ${existing.status} receipt already exists; automatic retry is disabled.`,
      );
    const snapshot = await verifyPreconditions(input);
    beforeStatusDigest = snapshot.statusDigest;
    let totalBytes = 0;
    for (const change of input.proposal.changes) {
      if (change.after === undefined) continue;
      const bytes = await input.readOverlayFile(change.path);
      if (bytes === null || contentDigest(bytes) !== change.after.digest)
        throw new Error(
          `The immutable apply overlay is stale for ${change.path}.`,
        );
      if (bytes.byteLength > LOCAL_PUBLICATION_MAX_FILE_BYTES)
        throw new Error(
          `The approved postimage exceeds the per-file limit for ${change.path}.`,
        );
      totalBytes += bytes.byteLength;
      if (totalBytes > LOCAL_PUBLICATION_MAX_CHANGE_BYTES)
        throw new Error(
          "The reviewed change set exceeds the aggregate size limit.",
        );
      overlay.set(change.path, bytes);
    }
    for (const change of input.proposal.changes) {
      const target = await safeTarget(
        snapshot.canonicalPath,
        change.path,
        false,
        [],
      );
      const before = await fileState(target);
      if (!assertFileMatches(before, change.before))
        throw new Error(`The approved preimage changed for ${change.path}.`);
      preimages.set(change.path, before);
    }
    patch = await buildExactGitPatch({
      gitDirectoryPath: snapshot.gitDirectoryPath,
      executionPaths: input.proposal.executionPaths,
      changes: input.proposal.changes,
      preimages,
      overlay,
    });
    const pendingUnsigned = {
      ...proposalFields,
      proposalDigest,
      status: "pending" as const,
      publishedByCallId: input.publishedByCallId,
      beforeStatusDigest,
      appliedPaths: [] as readonly string[],
      intentPaths: input.proposal.executionPaths,
      pathEvidence: evidence,
    };
    let pending: LocalPublicationPendingReceipt = {
      ...pendingUnsigned,
      digest: stableDigest(pendingUnsigned),
    };
    const journalPath = await gitOwnedPath(
      snapshot.canonicalPath,
      "app-builder/local-publication.json",
    );
    await createInitialJournal(journalPath, pending);
    pendingWritten = true;
    await input.hooks?.afterPendingJournal?.();
    for (
      let index = 0;
      index < input.proposal.executionPaths.length;
      index += 1
    ) {
      const path = input.proposal.executionPaths[index];
      const change = input.proposal.changes.find(
        (candidate) => candidate.path === path,
      )!;
      await input.hooks?.beforeMutation?.(change.path, index);
    }
    await input.hooks?.beforeGitApply?.();
    const immediate = await verifyPreconditions(input);
    if (
      immediate.rootIdentity.device !== input.proposal.rootIdentity.device ||
      immediate.rootIdentity.inode !== input.proposal.rootIdentity.inode ||
      immediate.gitDirectoryPath !== input.proposal.gitDirectoryPath ||
      immediate.gitDirectoryIdentity.device !==
        input.proposal.gitDirectoryIdentity.device ||
      immediate.gitDirectoryIdentity.inode !==
        input.proposal.gitDirectoryIdentity.inode
    )
      throw new Error(
        "Repository filesystem identity changed before Git apply.",
      );
    fixedGitApply(snapshot.canonicalPath, patch, { check: true });
    mutationDispatched = true;
    if (input.hooks?.dispatchGitApply !== undefined)
      await input.hooks.dispatchGitApply();
    else fixedGitApply(snapshot.canonicalPath, patch);
    mutationCallReturned = true;
    appliedPaths = [...input.proposal.executionPaths];
    pending = { ...pending, appliedPaths, digest: "" };
    pending = { ...pending, digest: receiptDigest(pending) };
    await writeJournal(journalPath, pending);
    await input.hooks?.afterGitApply?.();
    for (
      let index = 0;
      index < input.proposal.executionPaths.length;
      index += 1
    ) {
      const path = input.proposal.executionPaths[index];
      await input.hooks?.afterMutation?.(path, index);
    }
    for (const change of input.proposal.changes) {
      const target = await safeTarget(
        snapshot.canonicalPath,
        change.path,
        false,
        [],
      );
      if (!assertFileMatches(await fileState(target), change.after))
        throw new Error(
          `The published postimage failed verification: ${change.path}.`,
        );
    }
    const after = await inspectLocalPublicationDestination({
      destinationPath: snapshot.canonicalPath,
      sourceReceipt: input.sourceReceipt,
    });
    if (
      unrelatedProjectionDigest(after, input.proposal.approvedPaths) !==
        input.proposal.unrelatedProjectionDigest ||
      after.headReference !== input.proposal.headReference ||
      after.indexFileDigest !== input.proposal.indexFileDigest ||
      after.remoteDigest !== input.proposal.remoteDigest
    )
      throw new Error(
        "Unrelated state or Git metadata changed during publication.",
      );
    const successUnsigned = {
      ...proposalFields,
      proposalDigest,
      status: "succeeded" as const,
      publishedByCallId: input.publishedByCallId,
      beforeStatusDigest,
      afterStatusDigest: after.statusDigest,
      appliedPaths,
      intentPaths: input.proposal.executionPaths,
      rolledBackPaths: [] as readonly string[],
      conflictedPaths: [] as readonly string[],
      uncertainPaths: [] as readonly string[],
      pathEvidence: evidence,
      recoveryRequired: false,
      postconditionDigest: stableDigest(
        evidence.map(({ path, after: postimage }) => ({ path, postimage })),
      ),
    };
    const receipt: LocalPublicationSuccessReceipt = {
      ...successUnsigned,
      digest: stableDigest(successUnsigned),
    };
    await input.hooks?.beforeTerminalJournalWrite?.("succeeded");
    await writeJournal(journalPath, receipt);
    return { ok: true, receipt };
  } catch (error: unknown) {
    if (pendingWritten && input.hooks?.preservePendingOnFailure === true)
      throw error;
    failureMessage =
      error instanceof Error
        ? error.message
        : "Unknown local-publication failure.";
    const rolledBackPaths: string[] = [];
    const conflictedPaths: string[] = [];
    const uncertainPaths: string[] = [];
    if (pendingWritten && patch !== undefined && mutationDispatched) {
      const observedPost: string[] = [];
      for (
        let index = 0;
        index < input.proposal.executionPaths.length;
        index += 1
      ) {
        const path = input.proposal.executionPaths[index];
        const change = input.proposal.changes.find(
          (candidate) => candidate.path === path,
        )!;
        try {
          await input.hooks?.beforeRollback?.(path, index);
          await input.hooks?.beforeUncertainClassification?.(path, index);
          const target = await safeTarget(
            input.proposal.destinationPath,
            path,
            false,
            [],
          );
          const observed = await fileState(target);
          if (assertFileMatches(observed, change.after))
            observedPost.push(path);
          else if (!assertFileMatches(observed, change.before))
            if (!mutationCallReturned) uncertainPaths.push(path);
        } catch {
          if (!mutationCallReturned) uncertainPaths.push(path);
        }
      }
      if (!mutationCallReturned) appliedPaths = [...observedPost];
      conflictedPaths.push(
        ...appliedPaths.filter((path) => !observedPost.includes(path)),
      );
      if (observedPost.length > 0) {
        try {
          const rollbackPatch = await buildExactGitPatch({
            gitDirectoryPath: input.proposal.gitDirectoryPath,
            executionPaths: observedPost,
            changes: input.proposal.changes,
            preimages,
            overlay,
          });
          fixedGitApply(input.proposal.destinationPath, rollbackPatch, {
            reverse: true,
            check: true,
          });
          fixedGitApply(input.proposal.destinationPath, rollbackPatch, {
            reverse: true,
          });
        } catch {
          // Exact per-path readback below decides the canonical partition.
        }
      }
      for (const path of observedPost) {
        const change = input.proposal.changes.find(
          (candidate) => candidate.path === path,
        )!;
        try {
          const target = await safeTarget(
            input.proposal.destinationPath,
            path,
            false,
            [],
          );
          if (assertFileMatches(await fileState(target), change.before))
            rolledBackPaths.push(path);
          else if (!conflictedPaths.includes(path)) conflictedPaths.push(path);
        } catch {
          if (!conflictedPaths.includes(path)) conflictedPaths.push(path);
        }
      }
      const executionPosition = new Map(
        input.proposal.executionPaths.map((path, index) => [path, index]),
      );
      rolledBackPaths.sort(
        (left, right) =>
          executionPosition.get(left)! - executionPosition.get(right)!,
      );
      conflictedPaths.sort(
        (left, right) =>
          executionPosition.get(left)! - executionPosition.get(right)!,
      );
      uncertainPaths.sort(
        (left, right) =>
          executionPosition.get(left)! - executionPosition.get(right)!,
      );
    }
    let afterStatusDigest = "unavailable";
    try {
      afterStatusDigest = (
        await inspectLocalPublicationDestination({
          destinationPath: input.proposal.destinationPath,
          sourceReceipt: input.sourceReceipt,
        })
      ).statusDigest;
    } catch {
      /* Receipt records that readback was unavailable. */
    }
    const recoveryRequired =
      conflictedPaths.length > 0 ||
      uncertainPaths.length > 0 ||
      appliedPaths.length !== rolledBackPaths.length;
    const failureUnsigned = {
      ...proposalFields,
      proposalDigest,
      status: "failed" as const,
      publishedByCallId: input.publishedByCallId,
      beforeStatusDigest,
      afterStatusDigest,
      appliedPaths,
      intentPaths: pendingWritten ? input.proposal.executionPaths : [],
      rolledBackPaths,
      conflictedPaths,
      uncertainPaths,
      pathEvidence: evidence,
      recoveryRequired,
      reason: recoveryRequired
        ? ("rollback-conflict" as const)
        : pendingWritten
          ? ("mutation-failed" as const)
          : ("precondition-failed" as const),
      failureMessage,
    };
    const receipt: LocalPublicationFailureReceipt = {
      ...failureUnsigned,
      digest: stableDigest(failureUnsigned),
    };
    if (pendingWritten) {
      const journalPath = await gitOwnedPath(
        input.proposal.destinationPath,
        "app-builder/local-publication.json",
      );
      await input.hooks?.beforeTerminalJournalWrite?.("failed");
      await writeJournal(journalPath, receipt);
    }
    return { ok: false, receipt };
  } finally {
    await release?.();
  }
}

export function assertNoApprovedOverlap(
  proposal: LocalPublicationProposal,
  dirty: readonly ParsedGitStatus[],
): void {
  if (
    dirty.some((entry) =>
      proposal.approvedPaths.some(
        (path) =>
          pathsOverlap(path, entry.path) ||
          (entry.originalPath !== undefined &&
            pathsOverlap(path, entry.originalPath)),
      ),
    )
  )
    throw new Error("A dirty path overlaps the approved publication path set.");
}
