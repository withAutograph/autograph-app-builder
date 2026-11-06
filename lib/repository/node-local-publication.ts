import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
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
  copyFile,
} from "node:fs/promises";
import { finished, pipeline } from "node:stream/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { once } from "node:events";
import nodePath from "node:path";

import {
  assertExactProposal,
  assertExactReviewedChangeSet,
  assertCanonicalLocalPublicationJournal,
  contentDigest,
  createLocalPublicationProposal,
  exactProposalMatch,
  pathsOverlap,
  proposalFromJournal,
  receiptDigest,
  stableDigest,
  unrelatedProjectionDigest,
} from "./local-publication";
import type {
  DestinationSnapshot,
  DirtyPathSnapshot,
  LocalPublicationFailureReceipt,
  LocalPublicationJournal,
  LocalPublicationPendingReceipt,
  LocalPublicationProposal,
  LocalPublicationResult,
  LocalPublicationSuccessReceipt,
  PublicationPathEvidence,
} from "./local-publication";
import type { ReviewedChangeSetReceipt } from "./reviewed-change-set";
import { resolveAllowedRepository } from "./supported-template";
import { sourceIdentityDigest } from "./source-receipt";
import type { SourceReceipt } from "./source-receipt";
import { safeSourcePath } from "./source-path";
import { compareOverlayPaths } from "./target-apply";

const fileStateKinds = {
  absent: "absent",
  directory: "directory",
  regular: "regular",
  special: "special",
  symlink: "symlink",
} as const;
type FileStateKind = (typeof fileStateKinds)[keyof typeof fileStateKinds];

interface FileState {
  kind: FileStateKind;
  mode?: string;
  materializedPath?: string;
  size?: number;
  digest?: string;
}

export interface LocalPublicationFaultHooks {
  beforeMutation?: (path: string, index: number) => void | Promise<void>;
  afterMutation?: (path: string, index: number) => void | Promise<void>;
  beforeRollback?: (path: string, index: number) => void | Promise<void>;
  beforeGitApply?: () => void | Promise<void>;
  afterGitApply?: () => void | Promise<void>;
  dispatchGitApply?: () => void | Promise<void>;
  beforeUncertainClassification?: (path: string, index: number) => void | Promise<void>;
  afterPendingJournal?: () => void | Promise<void>;
  beforeTerminalJournalWrite?: (status: "succeeded" | "failed") => void | Promise<void>;
  preservePendingOnFailure?: boolean;
}

const fixedGitEnvironment = function fixedGitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  environment.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_EXTERNAL_DIFF",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
  ]) {
    Reflect.deleteProperty(environment, name);
  }
  return environment;
};

interface ChildCloseResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}
const waitForChildClose = async function waitForChildClose(
  child: ReturnType<typeof spawn>,
): Promise<ChildCloseResult> {
  return await new Promise((resolve, reject) => {
    child.once("error", (error: Error) => {
      reject(error);
    });
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      resolve({ code, signal });
    });
  });
};

const GIT_EXECUTABLE = "/usr/bin/git";
const EPIPE = "EPIPE";
const REDACTED_URL = "[URL REDACTED]";
const REDACTED_TOKEN = "[REDACTED]";
const PRIVATE_DIAGNOSTIC_UNAVAILABLE = "an unavailable private diagnostic log";
const LOCAL_PUBLICATION_JOURNAL_PATH = "app-builder/local-publication.json";

const gitDiagnosticUnavailable = PRIVATE_DIAGNOSTIC_UNAVAILABLE;
const gitApplyFailurePrefix = "Git apply failed for";
const journalUnreadableMessage = "The durable local-publication journal is unreadable.";

const ignoreFailure = async function ignoreFailure(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch {
    // Cleanup is best-effort and must not replace the original result.
  }
};

interface GitDiagnosticCapture {
  directory: string;
  rawPath: string;
  writer: ReturnType<typeof createWriteStream>;
}

const startGitDiagnosticCapture =
  async function startGitDiagnosticCapture(): Promise<GitDiagnosticCapture> {
    const directory = await mkdtemp(nodePath.join(tmpdir(), "autograph-git-diagnostic-"));
    const rawPath = nodePath.join(directory, "stderr.raw");
    return {
      directory,
      rawPath,
      writer: createWriteStream(rawPath, { flags: "wx", mode: 0o600 }),
    };
  };

