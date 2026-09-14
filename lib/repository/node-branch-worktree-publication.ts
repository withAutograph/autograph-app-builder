import { randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import {
  chmodSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import nodePath from "node:path";
import { tmpdir } from "node:os";

import {
  assertCanonicalBranchWorktreeJournal,
  assertExactBranchWorktreeProposal,
  branchJournalDigest,
  createBranchWorktreePublicationProposal,
  exactBranchWorktreeProposalMatch,
  proposalFromBranchJournal,
} from "./branch-worktree-publication";
import type {
  BranchWorktreePublicationFailureReceipt,
  BranchWorktreePublicationJournal,
  BranchWorktreePublicationPendingReceipt,
  BranchWorktreePublicationProposal,
  BranchWorktreePublicationSuccessReceipt,
} from "./branch-worktree-publication";
import { hasTestCapability } from "../testing/test-capability";
import { contentDigest, stableDigest } from "./local-publication";
import type { DestinationSnapshot } from "./local-publication";
import type { ReviewedChangeSetReceipt } from "./reviewed-change-set";
import { sourceIdentityDigest } from "./source-receipt";
import type { SourceReceipt } from "./source-receipt";
import { safeSourcePath } from "./source-path";
import { compareOverlayPaths } from "./target-apply";
import { resolveAllowedRepository } from "./supported-template";

const { dirname, isAbsolute, relative, resolve: pathResolve, sep } = nodePath;

export interface BranchWorktreePublicationFaultHooks {
  afterLockReady?: (pid: number) => void | Promise<void>;
  beforePendingJournal?: () => void | Promise<void>;
  afterPendingJournal?: () => void | Promise<void>;
  afterBranchCreation?: () => void | Promise<void>;
  afterWorktreeCreation?: () => void | Promise<void>;
  afterPathMutation?: (path: string, index: number) => void | Promise<void>;
  beforeSourcePostcondition?: () => void | Promise<void>;
  beforeTerminalJournal?: () => void | Promise<void>;
  preserveNonterminalJournal?: boolean;
}

interface FileState {
  kind: "absent" | "regular" | "directory" | "symlink" | "special";
  mode?: string;
  digest?: string;
}

const gitEnvironment = (): NodeJS.ProcessEnv => ({
  GIT_ATTR_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  HOME: "/dev/null",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  NODE_ENV: process.env.NODE_ENV ?? "production",
  PATH: "/usr/bin:/bin",
  TMPDIR: "/tmp",
  XDG_CONFIG_HOME: "/dev/null",
});

const lockHelperEnvironment = (): NodeJS.ProcessEnv => ({
  HOME: "/dev/null",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  NODE_ENV: "production",
  PATH: "/usr/bin:/bin",
  TMPDIR: "/tmp",
  XDG_CONFIG_HOME: "/dev/null",
});

const publicationLockHolderScript = String.raw`
const fs = require("node:fs");
const [path, expectedDevice, expectedInode, lease] = process.argv.slice(1);
const fd = fs.openSync(path, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
const state = fs.fstatSync(fd);
if (
  String(state.dev) !== expectedDevice ||
  String(state.ino) !== expectedInode ||
  !state.isFile() ||
  state.nlink !== 1
) {
  fs.closeSync(fd);
  process.stderr.write("unsafe publication lock inode\n");
  process.exit(74);
}
const existing = fs.readFileSync(fd, "utf-8");
if (existing.startsWith("APP_BUILDER_PUBLICATION_LEASE_V1:")) {
  fs.closeSync(fd);
  process.stderr.write("abandoned publication lease requires explicit recovery/reset\n");
  process.exit(73);
}
fs.ftruncateSync(fd, 0);
const marker = Buffer.from(lease, "utf-8");
let markerOffset = 0;
while (markerOffset < marker.length) {
  const written = fs.writeSync(
    fd,
    marker,
    markerOffset,
    marker.length - markerOffset,
    markerOffset,
  );
  if (written <= 0) {
    fs.closeSync(fd);
    process.stderr.write("publication lease write made no progress\n");
    process.exit(75);
  }
  markerOffset += written;
}
fs.ftruncateSync(fd, marker.length);
fs.fsyncSync(fd);
const observedMarker = Buffer.alloc(marker.length);
let observedOffset = 0;
while (observedOffset < observedMarker.length) {
  const read = fs.readSync(
    fd,
    observedMarker,
    observedOffset,
    observedMarker.length - observedOffset,
    observedOffset,
  );
  if (read <= 0) break;
  observedOffset += read;
}
if (observedOffset !== marker.length || !observedMarker.equals(marker)) {
  fs.closeSync(fd);
  process.stderr.write("publication lease read-back mismatch\n");
  process.exit(76);
}
process.stdout.write("READY\n");
let command = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => { command += chunk; });
process.stdin.on("end", () => {
  if (command === "RELEASE\n") {
    fs.ftruncateSync(fd, 0);
    fs.fsyncSync(fd);
  }
  fs.closeSync(fd);
});
process.stdin.resume();
`;

const gitExecutable = (): string => {
  if (existsSync("/usr/bin/git")) return "/usr/bin/git";
  if (existsSync("/bin/git")) return "/bin/git";
  throw new Error("The fixed system Git executable is unavailable.");
};

const gitArguments = (root: string, args: readonly string[]): string[] => [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.attributesfile=/dev/null",
  "-C",
  root,
  ...args,
];

const git = (root: string, args: readonly string[]): string =>
  execFileSync(gitExecutable(), gitArguments(root, args), {
    encoding: "utf-8",
    env: gitEnvironment(),
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

const gitBuffer = (root: string, args: readonly string[]): Buffer =>
  execFileSync(gitExecutable(), gitArguments(root, args), {
    encoding: "buffer",
    env: gitEnvironment(),
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

const parseCanonicalPathList = (output: Buffer, message: string): string[] => {
  const paths = output.toString("utf-8").split("\0").filter(Boolean);
  const canonical = Buffer.from(`${paths.join("\0")}${paths.length === 0 ? "" : "\0"}`);
  if (canonical.compare(output) !== 0 || paths.some((path) => !safeSourcePath(path)))
    throw new Error(message);
  return paths.toSorted(compareOverlayPaths);
};

const publicationRoot = (): string => {
  const configured = process.env.APP_BUILDER_BRANCH_WORKTREE_ROOT;
  const testRoot =
    configured === undefined && hasTestCapability("simulated-publication")
      ? pathResolve(realpathSync(tmpdir()), "autograph-app-builder-branch-publication")
      : undefined;
  if (testRoot !== undefined) {
    try {
      mkdirSync(testRoot, { mode: 0o700 });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const testRootState = lstatSync(testRoot);
    if (!testRootState.isDirectory() || testRootState.isSymbolicLink())
      throw new Error("The test publication root is unsafe.");
    chmodSync(testRoot, 0o700);
  }
  const candidate = configured ?? testRoot;
  if (candidate === undefined || !isAbsolute(candidate))
    throw new Error(
      "APP_BUILDER_BRANCH_WORKTREE_ROOT must be an absolute builder-owned directory.",
    );
  try {
    const resolved = pathResolve(candidate);
    const state = lstatSync(resolved);
    const canonical = realpathSync(resolved);
    const currentUid = process.geteuid?.();
    if (
      currentUid === undefined ||
      !state.isDirectory() ||
      state.isSymbolicLink() ||
      canonical !== resolved ||
      state.uid !== currentUid ||
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
      (state.mode & 0o777) !== 0o700
    )
      throw new Error(
        "The publication root must be canonical, owner-only, and owned by the current user.",
      );
    return canonical;
  } catch (error) {
    throw new Error(
      "APP_BUILDER_BRANCH_WORKTREE_ROOT must already exist as a canonical builder-owned directory.",
      { cause: error },
    );
  }
};

const within = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

const worktreePath = (identity: string): string =>
  pathResolve(publicationRoot(), "worktrees", identity);

const journalPath = (identity: string): string =>
  pathResolve(publicationRoot(), "journals", `${identity}.json`);

const assertContainedNoLinkPath = async (
  candidate: string,
  options: {
    leaf?: "directory" | "regular" | "absent-or-directory" | "absent-or-regular";
  } = {},
): Promise<void> => {
  const root = publicationRoot();
  const rootState = await lstat(root);
  if (!within(root, candidate))
    throw new Error("The builder-owned publication path escapes its root.");
  const path = relative(root, candidate);
  if (path === "") return;
  const segments = path.split(sep);
  let cursor = root;
  for (let index = 0; index < segments.length; index += 1) {
    cursor = pathResolve(cursor, segments[index]);
    let state;
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      state = await lstat(cursor);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (
          options.leaf === undefined ||
          options.leaf === "absent-or-directory" ||
          options.leaf === "absent-or-regular"
        )
          return;
        throw new Error("The builder-owned publication path has a missing ancestor.", {
          cause: error,
        });
      }
      throw error;
    }
    if (state.isSymbolicLink())
      throw new Error("The builder-owned publication path traverses a symbolic link.");
    const isLeaf = index === segments.length - 1;
    if (!isLeaf && !state.isDirectory())
      throw new Error("The builder-owned publication path traverses a non-directory.");
    if (
      isLeaf &&
      (options.leaf === "directory" || options.leaf === "absent-or-directory") &&
      !state.isDirectory()
    )
      throw new Error("The builder-owned publication directory is unsafe.");
    if (
      isLeaf &&
      (options.leaf === "regular" || options.leaf === "absent-or-regular") &&
      !state.isFile()
    )
      throw new Error("The builder-owned publication file is unsafe.");
    if (state.uid !== rootState.uid || state.dev !== rootState.dev)
      throw new Error("The builder-owned publication path changed owner or filesystem.");
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    if (state.isDirectory() && (state.mode & 0o777) !== 0o700)
      throw new Error("The builder-owned publication directory is not owner-only.");
    if (
      isLeaf &&
      (options.leaf === "regular" || options.leaf === "absent-or-regular") &&
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
      ((state.mode & 0o777) !== 0o600 || state.nlink !== 1)
    )
      throw new Error("The builder-owned publication file is not an exclusive owner-only inode.");
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    if ((await realpath(cursor)) !== cursor)
      throw new Error("The builder-owned publication path is not canonical.");
  }
};

const assertPublicationLayoutSafe = async (): Promise<void> => {
  for (const family of ["journals", "staging", "worktrees"] as const)
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    await assertContainedNoLinkPath(pathResolve(publicationRoot(), family), {
      leaf: "absent-or-directory",
    });
};

interface PublicationLock {
  pid: number;
  assertHeld: () => void;
  lost: Promise<never>;
  release: () => Promise<void>;
}

const assertOwnedPublicationFileHandle = async (
  handle: Awaited<ReturnType<typeof open>>,
): Promise<void> => {
  const [state, rootState] = await Promise.all([handle.stat(), lstat(publicationRoot())]);
  if (
    !state.isFile() ||
    state.uid !== rootState.uid ||
    state.dev !== rootState.dev ||
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    (state.mode & 0o777) !== 0o600 ||
    state.nlink !== 1
  )
    throw new Error("The builder-owned publication file descriptor is unsafe.");
};

const syncDirectory = async (path: string, builderOwned = false): Promise<void> => {
  if (builderOwned) await assertContainedNoLinkPath(path, { leaf: "directory" });
  // oxlint-disable-next-line eslint/no-bitwise -- Intentional binary open-flag combination.
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isDirectory()) throw new Error("The builder-owned publication directory is unsafe.");
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const durableDirectory = async (path: string): Promise<void> => {
  const root = publicationRoot();
  if (!within(root, path))
    throw new Error("The builder-owned publication directory escapes its root.");
  let cursor = root;
  for (const segment of relative(root, path).split(sep).filter(Boolean)) {
    const parent = cursor;
    cursor = pathResolve(cursor, segment);
    let created = false;
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      await mkdir(cursor, { mode: 0o700 });
      created = true;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    if (created) await chmod(cursor, 0o700);
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    await assertContainedNoLinkPath(cursor, { leaf: "directory" });
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    await syncDirectory(cursor, true);
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    await syncDirectory(parent, true);
  }
};

const acquirePublicationLock = async (identity: string): Promise<PublicationLock> => {
  const path = pathResolve(publicationRoot(), "locks", `${identity}.lock`);
  const directory = dirname(path);
  await durableDirectory(directory);
  await assertContainedNoLinkPath(path, { leaf: "absent-or-regular" });
  try {
    const state = await lstat(path);
    if (!state.isFile() || state.isSymbolicLink())
      throw new Error("The OS publication lock path is not a regular file.");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      const handle = await open(
        path,
        // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        await assertOwnedPublicationFileHandle(handle);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(directory, true);
    } catch (createError: unknown) {
      if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError;
      const state = await lstat(path);
      if (!state.isFile() || state.isSymbolicLink())
        throw new Error("The OS publication lock path is not a regular file.", {
          cause: createError,
        });
    }
  }
  let helper: { args: string[]; command: string } | undefined;
  if (existsSync("/usr/bin/flock")) {
    helper = { args: ["-n", path], command: "/usr/bin/flock" };
  } else if (existsSync("/bin/flock")) {
    helper = { args: ["-n", path], command: "/bin/flock" };
  } else if (existsSync("/usr/bin/lockf")) {
    helper = { args: ["-k", "-t", "0", path], command: "/usr/bin/lockf" };
  }
  if (helper === undefined)
    throw new Error("Branch-worktree publication requires the OS flock or lockf utility.");
  // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
  const lockHandle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let lockState: Awaited<ReturnType<typeof lockHandle.stat>>;
  try {
    await assertOwnedPublicationFileHandle(lockHandle);
    lockState = await lockHandle.stat();
  } finally {
    await lockHandle.close();
  }
  const holder = spawn(
    helper.command,
    [
      ...helper.args,
      process.execPath,
      "-e",
      publicationLockHolderScript,
      path,
      String(lockState.dev),
      String(lockState.ino),
      `APP_BUILDER_PUBLICATION_LEASE_V1:${randomUUID()}\n`,
    ],
    {
      env: lockHelperEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (holder.pid === undefined) throw new Error("The OS publication lock helper did not start.");
  let stderr = "";
  let terminal:
    | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
    | { kind: "error"; error: Error }
    | undefined;
  const { promise: terminalPromise, resolve: resolveTerminal } =
    Promise.withResolvers<NonNullable<typeof terminal>>();
  holder.once("error", (error) => {
    terminal = { error, kind: "error" };
    resolveTerminal(terminal);
  });
  holder.once("exit", (code, signal) => {
    if (terminal !== undefined) return;
    terminal = { code, kind: "exit", signal };
    resolveTerminal(terminal);
  });
  holder.stderr.setEncoding("utf-8");
  holder.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const {
    promise: ready,
    reject: rejectReady,
    resolve: resolveReady,
  } = Promise.withResolvers<undefined>();
  const timeout = setTimeout(() => {
    holder.kill();
    rejectReady(new Error("The OS publication lock did not become ready."));
  }, 5000);
  void (async () => {
    const outcome = await terminalPromise;
    clearTimeout(timeout);
    rejectReady(
      outcome.kind === "error"
        ? outcome.error
        : new Error(
            `A branch-worktree publication operation is already in progress${stderr.trim() === "" ? "." : `: ${stderr.trim()}`}`,
          ),
    );
  })();
  holder.stdout.setEncoding("utf-8");
  holder.stdout.once("data", (chunk: string) => {
    clearTimeout(timeout);
    if (chunk !== "READY\n") {
      holder.kill();
      rejectReady(new Error("The OS publication lock handshake failed."));
      return;
    }
    resolveReady(undefined as undefined);
  });
  await ready;
  const lockLostError = () => {
    if (terminal?.kind === "error")
      return new Error("The OS publication lock helper failed.", {
        cause: terminal.error,
      });
    return new Error(
      `The OS publication lock helper exited before release${terminal?.kind === "exit" && terminal.signal !== null ? ` (${terminal.signal})` : "."}`,
    );
  };
  // This derived promise intentionally races the terminal lease signal.
  // oxlint-disable-next-line promise/prefer-await-to-then
  const lost = terminalPromise.then(() => {
    throw lockLostError();
  });
  let released = false;
  return {
    assertHeld: () => {
      if (terminal !== undefined) throw lockLostError();
    },
    lost,
    pid: holder.pid,
    release: async () => {
      if (released) return;
      released = true;
      if (terminal === undefined) holder.stdin.end("RELEASE\n");
      const outcome = await terminalPromise;
      if (outcome.kind === "error" || outcome.code !== 0 || outcome.signal !== null)
        throw lockLostError();
    },
  };
};

const atomicWrite = async (path: string, value: string): Promise<void> => {
  await durableDirectory(dirname(path));
  await assertContainedNoLinkPath(path, { leaf: "absent-or-regular" });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await assertContainedNoLinkPath(temporary, { leaf: "absent-or-regular" });
  const handle = await open(
    temporary,
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await assertOwnedPublicationFileHandle(handle);
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await assertContainedNoLinkPath(path, { leaf: "absent-or-regular" });
  await rename(temporary, path);
  await syncDirectory(dirname(path), true);
};

const createInitialJournal = async (
  path: string,
  journal: BranchWorktreePublicationPendingReceipt,
): Promise<void> => {
  await durableDirectory(dirname(path));
  await assertContainedNoLinkPath(path, { leaf: "absent-or-regular" });
  const candidate = `${path}.${randomUUID()}.pending`;
  await assertContainedNoLinkPath(candidate, { leaf: "absent-or-regular" });
  const handle = await open(
    candidate,
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await assertOwnedPublicationFileHandle(handle);
    await handle.writeFile(`${JSON.stringify(journal)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await assertContainedNoLinkPath(path, { leaf: "absent-or-regular" });
    await link(candidate, path);
    await syncDirectory(dirname(path), true);
  } finally {
    await unlink(candidate).catch(() => null);
    await syncDirectory(dirname(path), true);
  }
};

const writeJournal = async (
  path: string,
  journal: BranchWorktreePublicationJournal,
): Promise<void> => {
  await atomicWrite(path, `${JSON.stringify(journal)}\n`);
};

export const readBranchWorktreePublicationJournal = async (
  proposalOrIdentity: BranchWorktreePublicationProposal | string,
): Promise<BranchWorktreePublicationJournal | undefined> => {
  const identity =
    typeof proposalOrIdentity === "string"
      ? proposalOrIdentity
      : proposalOrIdentity.publicationIdentityDigest;
  try {
    const path = journalPath(identity);
    await assertContainedNoLinkPath(path, { leaf: "absent-or-regular" });
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let contents: string;
    try {
      await assertOwnedPublicationFileHandle(handle);
      contents = await handle.readFile("utf-8");
    } finally {
      await handle.close();
    }
    const journal = JSON.parse(contents) as BranchWorktreePublicationJournal;
    assertCanonicalBranchWorktreeJournal(journal);
    return journal;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("The durable branch-worktree publication journal is unreadable.", {
      cause: error,
    });
  }
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const branchExists = (source: string, branch: string): boolean => {
  const result = spawnSync(
    gitExecutable(),
    gitArguments(source, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]),
    { env: gitEnvironment() },
  );
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error("Git could not inspect the proposed publication branch.");
};

const exactBranchSha = (proposal: BranchWorktreePublicationProposal): string | undefined => {
  if (!branchExists(proposal.sourcePath, proposal.branchName)) return undefined;
  return git(proposal.sourcePath, ["rev-parse", `refs/heads/${proposal.branchName}`]).trim();
};

const createExactBranch = (proposal: BranchWorktreePublicationProposal): void => {
  const result = spawnSync(
    gitExecutable(),
    gitArguments(proposal.sourcePath, [
      "update-ref",
      `refs/heads/${proposal.branchName}`,
      proposal.baseSha,
      "0".repeat(proposal.baseSha.length),
    ]),
    { encoding: "utf-8", env: gitEnvironment() },
  );
  if (result.status !== 0)
    throw new Error(
      `Git could not create the approved publication branch: ${result.stderr.trim() || "unknown error"}`,
    );
};

const registeredWorktreeEntries = (
  proposal: BranchWorktreePublicationProposal,
): readonly { path: string; branch?: string; head?: string }[] => {
  const records = git(proposal.sourcePath, ["worktree", "list", "--porcelain"])
    .split("\n\n")
    .filter(Boolean);
  return records.map((record) => {
    const fields = Object.fromEntries(
      record.split("\n").map((line) => {
        const separator = line.indexOf(" ");
        return separator === -1
          ? [line, ""]
          : [line.slice(0, separator), line.slice(separator + 1)];
      }),
    );
    return {
      branch: fields.branch,
      head: fields.HEAD,
      path: fields.worktree,
    };
  });
};

const exactStateMatches = (state: FileState, expected: FileState): boolean =>
  state.kind === expected.kind && state.mode === expected.mode && state.digest === expected.digest;

const fileState = async (path: string): Promise<FileState> => {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink())
      return {
        digest: contentDigest(Buffer.from(await readlink(path))),
        kind: "symlink",
      };
    if (info.isDirectory()) return { kind: "directory" };
    if (!info.isFile()) return { kind: "special" };
    const bytes = await readFile(path);
    return {
      digest: contentDigest(bytes),
      kind: "regular",
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional permission bitmask.
      mode: (info.mode & 0o777).toString(8),
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw error;
  }
};

const exactTreeEntries = (sourcePath: string, sourceSha: string): TreeEntry[] => {
  const output = gitBuffer(sourcePath, ["ls-tree", "-r", "-z", "--full-tree", sourceSha]);
  const result: TreeEntry[] = [];
  for (const record of output.toString("utf-8").split("\0").filter(Boolean)) {
    const match =
      /^(?<mode>100644|100755|120000|160000) (?<type>blob|commit) (?<objectId>[0-9a-f]{40,64})\t(?<path>.+)$/u.exec(
        record,
      );
    if (match === null) throw new Error("The source tree contains an unsupported entry.");
    const { mode, type, objectId, path } = match.groups ?? {};
    if (mode === "160000" || type !== "blob")
      throw new Error("Branch-worktree publication does not materialize Git submodules.");
    if (path === undefined || objectId === undefined || !safeSourcePath(path))
      throw new Error("The source tree contains an unsafe path.");
    const bytes = gitBuffer(sourcePath, ["cat-file", "blob", objectId]);
    if (mode === "120000") {
      const target = bytes.toString("utf-8");
      if (Buffer.from(target).compare(bytes) !== 0 || target.includes("\0"))
        throw new Error("The source tree contains an invalid symbolic link.");
      result.push({
        bytes,
        mode: "120000",
        objectId,
        path,
        state: { digest: contentDigest(bytes), kind: "symlink" },
      });
      continue;
    }
    const fileMode = mode === "100755" ? "755" : "644";
    result.push({
      bytes,
      mode: fileMode,
      objectId,
      path,
      state: { digest: contentDigest(bytes), kind: "regular", mode: fileMode },
    });
  }
  return result;
};

const assertOwnedPartialWorktree = async (
  proposal: BranchWorktreePublicationProposal,
): Promise<void> => {
  const rootState = await lstat(proposal.worktreePath);
  if (!rootState.isDirectory() || rootState.isSymbolicLink())
    throw new Error("The partial approved worktree path is unsafe.");
  const base = new Map(
    exactTreeEntries(proposal.sourcePath, proposal.baseSha).map((entry) => [
      entry.path,
      entry.state,
    ]),
  );
  const changes = new Map(proposal.changes.map((change) => [change.path, change]));
  const allowedPaths = new Set([...base.keys(), ...changes.keys()]);
  const commonGitDirectory = await realpath(
    git(proposal.sourcePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim(),
  );
  const worktreeAdminRoot = pathResolve(commonGitDirectory, "worktrees");
  const exactAdminPaths: string[] = [];
  for (const entry of await readdir(worktreeAdminRoot, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const adminPath = pathResolve(worktreeAdminRoot, entry.name);
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      const linkedPathContents = await readFile(pathResolve(adminPath, "gitdir"), "utf-8");
      const linkedPath = linkedPathContents.trim();
      if (pathResolve(linkedPath) === pathResolve(proposal.worktreePath, ".git"))
        exactAdminPaths.push(adminPath);
    } catch {
      // An unrelated or incomplete registration is not ownership evidence.
    }
  }
  if (exactAdminPaths.length !== 1)
    throw new Error("The partial worktree lacks one exact owned Git registration.");
  let exactGitLinkSeen = false;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const target = pathResolve(directory, entry.name);
      if (prefix === "" && path === ".git") {
        // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
        const state = await lstat(target);
        if (!state.isFile() || state.isSymbolicLink())
          throw new Error("The partial worktree Git link is unsafe.");
        // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
        const match = /^gitdir: (?<gitdir>.+)\n?$/u.exec(await readFile(target, "utf-8"));
        if (match === null || !isAbsolute(match[1]) || pathResolve(match[1]) !== exactAdminPaths[0])
          throw new Error("The partial worktree Git link conflicts with intent.");
        exactGitLinkSeen = true;
        continue;
      }
      if (!safeSourcePath(path)) throw new Error("The partial worktree contains an unsafe path.");
      if (entry.isDirectory()) {
        if (![...allowedPaths].some((allowed) => allowed.startsWith(`${path}/`)))
          throw new Error(`The partial worktree contains unapproved directory ${path}.`);
        // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
        await visit(target, path);
        continue;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      const state = await fileState(target);
      const baseState = base.get(path);
      const after = changes.get(path)?.after;
      const afterState: FileState | undefined =
        after === undefined ? undefined : { kind: "regular", ...after };
      if (
        (baseState === undefined || !exactStateMatches(state, baseState)) &&
        (afterState === undefined || !exactStateMatches(state, afterState))
      )
        throw new Error(`The partial worktree contains conflicting content at ${path}.`);
    }
  };
  await visit(proposal.worktreePath, "");
  if (!exactGitLinkSeen) throw new Error("The partial worktree lacks its exact owned Git link.");
};

const createOrRepairExactWorktree = async (
  proposal: BranchWorktreePublicationProposal,
): Promise<void> => {
  const expectedBranch = `refs/heads/${proposal.branchName}`;
  const registration = registeredWorktreeEntries(proposal).find(
    ({ path, branch }) => path === proposal.worktreePath || branch === expectedBranch,
  );
  if (
    registration !== undefined &&
    (registration.path !== proposal.worktreePath ||
      registration.branch !== expectedBranch ||
      registration.head !== proposal.baseSha)
  )
    throw new Error("The partial worktree registration does not match durable intent.");
  if (await pathExists(proposal.worktreePath)) {
    try {
      git(proposal.worktreePath, ["rev-parse", "--absolute-git-dir"]);
      if (
        registration === undefined ||
        git(proposal.worktreePath, ["rev-parse", "--symbolic-full-name", "HEAD"]).trim() !==
          expectedBranch
      )
        throw new Error("The existing worktree does not match durable publication intent.");
      await chmod(proposal.worktreePath, 0o700);
      await assertContainedNoLinkPath(proposal.worktreePath, {
        leaf: "directory",
      });
      return;
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        error.message.includes("does not match durable publication intent")
      )
        throw error;
      if (registration === undefined)
        throw new Error("The unregistered publication path conflicts with durable intent.", {
          cause: error,
        });
      await assertOwnedPartialWorktree(proposal);
      await rm(proposal.worktreePath, { recursive: true });
      await syncDirectory(dirname(proposal.worktreePath), true);
    }
  }
  await mkdir(dirname(proposal.worktreePath), {
    mode: 0o700,
    recursive: true,
  });
  const result = spawnSync(
    gitExecutable(),
    gitArguments(proposal.sourcePath, [
      "worktree",
      "add",
      ...(registration === undefined ? [] : ["--force"]),
      "--no-checkout",
      proposal.worktreePath,
      proposal.branchName,
    ]),
    { encoding: "utf-8", env: gitEnvironment() },
  );
  if (result.status !== 0)
    throw new Error(
      `Git could not create the approved branch worktree: ${result.stderr.trim() || "unknown error"}`,
    );
  await chmod(proposal.worktreePath, 0o700);
  await assertContainedNoLinkPath(proposal.worktreePath, {
    leaf: "directory",
  });
};

interface TreeEntry {
  path: string;
  mode: "644" | "755" | "120000";
  objectId: string;
  bytes: Buffer;
  state: FileState;
}

const materializeAtomically = async (
  proposal: BranchWorktreePublicationProposal,
  target: string,
  bytes: Uint8Array,
  mode: string | "120000",
): Promise<void> => {
  const staging = pathResolve(publicationRoot(), "staging", proposal.publicationIdentityDigest);
  await durableDirectory(staging);
  const temporary = pathResolve(staging, randomUUID());
  try {
    if (mode === "120000") {
      await symlink(Buffer.from(bytes).toString("utf-8"), temporary);
      await syncDirectory(staging, true);
    } else {
      const handle = await open(temporary, "wx", Number.parseInt(mode, 8));
      try {
        await handle.writeFile(bytes);
        await handle.chmod(Number.parseInt(mode, 8));
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await rename(temporary, target);
    await syncDirectory(dirname(target));
  } finally {
    await unlink(temporary).catch(() => null);
  }
};

const safeTarget = async (root: string, path: string, createParents: boolean): Promise<string> => {
  if (!safeSourcePath(path)) throw new Error("The approved path is unsafe.");
  const target = pathResolve(root, path);
  if (!within(root, target)) throw new Error("The approved path escapes the publication worktree.");
  let cursor = root;
  for (const segment of path.split("/").slice(0, -1)) {
    cursor = pathResolve(cursor, segment);
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    const state = await fileState(cursor);
    if (state.kind === "absent" && createParents) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      await mkdir(cursor, { mode: 0o755 });
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      await syncDirectory(dirname(cursor));
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      await syncDirectory(cursor);
    } else if (state.kind !== "directory" && state.kind !== "absent")
      throw new Error("The approved path traverses a non-directory entry.");
  }
  const state = await fileState(target);
  if (["directory", "symlink", "special"].includes(state.kind))
    throw new Error("The approved path names a non-regular entry.");
  return target;
};

const matches = (
  state: FileState,
  expected: { mode: string; digest: string } | undefined,
): boolean =>
  expected === undefined
    ? state.kind === "absent"
    : state.kind === "regular" && state.mode === expected.mode && state.digest === expected.digest;

const ensureExactBaseMaterialization = async (
  proposal: BranchWorktreePublicationProposal,
  preserveReviewedPostimages: boolean,
  lock: PublicationLock,
): Promise<void> => {
  const entries = exactTreeEntries(proposal.sourcePath, proposal.baseSha);
  git(proposal.worktreePath, ["read-tree", proposal.baseSha]);
  lock.assertHeld();
  for (const entry of entries) {
    lock.assertHeld();
    const change = proposal.changes.find(({ path }) => path === entry.path);
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    const target = await safeTarget(proposal.worktreePath, entry.path, true);
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    const current = await fileState(target);
    if (exactStateMatches(current, entry.state)) continue;
    if (preserveReviewedPostimages && change !== undefined && matches(current, change.after))
      continue;
    if (current.kind !== "absent")
      throw new Error(`The publication worktree conflicts with the exact base at ${entry.path}.`);
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    await materializeAtomically(proposal, target, entry.bytes, entry.mode);
    lock.assertHeld();
  }
};

const assertNoCollision = async (proposal: BranchWorktreePublicationProposal): Promise<void> => {
  if (
    branchExists(proposal.sourcePath, proposal.branchName) ||
    (await pathExists(proposal.worktreePath))
  )
    throw new Error("The deterministic publication branch or worktree path already exists.");
};

const inspectBranchPublicationSource = async (input: {
  sourceReceipt: SourceReceipt;
  review: ReviewedChangeSetReceipt;
}): Promise<DestinationSnapshot> => {
  const canonicalPath = await resolveAllowedRepository(input.sourceReceipt.sourcePath);
  if (canonicalPath !== input.sourceReceipt.sourcePath)
    throw new Error("The source checkout changed canonical identity.");
  const [headSha, headTree, headReference, gitDirectoryPath] = await Promise.all([
    Promise.resolve(git(canonicalPath, ["rev-parse", "HEAD"]).trim()),
    Promise.resolve(git(canonicalPath, ["rev-parse", "HEAD^{tree}"]).trim()),
    Promise.resolve(git(canonicalPath, ["rev-parse", "--symbolic-full-name", "HEAD"]).trim()),
    realpath(git(canonicalPath, ["rev-parse", "--absolute-git-dir"]).trim()),
  ]);
  const [rootStat, gitDirectoryStat] = await Promise.all([
    stat(canonicalPath),
    stat(gitDirectoryPath),
  ]);
  const indexPath = git(canonicalPath, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
  ]).trim();
  const listed = gitBuffer(canonicalPath, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  const paths = parseCanonicalPathList(
    listed,
    "The source contains non-canonical, non-UTF-8, or unsafe paths.",
  );
  const statusEntries = await Promise.all(
    paths.map(async (path) => ({ path, state: await fileState(pathResolve(canonicalPath, path)) })),
  );
  for (const change of input.review.changes) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    const target = await safeTarget(canonicalPath, change.path, false);
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    if (!matches(await fileState(target), change.before))
      throw new Error(`The source has dirty overlap with approved path ${change.path}.`);
  }
  const dirtyDigest = stableDigest(statusEntries);
  const stable = {
    canonicalPath,
    contractDigest: sourceIdentityDigest(headSha, headTree),
    dirty: [] as const,
    dirtyDigest,
    gitDirectoryIdentity: {
      device: gitDirectoryStat.dev.toString(),
      inode: gitDirectoryStat.ino.toString(),
    },
    gitDirectoryPath,
    headReference,
    headSha,
    headTree,
    index: [] as const,
    indexFileDigest: contentDigest(await readFile(indexPath)),
    remoteDigest: stableDigest(git(canonicalPath, ["remote", "-v"])),
    rootIdentity: {
      device: rootStat.dev.toString(),
      inode: rootStat.ino.toString(),
    },
  };
  return { ...stable, statusDigest: stableDigest(stable) };
};

export const deriveBranchWorktreePublicationProposal = async (input: {
  sourceReceipt: SourceReceipt;
  review: ReviewedChangeSetReceipt;
}): Promise<BranchWorktreePublicationProposal> => {
  if (process.env.APP_BUILDER_BRANCH_WORKTREE_PUBLICATION !== "1")
    throw new Error(
      "Branch-worktree publication is disabled until APP_BUILDER_BRANCH_WORKTREE_PUBLICATION=1 is explicitly configured.",
    );
  const source = await inspectBranchPublicationSource(input);
  const root = publicationRoot();
  const rootState = await lstat(root);
  const commonGitDirectory = await realpath(
    git(source.canonicalPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim(),
  );
  if (
    within(root, source.canonicalPath) ||
    within(source.canonicalPath, root) ||
    within(root, source.gitDirectoryPath) ||
    within(source.gitDirectoryPath, root) ||
    within(root, commonGitDirectory) ||
    within(commonGitDirectory, root)
  )
    throw new Error(
      "The builder-owned publication root overlaps the source checkout or Git directories.",
    );
  const identity = stableDigest({
    reviewDigest: input.review.digest,
    sourceReceiptDigest: input.sourceReceipt.digest,
  });
  const proposal = createBranchWorktreePublicationProposal({
    publicationRootIdentity: {
      device: rootState.dev.toString(),
      inode: rootState.ino.toString(),
    },
    publicationRootPath: root,
    review: input.review,
    source,
    sourceReceipt: input.sourceReceipt,
    worktreePath: worktreePath(identity),
  });
  if (!within(publicationRoot(), proposal.worktreePath))
    throw new Error("The proposed worktree escapes its builder-owned root.");
  await assertNoCollision(proposal);
  return proposal;
};

const assertExactSource = async (input: {
  proposal: BranchWorktreePublicationProposal;
  sourceReceipt: SourceReceipt;
  review: ReviewedChangeSetReceipt;
}): Promise<void> => {
  assertExactBranchWorktreeProposal(input.proposal);
  if (
    input.proposal.sourceReceiptDigest !== input.sourceReceipt.digest ||
    input.proposal.reviewDigest !== input.review.digest ||
    input.proposal.changeSetDigest !== input.review.changeSetDigest
  )
    throw new Error("The source or reviewed change set changed after approval.");
  const current = await inspectBranchPublicationSource(input);
  const root = publicationRoot();
  const rootState = await lstat(root);
  if (
    root !== input.proposal.publicationRootPath ||
    rootState.dev.toString() !== input.proposal.publicationRootIdentity.device ||
    rootState.ino.toString() !== input.proposal.publicationRootIdentity.inode
  )
    throw new Error("The builder-owned publication root changed after approval.");
  const proposed = createBranchWorktreePublicationProposal({
    publicationRootIdentity: input.proposal.publicationRootIdentity,
    publicationRootPath: root,
    review: input.review,
    source: current,
    sourceReceipt: input.sourceReceipt,
    worktreePath: input.proposal.worktreePath,
  });
  if (!exactBranchWorktreeProposalMatch(input.proposal, proposed))
    throw new Error(
      "The source SHA, index, remote, status, review, paths, modes, or digests changed after approval.",
    );
};

const writePostimage = async (
  proposal: BranchWorktreePublicationProposal,
  path: string,
  bytes: Uint8Array,
  mode: string,
): Promise<void> => {
  const target = await safeTarget(proposal.worktreePath, path, true);
  await materializeAtomically(proposal, target, bytes, mode);
};

const worktreeFileStates = async (
  proposal: BranchWorktreePublicationProposal,
): Promise<readonly { path: string; state: FileState }[]> => {
  const cached = parseCanonicalPathList(
    gitBuffer(proposal.worktreePath, ["ls-files", "-z", "--cached"]),
    "The publication worktree contains non-canonical, non-UTF-8, or unsafe paths.",
  );
  const present: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (prefix === "" && path === ".git") continue;
      if (!safeSourcePath(path))
        throw new Error("The publication worktree contains an unsafe path.");
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      if (entry.isDirectory()) await visit(pathResolve(directory, entry.name), path);
      else present.push(path);
    }
  };
  await visit(proposal.worktreePath, "");
  const paths = [...new Set([...cached, ...present])].toSorted(compareOverlayPaths);
  return Promise.all(
    paths.map(async (path) => ({
      path,
      state: await fileState(pathResolve(proposal.worktreePath, path)),
    })),
  );
};

const worktreeSnapshot = async (proposal: BranchWorktreePublicationProposal) => {
  const root = await realpath(proposal.worktreePath);
  if (root !== proposal.worktreePath)
    throw new Error("The publication worktree path changed identity.");
  const [rootStat, gitDirectoryPath] = await Promise.all([
    stat(root),
    realpath(git(root, ["rev-parse", "--absolute-git-dir"]).trim()),
  ]);
  const gitDirectoryStat = await stat(gitDirectoryPath);
  const indexPath = git(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
  ]).trim();
  const statusEntries = await worktreeFileStates(proposal);
  return {
    contractDigest: sourceIdentityDigest(
      git(root, ["rev-parse", "HEAD"]).trim(),
      git(root, ["rev-parse", "HEAD^{tree}"]).trim(),
    ),
    gitDirectoryIdentity: {
      device: gitDirectoryStat.dev.toString(),
      inode: gitDirectoryStat.ino.toString(),
    },
    gitDirectoryPath,
    headReference: git(root, ["rev-parse", "--symbolic-full-name", "HEAD"]).trim(),
    headSha: git(root, ["rev-parse", "HEAD"]).trim(),
    headTree: git(root, ["rev-parse", "HEAD^{tree}"]).trim(),
    indexFileDigest: contentDigest(await readFile(indexPath)),
    remoteDigest: stableDigest(git(root, ["remote", "-v"])),
    root,
    rootIdentity: {
      device: rootStat.dev.toString(),
      inode: rootStat.ino.toString(),
    },
    statusDigest: stableDigest(statusEntries),
  };
};

const verifyWorktreeIdentity = async (proposal: BranchWorktreePublicationProposal) => {
  const snapshot = await worktreeSnapshot(proposal);
  if (
    snapshot.headSha !== proposal.baseSha ||
    snapshot.headTree !== proposal.sourceTree ||
    snapshot.headReference !== `refs/heads/${proposal.branchName}` ||
    snapshot.remoteDigest !== proposal.sourceRemoteDigest ||
    snapshot.contractDigest !== proposal.contractDigest ||
    git(proposal.sourcePath, ["rev-parse", `refs/heads/${proposal.branchName}`]).trim() !==
      proposal.baseSha
  )
    throw new Error("The branch or worktree no longer has its exact approved identity.");
  return snapshot;
};

const applyRemainingPostimages = async (input: {
  proposal: BranchWorktreePublicationProposal;
  review: ReviewedChangeSetReceipt;
  readOverlayFile: (path: string) => Promise<Uint8Array | null>;
  hooks?: BranchWorktreePublicationFaultHooks;
  lock: PublicationLock;
}): Promise<readonly string[]> => {
  const applied: string[] = [];
  for (let index = 0; index < input.proposal.changes.length; index += 1) {
    input.lock.assertHeld();
    const change = input.proposal.changes[index];
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    const target = await safeTarget(input.proposal.worktreePath, change.path, false);
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    const current = await fileState(target);
    if (matches(current, change.after)) {
      applied.push(change.path);
      continue;
    }
    if (!matches(current, change.before))
      throw new Error(`The publication worktree has conflicting bytes or mode for ${change.path}.`);
    if (change.after === undefined) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      await unlink(target);
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      await syncDirectory(dirname(target));
    } else {
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      const bytes = await input.readOverlayFile(change.path);
      if (bytes === null || contentDigest(bytes) !== change.after.digest)
        throw new Error(`The immutable apply overlay is stale for ${change.path}.`);
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      await writePostimage(input.proposal, change.path, bytes, change.after.mode);
    }
    applied.push(change.path);
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    await input.hooks?.afterPathMutation?.(change.path, index);
    input.lock.assertHeld();
  }
  return applied;
};

const assertPostimages = async (proposal: BranchWorktreePublicationProposal): Promise<void> => {
  const base = new Map(
    exactTreeEntries(proposal.sourcePath, proposal.baseSha).map((entry) => [
      entry.path,
      entry.state,
    ]),
  );
  const changes = new Map(proposal.changes.map((change) => [change.path, change]));
  const expectedPaths = new Set(base.keys());
  for (const change of proposal.changes) expectedPaths.add(change.path);
  const observed = await worktreeFileStates(proposal);
  if (
    JSON.stringify(observed.map(({ path }) => path)) !==
    JSON.stringify([...expectedPaths].toSorted(compareOverlayPaths))
  )
    throw new Error("The publication worktree contains an unapproved path.");
  for (const { path, state } of observed) {
    const change = changes.get(path);
    let expected: FileState | undefined;
    if (change === undefined) {
      expected = base.get(path);
    } else if (change.after === undefined) {
      expected = { kind: "absent" };
    } else {
      expected = { kind: "regular", ...change.after };
    }
    if (expected === undefined || !exactStateMatches(state, expected))
      throw new Error(`The publication worktree changed unexpectedly at ${path}.`);
  }
};

const pendingReceipt = (input: {
  proposal: BranchWorktreePublicationProposal;
  callId: string;
  recoveryOfDigest?: string;
}): BranchWorktreePublicationPendingReceipt => {
  const { digest: proposalDigest, ...proposal } = input.proposal;
  const unsigned = {
    ...proposal,
    proposalDigest,
    publishedByCallId: input.callId,
    status: "pending" as const,
    ...(input.recoveryOfDigest === undefined ? {} : { recoveryOfDigest: input.recoveryOfDigest }),
  };
  return { digest: branchJournalDigest(unsigned), ...unsigned };
};

const failureReceipt = (input: {
  proposal: BranchWorktreePublicationProposal;
  callId: string;
  recoveryOfDigest?: string;
  branchCreated: boolean;
  worktreeCreated: boolean;
  appliedPaths: readonly string[];
  reason: BranchWorktreePublicationFailureReceipt["reason"];
  failureMessage: string;
}): BranchWorktreePublicationFailureReceipt => {
  const { digest: proposalDigest, ...proposal } = input.proposal;
  const unsigned = {
    ...proposal,
    appliedPaths: input.appliedPaths,
    branchCreated: input.branchCreated,
    failureMessage: input.failureMessage,
    proposalDigest,
    publishedByCallId: input.callId,
    reason: input.reason,
    ...(input.recoveryOfDigest === undefined ? {} : { recoveryOfDigest: input.recoveryOfDigest }),
    recoveryRequired: true as const,
    status: "failed" as const,
    worktreeCreated: input.worktreeCreated,
  };
  return { digest: branchJournalDigest(unsigned), ...unsigned };
};

const successReceipt = async (input: {
  proposal: BranchWorktreePublicationProposal;
  callId: string;
  recoveryOfDigest?: string;
}): Promise<BranchWorktreePublicationSuccessReceipt> => {
  await assertPostimages(input.proposal);
  const snapshot = await verifyWorktreeIdentity(input.proposal);
  const { digest: proposalDigest, ...proposal } = input.proposal;
  const unsigned = {
    ...proposal,
    appliedPaths: input.proposal.approvedPaths,
    branchCreated: true,
    postconditionDigest: stableDigest(
      input.proposal.changes.map(({ path, after }) => ({ after, path })),
    ),
    proposalDigest,
    publishedByCallId: input.callId,
    ...(input.recoveryOfDigest === undefined ? {} : { recoveryOfDigest: input.recoveryOfDigest }),
    recoveryRequired: false as const,
    status: "succeeded" as const,
    worktreeCreated: true,
    worktreeGitDirectoryIdentity: snapshot.gitDirectoryIdentity,
    worktreeGitDirectoryPath: snapshot.gitDirectoryPath,
    worktreeHeadReference: snapshot.headReference,
    worktreeIndexFileDigest: snapshot.indexFileDigest,
    worktreeRemoteDigest: snapshot.remoteDigest,
    worktreeRootIdentity: snapshot.rootIdentity,
    worktreeStatusDigest: snapshot.statusDigest,
  };
  return { digest: branchJournalDigest(unsigned), ...unsigned };
};

export const verifyBranchWorktreePublication = async (input: {
  receipt: BranchWorktreePublicationSuccessReceipt;
  sourceReceipt: SourceReceipt;
  review: ReviewedChangeSetReceipt;
}): Promise<void> => {
  assertCanonicalBranchWorktreeJournal(input.receipt);
  const proposal = proposalFromBranchJournal(input.receipt);
  await assertExactSource({
    proposal,
    review: input.review,
    sourceReceipt: input.sourceReceipt,
  });
  await assertPostimages(proposal);
  const snapshot = await verifyWorktreeIdentity(proposal);
  if (
    snapshot.rootIdentity.device !== input.receipt.worktreeRootIdentity.device ||
    snapshot.rootIdentity.inode !== input.receipt.worktreeRootIdentity.inode ||
    snapshot.gitDirectoryPath !== input.receipt.worktreeGitDirectoryPath ||
    snapshot.gitDirectoryIdentity.device !== input.receipt.worktreeGitDirectoryIdentity.device ||
    snapshot.gitDirectoryIdentity.inode !== input.receipt.worktreeGitDirectoryIdentity.inode ||
    snapshot.indexFileDigest !== input.receipt.worktreeIndexFileDigest ||
    snapshot.statusDigest !== input.receipt.worktreeStatusDigest
  )
    throw new Error("The published branch-worktree receipt is stale.");
};

const executePublication = async (input: {
  proposal: BranchWorktreePublicationProposal;
  sourceReceipt: SourceReceipt;
  review: ReviewedChangeSetReceipt;
  readOverlayFile: (path: string) => Promise<Uint8Array | null>;
  publishedByCallId: string;
  recoveryOfDigest?: string;
  hooks?: BranchWorktreePublicationFaultHooks;
  lock: PublicationLock;
}): Promise<BranchWorktreePublicationSuccessReceipt | BranchWorktreePublicationFailureReceipt> => {
  let branchCreated = branchExists(input.proposal.sourcePath, input.proposal.branchName);
  let worktreeCreated = await pathExists(input.proposal.worktreePath);
  let appliedPaths: readonly string[] = [];
  try {
    input.lock.assertHeld();
    await assertExactSource(input);
    input.lock.assertHeld();
    if (!branchCreated) {
      if (worktreeCreated)
        throw new Error("A publication worktree exists without its exact approved branch.");
      createExactBranch(input.proposal);
      input.lock.assertHeld();
      branchCreated = true;
      await input.hooks?.afterBranchCreation?.();
      input.lock.assertHeld();
    }
    if (exactBranchSha(input.proposal) !== input.proposal.baseSha)
      throw new Error("The approved publication branch changed after durable intent.");
    const hadWorktree = worktreeCreated;
    await createOrRepairExactWorktree(input.proposal);
    input.lock.assertHeld();
    worktreeCreated = true;
    await ensureExactBaseMaterialization(input.proposal, hadWorktree, input.lock);
    await input.hooks?.afterWorktreeCreation?.();
    input.lock.assertHeld();
    const before = await verifyWorktreeIdentity(input.proposal);
    appliedPaths = await applyRemainingPostimages(input);
    input.lock.assertHeld();
    const after = await verifyWorktreeIdentity(input.proposal);
    if (
      before.indexFileDigest !== after.indexFileDigest ||
      before.remoteDigest !== after.remoteDigest
    )
      throw new Error("The worktree index or remote configuration changed during publication.");
    const success = await successReceipt({
      callId: input.publishedByCallId,
      proposal: input.proposal,
      recoveryOfDigest: input.recoveryOfDigest,
    });
    await input.hooks?.beforeSourcePostcondition?.();
    input.lock.assertHeld();
    await assertExactSource(input);
    input.lock.assertHeld();
    await input.hooks?.beforeTerminalJournal?.();
    input.lock.assertHeld();
    await writeJournal(journalPath(input.proposal.publicationIdentityDigest), success);
    input.lock.assertHeld();
    return success;
  } catch (error: unknown) {
    if (input.hooks?.preserveNonterminalJournal === true) throw error;
    input.lock.assertHeld();
    const message =
      error instanceof Error ? error.message : "Unknown branch-worktree publication failure.";
    branchCreated = branchExists(input.proposal.sourcePath, input.proposal.branchName);
    worktreeCreated = await pathExists(input.proposal.worktreePath);
    let reason: BranchWorktreePublicationFailureReceipt["reason"];
    if (input.recoveryOfDigest !== undefined && /conflict|unapproved|unsafe/u.test(message)) {
      reason = "recovery-conflict";
    } else if (message.includes("exists")) {
      reason = "collision";
    } else if (branchCreated || worktreeCreated) {
      reason = appliedPaths.length === 0 ? "creation-partial" : "apply-partial";
    } else {
      reason = "precondition-failed";
    }
    const failure = failureReceipt({
      appliedPaths,
      branchCreated,
      callId: input.publishedByCallId,
      failureMessage: message,
      proposal: input.proposal,
      reason,
      recoveryOfDigest: input.recoveryOfDigest,
      worktreeCreated,
    });
    await writeJournal(journalPath(input.proposal.publicationIdentityDigest), failure);
    input.lock.assertHeld();
    return failure;
  }
};

const withPublicationLock = async <T>(input: {
  identity: string;
  hooks?: BranchWorktreePublicationFaultHooks;
  operation: (lock: PublicationLock) => Promise<T>;
}): Promise<T> => {
  const lock = await acquirePublicationLock(input.identity);
  try {
    const operation = async () => {
      await input.hooks?.afterLockReady?.(lock.pid);
      lock.assertHeld();
      return input.operation(lock);
    };
    return await Promise.race([operation(), lock.lost]);
  } finally {
    await lock.release();
  }
};

// oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
export const publishReviewedChangeSetToBranchWorktree = async (input: {
  proposal: BranchWorktreePublicationProposal;
  sourceReceipt: SourceReceipt;
  review: ReviewedChangeSetReceipt;
  readOverlayFile: (path: string) => Promise<Uint8Array | null>;
  publishedByCallId: string;
  hooks?: BranchWorktreePublicationFaultHooks;
}): Promise<BranchWorktreePublicationSuccessReceipt | BranchWorktreePublicationFailureReceipt> => {
  if (process.env.APP_BUILDER_BRANCH_WORKTREE_PUBLICATION !== "1")
    throw new Error("Branch-worktree publication is disabled.");
  return withPublicationLock({
    hooks: input.hooks,
    identity: input.proposal.publicationIdentityDigest,
    operation: async (lock) => {
      await assertExactSource(input);
      lock.assertHeld();
      await assertPublicationLayoutSafe();
      lock.assertHeld();
      await assertNoCollision(input.proposal);
      lock.assertHeld();
      const existing = await readBranchWorktreePublicationJournal(input.proposal);
      if (existing !== undefined)
        throw new Error(
          `A durable branch-worktree publication ${existing.status} receipt already exists; use status or explicit recovery.`,
        );
      const pending = pendingReceipt({
        callId: input.publishedByCallId,
        proposal: input.proposal,
      });
      await input.hooks?.beforePendingJournal?.();
      lock.assertHeld();
      await createInitialJournal(journalPath(input.proposal.publicationIdentityDigest), pending);
      lock.assertHeld();
      await input.hooks?.afterPendingJournal?.();
      lock.assertHeld();
      return executePublication({ ...input, lock });
    },
  });
};

// oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
export const recoverBranchWorktreePublication = async (input: {
  proposal: BranchWorktreePublicationProposal;
  sourceReceipt: SourceReceipt;
  review: ReviewedChangeSetReceipt;
  readOverlayFile: (path: string) => Promise<Uint8Array | null>;
  recoveredByCallId: string;
  expectedJournalDigest: string;
  hooks?: BranchWorktreePublicationFaultHooks;
}): Promise<BranchWorktreePublicationSuccessReceipt | BranchWorktreePublicationFailureReceipt> => {
  if (process.env.APP_BUILDER_BRANCH_WORKTREE_PUBLICATION !== "1")
    throw new Error("Branch-worktree publication recovery is disabled.");
  return withPublicationLock({
    hooks: input.hooks,
    identity: input.proposal.publicationIdentityDigest,
    operation: async (lock) => {
      const existing = await readBranchWorktreePublicationJournal(input.proposal);
      lock.assertHeld();
      if (existing === undefined || existing.digest !== input.expectedJournalDigest)
        throw new Error("The recovery journal changed before approval.");
      if (!exactBranchWorktreeProposalMatch(proposalFromBranchJournal(existing), input.proposal))
        throw new Error("The recovery proposal does not match its durable intent.");
      if (existing.status === "succeeded") {
        await verifyBranchWorktreePublication({
          receipt: existing,
          review: input.review,
          sourceReceipt: input.sourceReceipt,
        });
        lock.assertHeld();
        return existing;
      }
      const pending = pendingReceipt({
        callId: input.recoveredByCallId,
        proposal: input.proposal,
        recoveryOfDigest: existing.digest,
      });
      await writeJournal(journalPath(input.proposal.publicationIdentityDigest), pending);
      lock.assertHeld();
      return executePublication({
        hooks: input.hooks,
        lock,
        proposal: input.proposal,
        publishedByCallId: input.recoveredByCallId,
        readOverlayFile: input.readOverlayFile,
        recoveryOfDigest: existing.digest,
        review: input.review,
        sourceReceipt: input.sourceReceipt,
      });
    },
  });
};