const redactGitDiagnosticLine = function redactGitDiagnosticLine(line: string): string {
  return line
    .replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "?")
    .replaceAll(/\b(?:https?|postgres(?:ql)?|redis):\/\/[^\s"'<>]+/giu, REDACTED_URL)
    .replaceAll(/\bBearer\s+[^\s"',;]+/giu, `Bearer ${REDACTED_TOKEN}`)
    .replaceAll(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[JWT REDACTED]")
    .replaceAll(
      /\b(?<name>(?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[-_]?KEY|AUTHORIZATION|COOKIE)[A-Z_]*))(?<separator>["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/giu,
      `$<name>$<separator>${REDACTED_TOKEN}`,
    );
};

const finishGitDiagnosticCapture = async function finishGitDiagnosticCapture(
  capture: GitDiagnosticCapture,
  keep: boolean,
): Promise<string | undefined> {
  await finished(capture.writer);
  if (!keep) {
    await rm(capture.directory, { force: true, recursive: true });
    return undefined;
  }
  const logPath = nodePath.join(capture.directory, "stderr.log");
  const sanitizedWriter = createWriteStream(logPath, { flags: "wx", mode: 0o600 });
  const lines = createInterface({
    crlfDelay: Infinity,
    input: createReadStream(capture.rawPath),
  });
  for await (const line of lines) {
    const chunk = `${redactGitDiagnosticLine(line)}\n`;
    if (!sanitizedWriter.write(chunk)) {
      await once(sanitizedWriter, "drain");
    }
  }
  sanitizedWriter.end();
  await finished(sanitizedWriter);
  await unlink(capture.rawPath);
  return logPath;
};

interface GitProcessResult {
  stderrLogPath?: string;
  status: number;
  stdout: Buffer;
}

interface GitPatch {
  directory: string;
  path: string;
}

const runGitCapture = async function runGitCapture(
  args: readonly string[],
): Promise<GitProcessResult> {
  const diagnosticCapture = await startGitDiagnosticCapture();
  const child = spawn(GIT_EXECUTABLE, [...args], {
    env: fixedGitEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    output.push(Buffer.from(chunk));
  });
  child.stderr.pipe(diagnosticCapture.writer);
  const { code } = await waitForChildClose(child);
  const stderrLogPath = await finishGitDiagnosticCapture(
    diagnosticCapture,
    code !== null && code !== 0,
  );
  const result: GitProcessResult = {
    status: code ?? -1,
    stdout: Buffer.concat(output),
  };
  if (stderrLogPath !== undefined) {
    result.stderrLogPath = stderrLogPath;
  }
  return result;
};

const fixedGitApply = async function fixedGitApply(
  root: string,
  patchPath: string,
  options: { reverse?: boolean; check?: boolean } = {},
): Promise<void> {
  const diagnosticCapture = await startGitDiagnosticCapture();
  const child = spawn(
    GIT_EXECUTABLE,
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
      ...(options.reverse === true ? ["--reverse"] : []),
      ...(options.check === true ? ["--check"] : []),
      "--binary",
      "--whitespace=nowarn",
      "-",
    ],
    {
      env: fixedGitEnvironment(),
      stdio: ["pipe", "ignore", "pipe"],
    },
  );
  child.stderr.pipe(diagnosticCapture.writer);
  const close = waitForChildClose(child);
  const input = pipeline(createReadStream(patchPath), child.stdin);
  let inputError: Error | undefined;
  try {
    await input;
  } catch (error: unknown) {
    inputError = error;
  }
  const { code, signal } = await close;
  if (inputError !== undefined && !("code" in inputError && inputError.code === EPIPE)) {
    throw inputError;
  }
  const stderrLogPath = await finishGitDiagnosticCapture(
    diagnosticCapture,
    code !== null && code !== 0,
  );
  if (code !== 0) {
    const statusDetail = signal ?? `exit ${code}`;
    const diagnosticPath = stderrLogPath ?? PRIVATE_DIAGNOSTIC_UNAVAILABLE;
    throw new Error(
      `${gitApplyFailurePrefix} ${root} using patch ${patchPath} (${statusDetail}); sanitized stderr is available at ${diagnosticPath}.`,
    );
  }
};

const materializePatchFile = async function materializePatchFile(
  root: string,
  side: "old" | "new",
  path: string,
  state: { sourcePath: string; mode: string } | undefined,
): Promise<void> {
  if (state === undefined) {
    return;
  }
  const target = nodePath.resolve(root, side, path);
  await mkdir(nodePath.dirname(target), { mode: 0o755, recursive: true });
  await copyFile(state.sourcePath, target);
  await chmod(target, Number.parseInt(state.mode, 8));
};

const writeStageFile = async function writeStageFile(
  stagingRoot: string,
  relativePath: string,
  source: { bytes: Uint8Array } | { path: string },
  mode: string,
): Promise<string> {
  const target = nodePath.resolve(stagingRoot, relativePath);
  const relativeTarget = nodePath.relative(stagingRoot, target);
  if (
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${nodePath.sep}`) ||
    nodePath.isAbsolute(relativeTarget)
  ) {
    throw new Error("A staged publication path escapes its private directory.");
  }
  await mkdir(nodePath.dirname(target), { mode: 0o700, recursive: true });
  await ("bytes" in source
    ? writeFile(target, source.bytes, { flag: "wx", mode: Number.parseInt(mode, 8) })
    : copyFile(source.path, target));
  await chmod(target, Number.parseInt(mode, 8));
  return target;
};

const buildExactGitPatch = async function buildExactGitPatch(input: {
  gitDirectoryPath: string;
  executionPaths: readonly string[];
  changes: LocalPublicationProposal["changes"];
  preimages: ReadonlyMap<string, FileState>;
  overlay: ReadonlyMap<string, FileState>;
}): Promise<GitPatch> {
  const scratchParent = nodePath.resolve(input.gitDirectoryPath, "app-builder");
  await mkdir(scratchParent, { mode: 0o700, recursive: true });
  const scratch = await mkdtemp(nodePath.resolve(scratchParent, "publication-patch-"));
  const patchPath = nodePath.resolve(scratch, "change.patch");
  const patchFile = await open(patchPath, "wx", 0o600);
  const changes = new Map(input.changes.map((change) => [change.path, change]));
  try {
    let diffWrites = Promise.resolve();
    await Promise.all(
      input.executionPaths.map(async (path) => {
        const change = changes.get(path);
        if (change === undefined) {
          throw new Error(`Missing approved change for ${path}.`);
        }
        const item = await mkdtemp(nodePath.resolve(scratch, "item-"));
        await Promise.all([
          mkdir(nodePath.resolve(item, "old")),
          mkdir(nodePath.resolve(item, "new")),
        ]);
        const before = input.preimages.get(path);
        if (before === undefined) {
          throw new Error(`Missing approved preimage for ${path}.`);
        }
        await materializePatchFile(
          item,
          "old",
          path,
          before.kind === fileStateKinds.regular &&
            before.materializedPath !== undefined &&
            before.mode !== undefined
            ? { mode: before.mode, sourcePath: before.materializedPath }
            : undefined,
        );
        const after = input.overlay.get(path);
        await materializePatchFile(
          item,
          "new",
          path,
          change.after !== undefined && after?.materializedPath !== undefined
            ? { mode: change.after.mode, sourcePath: after.materializedPath }
            : undefined,
        );
        const diagnosticCapture = await startGitDiagnosticCapture();
        const child = spawn(
          GIT_EXECUTABLE,
          ["diff", "--no-index", "--binary", "--no-prefix", "--no-renames", "--", "old", "new"],
          { cwd: item, env: fixedGitEnvironment(), stdio: ["ignore", "pipe", "pipe"] },
        );
        child.stderr.pipe(diagnosticCapture.writer);
        const chunks: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        const { code, signal } = await waitForChildClose(child);
        const stderrLogPath = await finishGitDiagnosticCapture(diagnosticCapture, code !== 1);
        if (code !== 1) {
          const statusDetail = signal ?? `exit ${code}`;
          const diagnosticPath = stderrLogPath ?? gitDiagnosticUnavailable;
          throw new Error(
            `Could not build the exact publication patch for ${path} in ${input.gitDirectoryPath} (${statusDetail}); sanitized stderr is available at ${diagnosticPath}.`,
          );
        }
        const diff = Buffer.concat(chunks);
        diffWrites = diffWrites.then(async () => {
          await patchFile.writeFile(diff);
        });
      }),
    );
    await diffWrites;
    await patchFile.sync();
    return { directory: scratch, path: patchPath };
  } catch (error) {
    await patchFile.close();
    await rm(scratch, { force: true, recursive: true });
    throw error;
  } finally {
    try {
      await patchFile.close();
    } catch {
      // The error path may already have closed the file handle.
    }
  }
};

export const publishReviewedChangeSet = async function publishReviewedChangeSet(input: {
  proposal: LocalPublicationProposal;
  sourceReceipt: SourceReceipt;
  review: ReviewedChangeSetReceipt;
  readOverlayFile: (path: string) => Promise<Uint8Array | null>;
  publishedByCallId: string;
  hooks?: LocalPublicationFaultHooks;
}): Promise<LocalPublicationResult> {
  if (process.env.APP_BUILDER_LOCAL_PUBLICATION !== "1") {
    throw new Error(
      "Local publication is disabled until APP_BUILDER_LOCAL_PUBLICATION=1 is explicitly configured.",
    );
  }
  const { digest: proposalDigest, ...proposalFields } = input.proposal;
  let release: (() => Promise<void>) | undefined;
  const preimages = new Map<string, FileState>();
  const overlay = new Map<string, FileState>();
  let patch: GitPatch | undefined;
  let stagingDirectory: string | undefined;
  let appliedPaths: string[] = [];
  let mutationDispatched = false;
  let mutationCallReturned = false;
  let beforeStatusDigest = "unobserved";
  let pendingWritten = false;
  let failureMessage = "Local publication failed before mutation.";
  const evidence = pathEvidence(input.proposal);
  try {
    release = await acquireLock(input.proposal.destinationPath);
    const existing = await readLocalPublicationJournal(input.proposal.destinationPath);
    if (existing !== undefined) {
      throw new Error(
        `A durable local-publication ${existing.status} receipt already exists; automatic retry is disabled.`,
      );
    }
    const snapshot = await verifyPreconditions(input);
    beforeStatusDigest = snapshot.statusDigest;
    const stagingParent = nodePath.resolve(snapshot.gitDirectoryPath, "app-builder");
    await mkdir(stagingParent, { mode: 0o700, recursive: true });
    stagingDirectory = await mkdtemp(nodePath.resolve(stagingParent, "publication-input-"));
    await stagePublicationInputs(input, snapshot, stagingDirectory, overlay, preimages);
    patch = await buildExactGitPatch({
      changes: input.proposal.changes,
      executionPaths: input.proposal.executionPaths,
      gitDirectoryPath: snapshot.gitDirectoryPath,
      overlay,
      preimages,
    });
    const pendingUnsigned = {
      ...proposalFields,
      appliedPaths: [],
      beforeStatusDigest,
      intentPaths: input.proposal.executionPaths,
      pathEvidence: evidence,
      proposalDigest,
      publishedByCallId: input.publishedByCallId,
      status: "pending" as const,
    };
    let pending: LocalPublicationPendingReceipt = {
      ...pendingUnsigned,
      digest: stableDigest(pendingUnsigned),
    };
    const journalPath = await gitOwnedPath(snapshot.canonicalPath, LOCAL_PUBLICATION_JOURNAL_PATH);
    await createInitialJournal(journalPath, pending);
    pendingWritten = true;
    await input.hooks?.afterPendingJournal?.();
    const beforeMutationCalls = input.proposal.executionPaths.map(async (path, index) => {
      const change = input.proposal.changes.find((candidate) => candidate.path === path);
      if (change === undefined) {
        throw new Error(`Missing approved change for ${path}.`);
      }
      await input.hooks?.beforeMutation?.(change.path, index);
    });
    await Promise.all(beforeMutationCalls);
    await input.hooks?.beforeGitApply?.();
    const immediate = await verifyPreconditions(input);
    verifyPublicationIdentity(immediate, input.proposal);
    await fixedGitApply(snapshot.canonicalPath, patch.path, { check: true });
    mutationDispatched = true;
    await (input.hooks?.dispatchGitApply === undefined
      ? fixedGitApply(snapshot.canonicalPath, patch.path)
      : input.hooks.dispatchGitApply());
    mutationCallReturned = true;
    appliedPaths = [...input.proposal.executionPaths];
    pending = { ...pending, appliedPaths, digest: "" };
    pending = { ...pending, digest: receiptDigest(pending) };
    await writeJournal(journalPath, pending);
    await input.hooks?.afterGitApply?.();
    await Promise.all(
      input.proposal.executionPaths.map((path, index) => input.hooks?.afterMutation?.(path, index)),
    );
    await verifyPublishedPostimages(snapshot, input.proposal.changes);
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
    ) {
      throw new Error("Unrelated state or Git metadata changed during publication.");
    }
    const successUnsigned = {
      ...proposalFields,
      afterStatusDigest: after.statusDigest,
      appliedPaths,
      beforeStatusDigest,
      conflictedPaths: [],
      intentPaths: input.proposal.executionPaths,
      pathEvidence: evidence,
      postconditionDigest: stableDigest(
        evidence.map(({ path, after: postimage }) => ({ path, postimage })),
      ),
      proposalDigest,
      publishedByCallId: input.publishedByCallId,
      recoveryRequired: false,
      rolledBackPaths: [],
      status: "succeeded" as const,
      uncertainPaths: [],
    };
    const receipt: LocalPublicationSuccessReceipt = {
      ...successUnsigned,
      digest: stableDigest(successUnsigned),
    };
    await input.hooks?.beforeTerminalJournalWrite?.("succeeded");
    await writeJournal(journalPath, receipt);
    return { ok: true, receipt };
  } catch (error: unknown) {
    if (pendingWritten && input.hooks?.preservePendingOnFailure === true) {
      throw error;
    }
    failureMessage = error instanceof Error ? error.message : "Unknown local-publication failure.";
    let rolledBackPaths: string[] = [];
    let conflictedPaths: string[] = [];
    let uncertainPaths: string[] = [];
    if (pendingWritten && patch !== undefined && mutationDispatched) {
      const recovery = await recoverPublication({
        appliedPaths,
        hooks: input.hooks,
        mutationCallReturned,
        overlay,
        preimages,
        proposal: input.proposal,
      });
      ({ appliedPaths, rolledBackPaths, conflictedPaths, uncertainPaths } = recovery);
    }
    let afterStatusDigest = "unavailable";
    try {
      const destination = await inspectLocalPublicationDestination({
        destinationPath: input.proposal.destinationPath,
        sourceReceipt: input.sourceReceipt,
      });
      afterStatusDigest = destination.statusDigest;
    } catch {
      /* Receipt records that readback was unavailable. */
    }
    const recoveryRequired =
      conflictedPaths.length > 0 ||
      uncertainPaths.length > 0 ||
      appliedPaths.length !== rolledBackPaths.length;
    let reason: "rollback-conflict" | "mutation-failed" | "precondition-failed";
    if (recoveryRequired) {
      reason = "rollback-conflict";
    } else if (pendingWritten) {
      reason = "mutation-failed";
    } else {
      reason = "precondition-failed";
    }
    const failureUnsigned = {
      ...proposalFields,
      afterStatusDigest,
      appliedPaths,
      beforeStatusDigest,
      conflictedPaths,
      failureMessage,
      intentPaths: pendingWritten ? input.proposal.executionPaths : [],
      pathEvidence: evidence,
      proposalDigest,
      publishedByCallId: input.publishedByCallId,
      reason,
      recoveryRequired,
      rolledBackPaths,
      status: "failed" as const,
      uncertainPaths,
    };
    const receipt: LocalPublicationFailureReceipt = {
      ...failureUnsigned,
      digest: stableDigest(failureUnsigned),
    };
    if (pendingWritten) {
      const journalPath = await gitOwnedPath(
        input.proposal.destinationPath,
        LOCAL_PUBLICATION_JOURNAL_PATH,
      );
      await input.hooks?.beforeTerminalJournalWrite?.("failed");
      await writeJournal(journalPath, receipt);
    }
    return { ok: false, receipt };
  } finally {
    if (patch !== undefined) {
      await rm(patch.directory, { force: true, recursive: true });
    }
    if (stagingDirectory !== undefined) {
      await rm(stagingDirectory, { force: true, recursive: true });
    }
    await release?.();
  }
};

const stagePublicationInputs = async function stagePublicationInputs(
  input: Parameters<typeof publishReviewedChangeSet>[0],
  snapshot: Awaited<ReturnType<typeof verifyPreconditions>>,
  stagingDirectory: string,
  overlay: Map<string, FileState>,
  preimages: Map<string, FileState>,
): Promise<void> {
  for (const change of input.proposal.changes) {
    if (change.after === undefined) {
      continue;
    }
    const bytes = await input.readOverlayFile(change.path);
    if (bytes === null || contentDigest(bytes) !== change.after.digest) {
      throw new Error(`The immutable apply overlay is stale for ${change.path}.`);
    }
    const materializedPath = await writeStageFile(
      stagingDirectory,
      change.path,
      { bytes },
      change.after.mode,
    );
    overlay.set(change.path, {
      digest: change.after.digest,
      kind: fileStateKinds.regular,
      materializedPath,
      mode: change.after.mode,
      size: bytes.byteLength,
    });
  }
  for (const change of input.proposal.changes) {
    const target = await safeTarget(snapshot.canonicalPath, change.path, false, []);
    const before = await fileState(target);
    if (!assertFileMatches(before, change.before)) {
      throw new Error(`The approved preimage changed for ${change.path}.`);
    }
    if (before.kind === fileStateKinds.regular && before.mode !== undefined) {
      before.materializedPath = await writeStageFile(
        stagingDirectory,
        `preimages/${change.path}`,
        { path: target },
        before.mode,
      );
    }
    preimages.set(change.path, before);
  }
};

const verifyPublishedPostimages = async function verifyPublishedPostimages(
  snapshot: Awaited<ReturnType<typeof verifyPreconditions>>,
  changes: LocalPublicationProposal["changes"],
): Promise<void> {
  const results = await Promise.all(
    changes.map(async (change) => {
      const target = await safeTarget(snapshot.canonicalPath, change.path, false, []);
      return { change, state: await fileState(target) };
    }),
  );
  for (const { change, state } of results) {
    if (!assertFileMatches(state, change.after)) {
      throw new Error(`The published postimage failed verification: ${change.path}.`);
    }
  }
};

const verifyPublicationIdentity = function verifyPublicationIdentity(
  immediate: Awaited<ReturnType<typeof verifyPreconditions>>,
  proposal: LocalPublicationProposal,
): void {
  const rootChanged =
    immediate.rootIdentity.device !== proposal.rootIdentity.device ||
    immediate.rootIdentity.inode !== proposal.rootIdentity.inode;
  const gitChanged =
    immediate.gitDirectoryPath !== proposal.gitDirectoryPath ||
    immediate.gitDirectoryIdentity.device !== proposal.gitDirectoryIdentity.device ||
    immediate.gitDirectoryIdentity.inode !== proposal.gitDirectoryIdentity.inode;
  if (rootChanged || gitChanged) {
    throw new Error("Repository filesystem identity changed before Git apply.");
  }
};

const git = async function git(path: string, args: readonly string[]): Promise<string> {
  const result = await runGitCapture(["-C", path, ...args]);
  if (result.status !== 0) {
    throw new Error(
      `Git ${args[0] ?? "command"} failed for ${path} (${result.status}); sanitized stderr is available at ${result.stderrLogPath ?? PRIVATE_DIAGNOSTIC_UNAVAILABLE}.`,
    );
  }
  return result.stdout.toString("utf-8");
};

const gitBuffer = async function gitBuffer(path: string, args: readonly string[]): Promise<Buffer> {
  const result = await runGitCapture(["-C", path, ...args]);
  if (result.status !== 0) {
    throw new Error(
      `Git ${args[0] ?? "command"} failed for ${path} (${result.status}); sanitized stderr is available at ${result.stderrLogPath ?? PRIVATE_DIAGNOSTIC_UNAVAILABLE}.`,
    );
  }
  return result.stdout;
};

const within = function within(root: string, candidate: string): boolean {
  const path = nodePath.relative(root, candidate);
  if (path === "") {
    return true;
  }
  if (path === ".." || path.startsWith(`..${nodePath.sep}`)) {
    return false;
  }
  return !nodePath.isAbsolute(path);
};

const fieldAfter = function fieldAfter(record: string, spaceCount: number): string {
  let offset = 0;
  for (let count = 0; count < spaceCount; count += 1) {
    offset = record.indexOf(" ", offset);
    if (offset < 0) {
      throw new Error("Git returned malformed porcelain-v2 status.");
    }
    offset += 1;
  }
  return record.slice(offset);
};

export interface ParsedGitStatus {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  indexMode?: string;
  indexObjectId?: string;
}

const statusMetadata = function statusMetadata(record: string): {
  indexMode?: string;
  indexObjectId?: string;
} {
  const fields = record.split(" ");
  const { 4: indexMode, 7: indexObjectId } = fields;
  return indexMode !== undefined && indexObjectId !== undefined ? { indexMode, indexObjectId } : {};
};

/** Parse `git status --porcelain=v2 -z`; rename records consume two NUL fields. */
export const parseGitStatusV2 = function parseGitStatusV2(
  output: string,
): readonly ParsedGitStatus[] {
  const records = output.split("\0");
  const result: ParsedGitStatus[] = [];
  let index = 0;
  while (index < records.length) {
    const record = records[index];
    if (
      record === undefined ||
      record === "" ||
      record.startsWith("# ") ||
      record.startsWith("! ")
    ) {
      // Header, ignored, and trailing NUL fields have no path record.
    } else if (record.startsWith("? ")) {
      result.push({
        indexStatus: "?",
        path: record.slice(2),
        worktreeStatus: "?",
      });
    } else if (record.startsWith("1 ")) {
      const xy = record.slice(2, 4);
      result.push({
        path: fieldAfter(record, 8),
        ...statusMetadata(record),
        indexStatus: xy[0] ?? ".",
        worktreeStatus: xy[1] ?? ".",
      });
    } else if (record.startsWith("2 ")) {
      const xy = record.slice(2, 4);
      const path = fieldAfter(record, 9);
      const originalPath = records[index + 1];
      if (originalPath === undefined || originalPath === "") {
        throw new Error("Git returned a truncated rename record.");
      }
      result.push({
        originalPath,
        path,
        ...statusMetadata(record),
        indexStatus: xy[0] ?? ".",
        worktreeStatus: xy[1] ?? ".",
      });
      index += 2;
      continue;
    } else if (record.startsWith("u ")) {
      const xy = record.slice(2, 4);
      result.push({
        path: fieldAfter(record, 10),
        ...statusMetadata(record),
        indexStatus: xy[0] ?? "U",
        worktreeStatus: xy[1] ?? "U",
      });
    } else {
      throw new Error("Git returned an unsupported porcelain-v2 status record.");
    }
    index += 1;
  }
  return result.toSorted((left, right) => compareOverlayPaths(left.path, right.path));
};

const fileState = async function fileState(path: string): Promise<FileState> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      return { kind: fileStateKinds.symlink };
    }
    if (stat.isDirectory()) {
      return { kind: fileStateKinds.directory, mode: (stat.mode % 0o1000).toString(8) };
    }
    if (!stat.isFile()) {
      return { kind: fileStateKinds.special, mode: (stat.mode % 0o1000).toString(8) };
    }
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(path)) {
      // SAFETY: createReadStream emits Buffer chunks for a file path.
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(bytes);
      size += bytes.byteLength;
    }
    return {
      digest: hash.digest("hex"),
      kind: fileStateKinds.regular,
      mode: (stat.mode & 0o777).toString(8),
      size,
    };
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { kind: fileStateKinds.absent };
    }
    throw error;
  }
};

const dirtyEntry = async function dirtyEntry(
  root: string,
  parsed: ParsedGitStatus,
): Promise<DirtyPathSnapshot> {
  if (
    !safeSourcePath(parsed.path) ||
    (parsed.originalPath !== undefined && !safeSourcePath(parsed.originalPath))
  ) {
    throw new Error("Git reported an unsafe dirty path.");
  }
  const state = await fileState(nodePath.resolve(root, parsed.path));
  const result: DirtyPathSnapshot = {
    ...parsed,
    kind: state.kind === fileStateKinds.absent ? "absent" : "present",
  };
  if (state.mode !== undefined) {
    result.mode = state.mode;
  }
  if (state.digest !== undefined && state.size !== undefined) {
    result.contentDigest = state.digest;
    result.size = state.size;
  }
  return result;
};

const gitOwnedPath = async function gitOwnedPath(root: string, name: string): Promise<string> {
  const gitPath = await git(root, ["rev-parse", "--path-format=absolute", "--git-path", name]);
  return nodePath.resolve(gitPath.trim());
};

export const inspectLocalPublicationDestination =
  async function inspectLocalPublicationDestination(input: {
    destinationPath: string;
    sourceReceipt: SourceReceipt;
  }): Promise<DestinationSnapshot> {
    if (nodePath.resolve(input.destinationPath) !== input.sourceReceipt.sourcePath) {
      throw new Error(
        "The destination must be the canonical original source path, not a symlink or alias.",
      );
    }
    const canonicalPath = await resolveAllowedRepository(input.destinationPath);
    if (canonicalPath !== input.sourceReceipt.sourcePath) {
      throw new Error("The selected destination is not the exact original source checkout.");
    }
    const [headShaRaw, headTreeRaw, headReferenceRaw, gitDirectoryRaw] = await Promise.all([
      git(canonicalPath, ["rev-parse", "HEAD"]),
      git(canonicalPath, ["rev-parse", "HEAD^{tree}"]),
      git(canonicalPath, ["rev-parse", "--symbolic-full-name", "HEAD"]),
      git(canonicalPath, ["rev-parse", "--absolute-git-dir"]),
    ]);
    const headSha = headShaRaw.trim();
    const headTree = headTreeRaw.trim();
    const headReference = headReferenceRaw.trim();
    const gitDirectoryValue = gitDirectoryRaw.trim();
    const gitDirectoryPath = await realpath(gitDirectoryValue);
    const [rootStat, gitDirectoryStat, indexPath] = await Promise.all([
      lstat(canonicalPath),
      lstat(gitDirectoryPath),
      gitOwnedPath(canonicalPath, "index"),
    ]);
    const indexState = await fileState(indexPath);
    if (indexState.kind !== fileStateKinds.regular || indexState.digest === undefined) {
      throw new Error("The Git index is not a readable regular file.");
    }
    const indexFileDigest = indexState.digest;
    const remoteDigest = stableDigest(await git(canonicalPath, ["remote", "-v"]));
    if (!rootStat.isDirectory() || !gitDirectoryStat.isDirectory()) {
      throw new Error("The repository root or Git directory is not a directory.");
    }
    const parsed = parseGitStatusV2(
      await git(canonicalPath, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
    );
    const dirty = await Promise.all(
      parsed.map(async (entry) => await dirtyEntry(canonicalPath, entry)),
    );
    const indexPathSet = new Set<string>();
    for (const entry of parsed) {
      indexPathSet.add(entry.path);
      if (entry.originalPath !== undefined) {
        indexPathSet.add(entry.originalPath);
      }
    }
    const indexPaths = [...indexPathSet].toSorted(compareOverlayPaths);
    const index = await Promise.all(
      indexPaths.map(async (path) => {
        const entries = await gitBuffer(canonicalPath, ["ls-files", "--stage", "-z", "--", path]);
        return {
          digest: contentDigest(entries),
          entriesBase64: entries.toString("base64"),
          path,
        };
      }),
    );
    const dirtyDigest = stableDigest(dirty);
    const stable = {
      canonicalPath,
      contractDigest: sourceIdentityDigest(headSha, headTree),
      dirty,
      dirtyDigest,
      gitDirectoryIdentity: {
        device: gitDirectoryStat.dev.toString(),
        inode: gitDirectoryStat.ino.toString(),
      },
      gitDirectoryPath,
      headReference,
      headSha,
      headTree,
      index,
      indexFileDigest,
      remoteDigest,
      rootIdentity: {
        device: rootStat.dev.toString(),
        inode: rootStat.ino.toString(),
      },
    };
    return { ...stable, statusDigest: stableDigest(stable) };
  };

export const deriveLocalPublicationProposal = async function deriveLocalPublicationProposal(input: {
  destinationPath: string;
  sourceReceipt: SourceReceipt;
  review: ReviewedChangeSetReceipt;
}): Promise<LocalPublicationProposal> {
  const destination = await inspectLocalPublicationDestination(input);
  return createLocalPublicationProposal({
    destination,
    review: input.review,
    sourceReceipt: input.sourceReceipt,
  });
};

const assertFileMatches = function assertFileMatches(
  state: FileState,
  expected: { mode: string; digest: string } | undefined,
): boolean {
  return expected === undefined
    ? state.kind === fileStateKinds.absent
    : state.kind === fileStateKinds.regular &&
        state.mode === expected.mode &&
        state.digest === expected.digest;
};

const safeTarget = async function safeTarget(
  root: string,
  relativePath: string,
  createParents: boolean,
  createdDirs: string[],
): Promise<string> {
  if (!safeSourcePath(relativePath)) {
    throw new Error("The approved path is unsafe.");
  }
  const target = nodePath.resolve(root, relativePath);
  if (!within(root, target)) {
    throw new Error("The approved path escapes the destination.");
  }
  const segments = relativePath.split("/").slice(0, -1);
  let cursor = root;
  for (const segment of segments) {
    cursor = nodePath.resolve(cursor, segment);
    const state = await fileState(cursor);
    if (state.kind === fileStateKinds.absent && createParents) {
      await mkdir(cursor, { mode: 0o755 });
      createdDirs.push(cursor);
    } else if (state.kind === fileStateKinds.absent) {
      continue;
    } else if (state.kind !== fileStateKinds.directory) {
      throw new Error("The approved path traverses a symlink or non-directory entry.");
    }
  }
  const leaf = await fileState(target);
  if (
    leaf.kind === fileStateKinds.symlink ||
    leaf.kind === fileStateKinds.directory ||
    leaf.kind === fileStateKinds.special
  ) {
    throw new Error("The approved path names a symlink or non-regular entry.");
  }
  return target;
};

const syncDirectory = async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const sameFileState = function sameFileState(left: FileState, right: FileState): boolean {
  return left.kind === right.kind && left.mode === right.mode && left.digest === right.digest;
};

const atomicWrite = async function atomicWrite(
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
    await ignoreFailure(async () => {
      await unlink(temporary);
    });
    throw error;
  }
  await handle.close();
  if (expectedPreimage !== undefined && !sameFileState(await fileState(path), expectedPreimage)) {
    await ignoreFailure(async () => {
      await unlink(temporary);
    });
    throw new Error("The file changed while its atomic replacement was prepared.");
  }
  await rename(temporary, path);
  await syncDirectory(nodePath.dirname(path));
};

const writeJournal = async function writeJournal(
  path: string,
  journal: LocalPublicationJournal,
): Promise<void> {
  await mkdir(nodePath.dirname(path), { mode: 0o700, recursive: true });
  await atomicWrite(path, Buffer.from(`${JSON.stringify(journal)}\n`), "644");
};

const createInitialJournal = async function createInitialJournal(
  path: string,
  journal: LocalPublicationPendingReceipt,
): Promise<void> {
  await mkdir(nodePath.dirname(path), { mode: 0o700, recursive: true });
  const candidate = `${path}.pending-${randomUUID()}`;
  await atomicWrite(candidate, Buffer.from(`${JSON.stringify(journal)}\n`), "644");
  try {
    // A hard link is an atomic no-overwrite compare-and-swap on this filesystem.
    await link(candidate, path);
    await syncDirectory(nodePath.dirname(path));
  } finally {
    await ignoreFailure(async () => {
      await unlink(candidate);
    });
  }
};

const isLocalPublicationJournal = function isLocalPublicationJournal(
  value: unknown,
): value is LocalPublicationJournal {
  if (value === null || typeof value !== "object" || !("status" in value)) {
    return false;
  }
  return value.status === "pending" || value.status === "succeeded" || value.status === "failed";
};

const assertJournal = function assertJournal(
  journal: unknown,
): asserts journal is LocalPublicationJournal {
  if (!isLocalPublicationJournal(journal)) {
    throw new Error("The durable local-publication journal has an unsupported state.");
  }
  assertCanonicalLocalPublicationJournal(journal);
};

export const readLocalPublicationJournal = async function readLocalPublicationJournal(
  destinationPath: string,
): Promise<LocalPublicationJournal | undefined> {
  const root = await resolveAllowedRepository(destinationPath);
  const path = await gitOwnedPath(root, LOCAL_PUBLICATION_JOURNAL_PATH);
  try {
    const journal: unknown = JSON.parse(await readFile(path, "utf-8"));
    assertJournal(journal);
    return journal;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw new Error(journalUnreadableMessage, {
      cause: error,
    });
  }
};

const acquireLock = async function acquireLock(root: string): Promise<() => Promise<void>> {
  const lockPath = await gitOwnedPath(root, "app-builder/local-publication.lock");
  await mkdir(nodePath.dirname(lockPath), { mode: 0o700, recursive: true });
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch {
    throw new Error("A local-publication attempt is already in progress.");
  }
  return async () => {
    await ignoreFailure(async () => {
      await rmdir(lockPath);
    });
  };
};

const pathEvidence = function pathEvidence(
  proposal: LocalPublicationProposal,
): readonly PublicationPathEvidence[] {
  return proposal.changes.map((change) => {
    const evidence: PublicationPathEvidence = { operation: change.kind, path: change.path };
    if (change.before !== undefined) {
      evidence.before = change.before;
    }
    if (change.after !== undefined) {
      evidence.after = change.after;
    }
    return evidence;
  });
};

const verifyPreconditions = async function verifyPreconditions(input: {
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
  ) {
    throw new Error("The source, review, or approved proposal changed before publication.");
  }
  const snapshot = await inspectLocalPublicationDestination({
    destinationPath: input.proposal.destinationPath,
    sourceReceipt: input.sourceReceipt,
  });
  const current = createLocalPublicationProposal({
    destination: snapshot,
    review: input.review,
    sourceReceipt: input.sourceReceipt,
  });
  if (!exactProposalMatch(current, input.proposal)) {
    throw new Error("The destination preconditions changed after approval.");
  }
  for (const change of input.proposal.changes) {
    const target = await safeTarget(snapshot.canonicalPath, change.path, false, []);
    if (!assertFileMatches(await fileState(target), change.before)) {
      throw new Error(`The approved preimage changed for ${change.path}.`);
    }
  }
  return snapshot;
};

export const verifyPublishedChangeSet = async function verifyPublishedChangeSet(input: {
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
  ) {
    throw new Error("The successful publication no longer matches the exact workflow or review.");
  }
  const root = await resolveAllowedRepository(input.receipt.destinationPath);
  const [headShaRaw, headTreeRaw] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]),
    git(root, ["rev-parse", "HEAD^{tree}"]),
  ]);
  const headSha = headShaRaw.trim();
  const headTree = headTreeRaw.trim();
  if (headSha !== input.receipt.baseSha || headTree !== input.receipt.sourceTree) {
    throw new Error("The destination Git identity changed after local publication.");
  }
  for (const change of input.receipt.changes) {
    const target = await safeTarget(root, change.path, false, []);
    if (!assertFileMatches(await fileState(target), change.after)) {
      throw new Error(`The local-publication postimage changed for ${change.path}.`);
    }
  }
  if (
    input.receipt.postconditionDigest !==
    stableDigest(
      input.receipt.pathEvidence.map(({ path, after: postimage }) => ({
        path,
        postimage,
      })),
    )
  ) {
    throw new Error("The local-publication postcondition digest is malformed.");
  }
  const destination = await inspectLocalPublicationDestination({
    destinationPath: root,
    sourceReceipt: input.sourceReceipt,
  });
  if (
    destination.statusDigest !== input.receipt.afterStatusDigest ||
    unrelatedProjectionDigest(destination, input.receipt.approvedPaths) !==
      input.receipt.unrelatedProjectionDigest
  ) {
    throw new Error(
      "The destination status or unrelated-work projection changed after publication.",
    );
  }
  const durable = await readLocalPublicationJournal(root);
  if (durable?.status !== "succeeded" || durable.digest !== input.receipt.digest) {
    throw new Error("The durable local-publication journal does not match the success receipt.");
  }
};

interface PublicationRecovery {
  appliedPaths: string[];
  conflictedPaths: string[];
  rolledBackPaths: string[];
  uncertainPaths: string[];
}

const observePublicationResults = async function observePublicationResults(input: {
  proposal: LocalPublicationProposal;
  hooks: LocalPublicationFaultHooks | undefined;
  mutationCallReturned: boolean;
}): Promise<{ observedPost: string[]; uncertainPaths: string[] }> {
  const changes = new Map(input.proposal.changes.map((change) => [change.path, change]));
  const observations = await Promise.all(
    input.proposal.executionPaths.map(async (path, index) => {
      const change = changes.get(path);
      if (change === undefined) {
        return { path, state: null, uncertain: true };
      }
      try {
        await input.hooks?.beforeRollback?.(path, index);
        await input.hooks?.beforeUncertainClassification?.(path, index);
        const target = await safeTarget(input.proposal.destinationPath, path, false, []);
        const state = await fileState(target);
        return {
          path,
          state,
          uncertain:
            !input.mutationCallReturned &&
            !assertFileMatches(state, change.after) &&
            !assertFileMatches(state, change.before),
        };
      } catch {
        return { path, state: null, uncertain: !input.mutationCallReturned };
      }
    }),
  );
  const observedPost: string[] = [];
  const uncertainPaths: string[] = [];
  for (const entry of observations) {
    const change = changes.get(entry.path);
    if (entry.uncertain) {
      uncertainPaths.push(entry.path);
    }
    if (
      entry.state !== null &&
      change !== undefined &&
      assertFileMatches(entry.state, change.after)
    ) {
      observedPost.push(entry.path);
    }
  }
  return {
    observedPost,
    uncertainPaths,
  };
};

const applyRollbackPatch = async function applyRollbackPatch(input: {
  proposal: LocalPublicationProposal;
  observedPost: string[];
  overlay: ReadonlyMap<string, FileState>;
  preimages: ReadonlyMap<string, FileState>;
}): Promise<void> {
  if (input.observedPost.length === 0) {
    return;
  }
  const rollbackPatch = await buildExactGitPatch({
    changes: input.proposal.changes,
    executionPaths: input.observedPost,
    gitDirectoryPath: input.proposal.gitDirectoryPath,
    overlay: input.overlay,
    preimages: input.preimages,
  });
  try {
    await fixedGitApply(input.proposal.destinationPath, rollbackPatch.path, {
      check: true,
      reverse: true,
    });
    await fixedGitApply(input.proposal.destinationPath, rollbackPatch.path, { reverse: true });
  } finally {
    await rm(rollbackPatch.directory, { force: true, recursive: true });
  }
};

const classifyRollbackResults = async function classifyRollbackResults(input: {
  proposal: LocalPublicationProposal;
  observedPost: string[];
}): Promise<{ rolledBackPaths: string[]; conflictedPaths: string[] }> {
  const changes = new Map(input.proposal.changes.map((change) => [change.path, change]));
  const results = await Promise.all(
    input.observedPost.map(async (path) => {
      const change = changes.get(path);
      if (change === undefined) {
        return { path, rolledBack: false };
      }
      try {
        const target = await safeTarget(input.proposal.destinationPath, path, false, []);
        return {
          path,
          rolledBack: assertFileMatches(await fileState(target), change.before),
        };
      } catch {
        return { path, rolledBack: false };
      }
    }),
  );
  const conflictedPaths: string[] = [];
  const rolledBackPaths: string[] = [];
  for (const result of results) {
    (result.rolledBack ? rolledBackPaths : conflictedPaths).push(result.path);
  }
  return { conflictedPaths, rolledBackPaths };
};

const recoverPublication = async function recoverPublication(input: {
  proposal: LocalPublicationProposal;
  hooks: LocalPublicationFaultHooks | undefined;
  overlay: ReadonlyMap<string, FileState>;
  preimages: ReadonlyMap<string, FileState>;
  appliedPaths: string[];
  mutationCallReturned: boolean;
}): Promise<PublicationRecovery> {
  const observations = await observePublicationResults(input);
  const appliedPaths = input.mutationCallReturned ? input.appliedPaths : observations.observedPost;
  const observedPostSet = new Set(observations.observedPost);
  const conflicted = new Set(appliedPaths.filter((path) => !observedPostSet.has(path)));
  try {
    await applyRollbackPatch({ ...input, observedPost: observations.observedPost });
  } catch {
    // Exact per-path readback below decides the canonical partition.
  }
  const classified = await classifyRollbackResults({
    observedPost: observations.observedPost,
    proposal: input.proposal,
  });
  for (const path of classified.conflictedPaths) {
    conflicted.add(path);
  }
  const executionPosition = new Map(
    input.proposal.executionPaths.map((path, index) => [path, index]),
  );
  const byExecutionOrder = (left: string, right: string) =>
    (executionPosition.get(left) ?? -1) - (executionPosition.get(right) ?? -1);
  const rolledBackPaths = classified.rolledBackPaths.toSorted(byExecutionOrder);
  const conflictedPaths = [...conflicted].toSorted(byExecutionOrder);
  const uncertainPaths = observations.uncertainPaths.toSorted(byExecutionOrder);
  return { appliedPaths, conflictedPaths, rolledBackPaths, uncertainPaths };
};

export const assertNoApprovedOverlap = function assertNoApprovedOverlap(
  proposal: LocalPublicationProposal,
  dirty: readonly ParsedGitStatus[],
): void {
  if (
    dirty.some((entry) =>
      proposal.approvedPaths.some(
        (path) =>
          pathsOverlap(path, entry.path) ||
          (entry.originalPath !== undefined && pathsOverlap(path, entry.originalPath)),
      ),
    )
  ) {
    throw new Error("A dirty path overlaps the approved publication path set.");
  }
};
