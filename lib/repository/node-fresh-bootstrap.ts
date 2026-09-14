import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { constants as fsConstants, existsSync } from "node:fs";
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import nodePath from "node:path";

import {
  assertCanonicalFreshBootstrapJournal,
  assertExactFreshBootstrapProposal,
  createFreshBootstrapProposal,
  exactFreshBootstrapProposalMatch,
  freshBootstrapJournalDigest,
  proposalFromFreshBootstrapJournal,
} from "./fresh-bootstrap";
import type {
  FreshBootstrapCapability,
  FreshBootstrapFailureReceipt,
  FreshBootstrapFile,
  FreshBootstrapIdentity,
  FreshBootstrapJournal,
  FreshBootstrapLayout,
  FreshBootstrapPendingReceipt,
  FreshBootstrapPrestate,
  FreshBootstrapProposal,
  FreshBootstrapSuccessReceipt,
  ExecutableIdentity,
  PathIdentity,
} from "./fresh-bootstrap";
import {
  assertExactReviewedChangeSet,
  contentDigest,
  pathsOverlap,
  stableDigest,
} from "./local-publication";
import type { ReviewedChangeSetReceipt } from "./reviewed-change-set";
import { inspectSourceReceipt, parseSourceReceipt, SOURCE_RECEIPT_VERSION } from "./source-receipt";
import type { SourceReceipt } from "./source-receipt";
import { safeSourcePath } from "./source-path";
import type { PreparedSourceFile } from "./supported-template";

export interface FreshBootstrapFaultHooks {
  afterLockReady?: (pid: number) => void | Promise<void>;
  afterPendingJournal?: () => void | Promise<void>;
  afterStageCreation?: () => void | Promise<void>;
  afterStageMarker?: () => void | Promise<void>;
  afterMaterializeFile?: (path: string, index: number) => void | Promise<void>;
  beforeGitInit?: () => void | Promise<void>;
  afterGitInit?: () => void | Promise<void>;
  beforeGitAdd?: () => void | Promise<void>;
  afterGitAdd?: () => void | Promise<void>;
  beforeGitCommit?: () => void | Promise<void>;
  afterGitCommit?: () => void | Promise<void>;
  beforeAtomicPublication?: () => void | Promise<void>;
  afterAtomicSwap?: () => void | Promise<void>;
  afterAtomicPublication?: () => void | Promise<void>;
  beforeTerminalJournal?: () => void | Promise<void>;
  preserveNonterminalJournal?: boolean;
}

type ExactFile = FreshBootstrapFile & { bytes: Buffer };

export interface FreshBootstrapSourceWorkspace {
  files: readonly PreparedSourceFile[];
  readSourceFile: (path: string) => Promise<Uint8Array | null>;
  reverify: () => Promise<void>;
}
const atomicPublicationAdapter = String.raw`
import ctypes, os, platform, stat, sys
mode, stage, destination, stage_dev, stage_ino, stage_uid, stage_mode, stage_nlink, empty_dev, empty_ino, empty_uid, empty_mode, empty_nlink, parent_dev, parent_ino, parent_uid, parent_mode, parent_nlink = sys.argv[1:]
parent_fd = 3
libc = ctypes.CDLL(None, use_errno=True)
stage_b = os.fsencode(stage); destination_b = os.fsencode(destination)
parent = os.fstat(parent_fd)
if not stat.S_ISDIR(parent.st_mode) or str(parent.st_dev) != parent_dev or str(parent.st_ino) != parent_ino or str(parent.st_uid) != parent_uid or format(stat.S_IMODE(parent.st_mode), "o") != parent_mode or str(parent.st_nlink) != parent_nlink:
    raise SystemExit(75)
def exact(name, dev, ino, uid, mode, nlink):
    value = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if not stat.S_ISDIR(value.st_mode) or str(value.st_dev) != dev or str(value.st_ino) != ino or str(value.st_uid) != uid or format(stat.S_IMODE(value.st_mode), "o") != mode or str(value.st_nlink) != nlink:
        raise SystemExit(76)
    return value
if mode == "noreplace":
    exact(stage, stage_dev, stage_ino, stage_uid, stage_mode, stage_nlink)
    try: os.stat(destination, dir_fd=parent_fd, follow_symlinks=False); raise SystemExit(77)
    except FileNotFoundError: pass
else:
    exact(stage, stage_dev, stage_ino, stage_uid, stage_mode, stage_nlink)
    exact(destination, empty_dev, empty_ino, empty_uid, empty_mode, empty_nlink)
    old_fd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
    try:
        if os.listdir(old_fd): raise SystemExit(79)
    finally: os.close(old_fd)
system = platform.system()
if system == "Darwin":
    fn = libc.renameatx_np
    fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    flag = 0x00000004 if mode == "noreplace" else 0x00000002
    result = fn(parent_fd, stage_b, parent_fd, destination_b, flag)
elif system == "Linux":
    fn = libc.renameat2
    fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    flag = 1 if mode == "noreplace" else 2
    result = fn(parent_fd, stage_b, parent_fd, destination_b, flag)
else:
    raise SystemExit(78)
if result != 0:
    error = ctypes.get_errno()
    print(f"atomic publication failed: {os.strerror(error)}", file=sys.stderr)
    raise SystemExit(error or 79)
os.fsync(parent_fd)
if mode in ("exchange", "exchange-hold"):
    exact(stage, empty_dev, empty_ino, empty_uid, empty_mode, empty_nlink)
    old_fd = os.open(stage, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
    try:
        if os.listdir(old_fd): raise SystemExit(80)
    finally: os.close(old_fd)
    os.fsync(parent_fd)
`;

export const FRESH_BOOTSTRAP_ATOMIC_ADAPTER_DIGEST = createHash("sha256")
  .update(atomicPublicationAdapter)
  .digest("hex");

const materializeAdapter = String.raw`
import hashlib, os, stat, sys
path, mode, expected_blob, recovery = sys.argv[1:]
parts = nodePath.split("/")
if not parts or any(part in ("", ".", "..") for part in parts): raise SystemExit(70)
root_fd = 3
root = os.fstat(root_fd)
fd = os.dup(root_fd)
try:
    for part in parts[:-1]:
        try: os.mkdir(part, 0o755, dir_fd=fd); os.fsync(fd)
        except FileExistsError: pass
        next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        value = os.fstat(next_fd)
        if not stat.S_ISDIR(value.st_mode) or value.st_uid != os.geteuid() or value.st_dev != root.st_dev or value.st_mode & 0o022:
            raise SystemExit(71)
        os.close(fd); fd = next_fd
    data = sys.stdin.buffer.read()
    header = f"blob {len(data)}\0".encode()
    if hashlib.sha1(header + data).hexdigest() != expected_blob: raise SystemExit(72)
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW
    desired = 0o755 if mode == "100755" else 0o644
    try: target = os.open(parts[-1], flags, desired, dir_fd=fd)
    except FileExistsError:
        if recovery != "1": raise
        target = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
        value = os.fstat(target)
        observed = b""
        while True:
            chunk = os.read(target, 65536)
            if not chunk: break
            observed += chunk
        if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_uid != os.geteuid() or value.st_dev != root.st_dev or value.st_mode & 0o777 != desired or hashlib.sha1(f"blob {len(observed)}\0".encode() + observed).hexdigest() != expected_blob:
            raise SystemExit(73)
        os.close(target); raise SystemExit(0)
    try:
        offset = 0
        while offset < len(data): offset += os.write(target, data[offset:])
        os.fchmod(target, desired); os.fsync(target)
    finally: os.close(target)
    os.fsync(fd)
finally: os.close(fd)
`;

export const FRESH_BOOTSTRAP_MATERIALIZE_ADAPTER_DIGEST = createHash("sha256")
  .update(materializeAdapter)
  .digest("hex");

const minimalEnvironment = (authorIdentity?: FreshBootstrapIdentity): NodeJS.ProcessEnv => ({
  GIT_ASKPASS: "/usr/bin/false",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_NO_LAZY_FETCH: "1",
  GIT_TERMINAL_PROMPT: "0",
  HOME: "/dev/null",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  NODE_ENV: "production",
  PATH: "/usr/bin:/bin",
  SSH_ASKPASS: "/usr/bin/false",
  TMPDIR: "/tmp",
  XDG_CONFIG_HOME: "/dev/null",
  ...(authorIdentity === undefined
    ? {}
    : {
        GIT_AUTHOR_DATE: authorIdentity.commitTimestamp,
        GIT_AUTHOR_EMAIL: authorIdentity.authorEmail,
        GIT_AUTHOR_NAME: authorIdentity.authorName,
        GIT_COMMITTER_DATE: authorIdentity.commitTimestamp,
        GIT_COMMITTER_EMAIL: authorIdentity.authorEmail,
        GIT_COMMITTER_NAME: authorIdentity.authorName,
      }),
});

const gitOptions = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.attributesfile=/dev/null",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "credential.helper=",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.file.allow=never",
] as const;

const exactGitConfig =
  "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n";

const git = (
  capability: FreshBootstrapCapability,
  root: string,
  args: readonly string[],
  commitIdentity?: FreshBootstrapIdentity,
  input?: Uint8Array,
): string =>
  execFileSync(capability.systemGit, [...gitOptions, "-C", root, ...args], {
    encoding: "utf-8",
    env: minimalEnvironment(commitIdentity),
    input,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
  });

const gitBuffer = (
  capability: FreshBootstrapCapability,
  root: string,
  args: readonly string[],
): Buffer =>
  execFileSync(capability.systemGit, [...gitOptions, "-C", root, ...args], {
    encoding: "buffer",
    env: minimalEnvironment(),
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });

const within = (root: string, candidate: string): boolean => {
  const relativePath = nodePath.relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${nodePath.sep}`) &&
      !nodePath.isAbsolute(relativePath))
  );
};

const identity = async (path: string): Promise<PathIdentity> => {
  const canonical = await realpath(path);
  const value = await lstat(canonical);
  return {
    device: String(value.dev),
    inode: String(value.ino),
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    mode: (value.mode & 0o777).toString(8),
    nlink: String(value.nlink),
    path: canonical,
    uid: String(value.uid),
  };
};

const rootIdentity = async (path: string): Promise<PathIdentity> => ({
  ...(await identity(path)),
  nlink: "0",
});

const assertExactIdentity = async (
  expected: PathIdentity,
  kind: "directory" | "file",
): Promise<void> => {
  if (!nodePath.isAbsolute(expected.path) || (await realpath(expected.path)) !== expected.path)
    {throw new Error("The bootstrap capability path is not canonical.");}
  const value = await lstat(expected.path);
  const uid = process.geteuid?.();
  if (
    uid === undefined ||
    value.isSymbolicLink() ||
    (kind === "directory" ? !value.isDirectory() : !value.isFile()) ||
    value.uid !== uid ||
    String(value.uid) !== expected.uid ||
    String(value.dev) !== expected.device ||
    String(value.ino) !== expected.inode ||
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    (value.mode & 0o777).toString(8) !== expected.mode ||
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    (value.mode & 0o777) !== (kind === "directory" ? 0o700 : 0o600) ||
    (kind === "file" && value.nlink !== 1)
  )
    {throw new Error("The bootstrap capability identity changed or is unsafe.");}
};

const executableIdentity = async (path: string): Promise<ExecutableIdentity> => {
  const canonical = await realpath(path);
  const value = await lstat(canonical);
  if (!value.isFile() || value.isSymbolicLink())
    {throw new Error("The bootstrap helper is not a fixed regular file.");}
  return {
    device: String(value.dev),
    inode: String(value.ino),
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    mode: (value.mode & 0o777).toString(8),
    nlink: String(value.nlink),
    path: canonical,
    sha256: createHash("sha256")
      .update(await readFile(canonical))
      .digest("hex"),
    uid: String(value.uid),
  };
};

export const canonicalFreshBootstrapHelperPath = async (path: string): Promise<string> => {
  const canonical = await realpath(path);
  const value = await lstat(canonical);
  if (!value.isFile() || value.isSymbolicLink())
    {throw new Error("The bootstrap helper is not a fixed regular file.");}
  return canonical;
};

const assertExactExecutable = async (expected: ExecutableIdentity): Promise<void> => {
  if (!nodePath.isAbsolute(expected.path))
    {throw new Error("The bootstrap helper path is not absolute.");}
  const current = await executableIdentity(expected.path);
  if (
    current.path !== expected.path ||
    current.device !== expected.device ||
    current.inode !== expected.inode ||
    current.uid !== expected.uid ||
    current.mode !== expected.mode ||
    current.nlink !== expected.nlink ||
    current.sha256 !== expected.sha256
  )
    {throw new Error("The bootstrap helper identity changed after approval.");}
};

const assertCapability = async (
  capability: FreshBootstrapCapability | undefined,
): Promise<FreshBootstrapCapability> => {
  if (capability === undefined)
    {throw new Error("Fresh local bootstrap production capability is not configured.");}
  if (
    capability.kind !== "fresh-bootstrap-local-v1" ||
    (capability.authority !== "configured-production" &&
      capability.authority !== "structural-test-injection") ||
    !existsSync(capability.systemGit) ||
    !existsSync(capability.systemPython) ||
    !existsSync(capability.systemNode) ||
    !existsSync(capability.lockHelper) ||
    (capability.lockStrategy !== "flock" && capability.lockStrategy !== "lockf")
  )
    {throw new Error("The fresh-bootstrap capability is invalid.");}
  await Promise.all([
    assertExactIdentity(capability.stateRoot, "directory"),
    assertExactIdentity(capability.allowedRoot, "directory"),
    assertExactExecutable(capability.systemGitIdentity),
    assertExactExecutable(capability.systemPythonIdentity),
    assertExactExecutable(capability.systemNodeIdentity),
    assertExactExecutable(capability.lockHelperIdentity),
  ]);
  if (
    capability.systemGitIdentity.path !== capability.systemGit ||
    capability.systemPythonIdentity.path !== capability.systemPython ||
    capability.systemNodeIdentity.path !== capability.systemNode ||
    capability.lockHelperIdentity.path !== capability.lockHelper
  )
    {throw new Error("Bootstrap helper paths must be canonical and exact.");}
  if (pathsOverlap(capability.stateRoot.path, capability.allowedRoot.path))
    {throw new Error("Bootstrap state and destination roots must be disjoint.");}
  return capability;
};

export const productionFreshBootstrapCapability = async (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<FreshBootstrapCapability> => {
  if (environment.APP_BUILDER_FRESH_BOOTSTRAP_ENABLED !== "1")
    {throw new Error("Fresh local bootstrap is disabled on this host.");}
  const stateRootPath = environment.APP_BUILDER_FRESH_BOOTSTRAP_STATE_ROOT;
  const allowedRootPath = environment.APP_BUILDER_FRESH_BOOTSTRAP_ALLOWED_ROOT;
  if (
    stateRootPath === undefined ||
    allowedRootPath === undefined ||
    !nodePath.isAbsolute(stateRootPath) ||
    !nodePath.isAbsolute(allowedRootPath)
  )
    {throw new Error("Fresh local bootstrap roots are not configured.");}
  const selectedSystemGit = ["/usr/bin/git", "/bin/git"].find(existsSync);
  const selectedSystemPython = ["/usr/bin/python3", "/bin/python3"].find(existsSync);
  const selectedLock = existsSync("/usr/bin/flock")
    ? ({ path: "/usr/bin/flock", strategy: "flock" } as const)
    : undefined;
  const configuredLock =
    selectedLock ??
    (existsSync("/usr/bin/lockf")
      ? ({ path: "/usr/bin/lockf", strategy: "lockf" } as const)
      : undefined);
  if (
    selectedSystemGit === undefined ||
    selectedSystemPython === undefined ||
    configuredLock === undefined
  )
    {throw new Error("Fixed fresh-bootstrap helper executables are unavailable.");}
  const [systemGit, systemPython, systemNode, lockHelper] = await Promise.all([
    canonicalFreshBootstrapHelperPath(selectedSystemGit),
    canonicalFreshBootstrapHelperPath(selectedSystemPython),
    canonicalFreshBootstrapHelperPath(process.execPath),
    canonicalFreshBootstrapHelperPath(configuredLock.path),
  ]);
  const capability: FreshBootstrapCapability = {
    allowedRoot: await rootIdentity(nodePath.resolve(allowedRootPath)),
    authority: "configured-production",
    kind: "fresh-bootstrap-local-v1",
    lockHelper,
    lockHelperIdentity: await executableIdentity(lockHelper),
    lockStrategy: configuredLock.strategy,
    stateRoot: await rootIdentity(nodePath.resolve(stateRootPath)),
    systemGit,
    systemGitIdentity: await executableIdentity(systemGit),
    systemNode,
    systemNodeIdentity: await executableIdentity(systemNode),
    systemPython,
    systemPythonIdentity: await executableIdentity(systemPython),
  };
  return assertCapability(capability);
};

const syncDirectory = async (path: string): Promise<void> => {
  // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const state = await handle.stat();
    if (!state.isDirectory()) {throw new Error("The durable bootstrap path is not a directory.");}
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const assertContainedStatePath = async (
  capability: FreshBootstrapCapability,
  candidate: string,
  leaf: "absent-or-file" | "absent-or-directory" | "directory",
): Promise<void> => {
  await assertExactIdentity(capability.stateRoot, "directory");
  if (!within(capability.stateRoot.path, candidate) || candidate === capability.stateRoot.path)
    {throw new Error("The bootstrap state path escapes its owner-only root.");}
  const segments = nodePath.relative(capability.stateRoot.path, candidate).split(nodePath.sep);
  let cursor = capability.stateRoot.path;
  for (let index = 0; index < segments.length; index += 1) {
    cursor = nodePath.resolve(cursor, segments[index]);
    let value;
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      value = await lstat(cursor);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && leaf !== "directory") {return;}
      throw error;
    }
    const isLeaf = index === segments.length - 1;
    if (
      value.isSymbolicLink() ||
      value.uid !== process.geteuid?.() ||
      value.dev.toString() !== capability.stateRoot.device ||
      (!isLeaf && !value.isDirectory()) ||
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
      (value.isDirectory() && (value.mode & 0o777) !== 0o700) ||
      (isLeaf && leaf === "directory" && !value.isDirectory()) ||
      (isLeaf &&
        leaf === "absent-or-file" &&
        // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
        (!value.isFile() || (value.mode & 0o777) !== 0o600 || value.nlink !== 1)) ||
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      (await realpath(cursor)) !== cursor
    )
      {throw new Error("The bootstrap state path is unsafe.");}
  }
};

const durableDirectory = async (
  capability: FreshBootstrapCapability,
  path: string,
): Promise<void> => {
  await assertContainedStatePath(capability, path, "absent-or-directory");
  await mkdir(path, { mode: 0o700, recursive: true });
  await chmod(path, 0o700);
  await assertContainedStatePath(capability, path, "directory");
  await syncDirectory(path);
  await syncDirectory(nodePath.dirname(path));
};

const atomicWrite = async (
  capability: FreshBootstrapCapability,
  path: string,
  value: string,
): Promise<void> => {
  await durableDirectory(capability, nodePath.dirname(path));
  await assertContainedStatePath(capability, path, "absent-or-file");
  const temporary = `${path}.${randomUUID()}.tmp`;
  await assertContainedStatePath(capability, temporary, "absent-or-file");
  const handle = await open(
    temporary,
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.uid !== process.geteuid?.() ||
      String(opened.dev) !== capability.stateRoot.device ||
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
      (opened.mode & 0o777) !== 0o600 ||
      opened.nlink !== 1
    )
      {throw new Error("The durable state temporary file is unsafe.");}
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await assertContainedStatePath(capability, path, "absent-or-file");
  await rename(temporary, path);
  await syncDirectory(nodePath.dirname(path));
};

const createInitialJournal = async (
  capability: FreshBootstrapCapability,
  path: string,
  receipt: FreshBootstrapPendingReceipt,
): Promise<void> => {
  await durableDirectory(capability, nodePath.dirname(path));
  await assertContainedStatePath(capability, path, "absent-or-file");
  const candidate = `${path}.${randomUUID()}.pending`;
  const handle = await open(
    candidate,
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.uid !== process.geteuid?.() ||
      String(opened.dev) !== capability.stateRoot.device ||
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
      (opened.mode & 0o777) !== 0o600 ||
      opened.nlink !== 1
    )
      {throw new Error("The initial journal temporary file is unsafe.");}
    await handle.writeFile(`${JSON.stringify(receipt)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(candidate, path);
    await syncDirectory(nodePath.dirname(path));
  } finally {
    await unlink(candidate).catch(() => {
      // Cleanup errors are intentionally ignored.
    });
    await syncDirectory(nodePath.dirname(path));
  }
};

const lockHolder = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");
const [path, dev, ino, uid, mode, lease, expectedPriorDigest] = process.argv.slice(1);
const fd = fs.openSync(path, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
const s = fs.fstatSync(fd);
if (!s.isFile() || s.nlink !== 1 || String(s.dev) !== dev || String(s.ino) !== ino || String(s.uid) !== uid || String(s.mode & 0o777) !== mode) process.exit(74);
const priorBytes = Buffer.alloc(s.size); fs.readSync(fd, priorBytes, 0, priorBytes.length, 0);
const prior = priorBytes.toString("utf-8");
if (prior.startsWith("APP_BUILDER_FRESH_BOOTSTRAP_LEASE_ACTIVE_V1:")) process.exit(73);
if (prior.startsWith("APP_BUILDER_FRESH_BOOTSTRAP_LEASE_QUIESCED_V1:")) {
  const digest = crypto.createHash("sha256").update(prior).digest("hex");
  if (expectedPriorDigest === "-" || digest !== expectedPriorDigest) process.exit(73);
} else if (prior !== "") process.exit(72);
fs.ftruncateSync(fd, 0); const leaseBytes = Buffer.from(lease); let offset = 0;
while (offset < leaseBytes.length) offset += fs.writeSync(fd, leaseBytes, offset, leaseBytes.length - offset, offset);
fs.fsyncSync(fd);
const check = Buffer.alloc(leaseBytes.length); fs.readSync(fd, check, 0, check.length, 0);
if (check.toString("utf-8") !== lease) process.exit(75);
process.stdout.write("READY\n");
let command = ""; process.stdin.setEncoding("utf-8");
process.stdin.on("data", chunk => command += chunk);
process.stdin.on("end", () => { if (command === "RELEASE\n") { fs.ftruncateSync(fd, 0); fs.fsyncSync(fd); } fs.closeSync(fd); });
process.stdin.resume();
`;

interface Lease {
  pid: number;
  markerDigest: string;
  assertHeld: () => void;
  release: () => Promise<void>;
}

const acquireLease = async (
  capability: FreshBootstrapCapability,
  path: string,
  expectedPriorDigest?: string,
): Promise<Lease> => {
  await durableDirectory(capability, nodePath.dirname(path));
  await assertContainedStatePath(capability, path, "absent-or-file");
  try {
    const handle = await open(
      path,
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.uid !== process.geteuid?.() ||
        String(opened.dev) !== capability.stateRoot.device ||
        // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
        (opened.mode & 0o777) !== 0o600 ||
        opened.nlink !== 1
      )
        {throw new Error("The fresh-bootstrap lease file is unsafe.");}
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(nodePath.dirname(path));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {throw error;}
  }
  await assertContainedStatePath(capability, path, "absent-or-file");
  const state = await lstat(path);
  await assertExactExecutable(capability.lockHelperIdentity);
  await assertExactExecutable(capability.systemNodeIdentity);
  const helper =
    capability.lockStrategy === "flock"
      ? { args: ["-n", path], command: capability.lockHelper }
      : { args: ["-k", "-t", "0", path], command: capability.lockHelper };
  const marker = `APP_BUILDER_FRESH_BOOTSTRAP_LEASE_ACTIVE_V1:${process.pid}:${randomUUID()}\n`;
  const holder = spawn(
    helper.command,
    [
      ...helper.args,
      capability.systemNode,
      "-e",
      lockHolder,
      path,
      String(state.dev),
      String(state.ino),
      String(state.uid),
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
      String(state.mode & 0o777),
      marker,
      expectedPriorDigest ?? "-",
    ],
    { env: minimalEnvironment(), stdio: ["pipe", "pipe", "pipe"] },
  );
  if (holder.pid === undefined) {throw new Error("The lease helper did not start.");}
  let terminal: Error | undefined;
  let releasing = false;
  let helperError = "";
  holder.stderr.setEncoding("utf-8");
  holder.stderr.on("data", (chunk: string) => {
    helperError = `${helperError}${chunk}`.slice(-2000);
  });
  const { promise: exited, resolve: resolveExit } = Promise.withResolvers<undefined>();
  holder.once("error", (error) => {
    terminal = error;
    resolveExit(undefined as undefined);
  });
  holder.once("exit", (code, signal) => {
    if (terminal === undefined && (!releasing || code !== 0 || signal !== null))
      {terminal = new Error(
        `The fresh-bootstrap lease was lost (code ${String(code)}, signal ${String(signal)})${helperError.trim() === "" ? "." : `: ${helperError.trim()}`}`,
      );}
    resolveExit(undefined as undefined);
  });
  const { promise: ready, reject, resolve } = Promise.withResolvers<undefined>();
  const timeout = setTimeout(() => {
    holder.kill("SIGKILL");
    reject(new Error("Lease timeout."));
  }, 5000);
  holder.stdout.setEncoding("utf-8");
  holder.stdout.once("data", (chunk: string) => {
    clearTimeout(timeout);
    if (chunk === "READY\n") {resolve(undefined as undefined);}
    else {reject(new Error("Lease handshake failed."));}
  });
  const monitorExit = async () => {
    await exited;
    clearTimeout(timeout);
    reject(terminal ?? new Error("Fresh bootstrap is already leased."));
  };
  monitorExit();
  await ready;
  let released = false;
  return {
    assertHeld: () => {
      if (!releasing && (holder.exitCode !== null || holder.signalCode !== null))
        {terminal ??= new Error("The fresh-bootstrap lease was lost.");}
      if (terminal !== undefined) {throw terminal;}
    },
    markerDigest: createHash("sha256").update(marker).digest("hex"),
    pid: holder.pid,
    release: async () => {
      if (released) {return;}
      released = true;
      releasing = true;
      if (terminal === undefined) {holder.stdin.end("RELEASE\n");}
      await exited;
      if (terminal !== undefined) {throw terminal;}
    },
  };
};

const quiesceHolder = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");
const [path, dev, ino, uid, mode, expectedActiveDigest, quiesced] = process.argv.slice(1);
const fd = fs.openSync(path, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
const s = fs.fstatSync(fd);
if (!s.isFile() || s.nlink !== 1 || String(s.dev) !== dev || String(s.ino) !== ino || String(s.uid) !== uid || String(s.mode & 0o777) !== mode) process.exit(74);
const priorBytes = Buffer.alloc(s.size); fs.readSync(fd, priorBytes, 0, priorBytes.length, 0);
const prior = priorBytes.toString("utf-8");
if (!prior.startsWith("APP_BUILDER_FRESH_BOOTSTRAP_LEASE_ACTIVE_V1:") || crypto.createHash("sha256").update(prior).digest("hex") !== expectedActiveDigest) process.exit(73);
fs.ftruncateSync(fd, 0); const bytes = Buffer.from(quiesced); let offset = 0;
while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
fs.fsyncSync(fd);
const check = Buffer.alloc(bytes.length); fs.readSync(fd, check, 0, check.length, 0);
if (check.toString("utf-8") !== quiesced) process.exit(75);
process.stdout.write("READY\n");
process.stdin.resume(); process.stdin.on("end", () => fs.closeSync(fd));
`;

const quiesceAbandonedLease = async (
  capability: FreshBootstrapCapability,
  path: string,
  expectedActiveDigest: string,
): Promise<{ markerDigest: string; release: () => Promise<void> }> => {
  await assertContainedStatePath(capability, path, "absent-or-file");
  const state = await lstat(path);
  await assertExactExecutable(capability.lockHelperIdentity);
  await assertExactExecutable(capability.systemNodeIdentity);
  const helper =
    capability.lockStrategy === "flock"
      ? { args: ["-n", path], command: capability.lockHelper }
      : { args: ["-k", "-t", "0", path], command: capability.lockHelper };
  const marker = `APP_BUILDER_FRESH_BOOTSTRAP_LEASE_QUIESCED_V1:${expectedActiveDigest}:${randomUUID()}\n`;
  const holder = spawn(
    helper.command,
    [
      ...helper.args,
      capability.systemNode,
      "-e",
      quiesceHolder,
      path,
      String(state.dev),
      String(state.ino),
      String(state.uid),
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
      String(state.mode & 0o777),
      expectedActiveDigest,
      marker,
    ],
    { env: minimalEnvironment(), stdio: ["pipe", "pipe", "pipe"] },
  );
  if (holder.pid === undefined) {throw new Error("The quiescence helper did not start.");}
  let stderr = "";
  holder.stderr.setEncoding("utf-8");
  holder.stderr.on("data", (chunk: string) => (stderr += chunk));
  const { promise: exited, resolve: resolveExit } = Promise.withResolvers<undefined>();
  holder.once("exit", () => resolveExit(undefined as undefined));
  const { promise: ready, reject, resolve } = Promise.withResolvers<undefined>();
  const timeout = setTimeout(() => {
    holder.kill("SIGKILL");
    reject(new Error("Lease quiescence timeout."));
  }, 5000);
  holder.stdout.setEncoding("utf-8");
  holder.stdout.once("data", (chunk: string) => {
    clearTimeout(timeout);
    if (chunk === "READY\n") {resolve(undefined as undefined);}
    else {reject(new Error("Lease quiescence handshake failed."));}
  });
  const monitorExit = async () => {
    await exited;
    clearTimeout(timeout);
    reject(
      new Error(`Lease quiescence failed${stderr.trim() === "" ? "." : `: ${stderr.trim()}`}`),
    );
  };
  monitorExit();
  await ready;
  let released = false;
  return {
    markerDigest: createHash("sha256").update(marker).digest("hex"),
    release: async () => {
      if (released) {return;}
      released = true;
      holder.stdin.end();
      await exited;
      if (holder.exitCode !== 0) {throw new Error("The quiescence helper exited abnormally.");}
    },
  };
};

const blobId = (bytes: Uint8Array) =>
  createHash("sha1")
    .update(Buffer.from(`blob ${bytes.byteLength}\0`))
    .update(bytes)
    .digest("hex");

const exactSourceTree = (
  capability: FreshBootstrapCapability,
  sourcePath: string,
  sourceSha: string,
): ExactFile[] => {
  const output = gitBuffer(capability, sourcePath, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    sourceSha,
  ]);
  const files: ExactFile[] = [];
  for (const record of output.toString("utf-8").split("\0").filter(Boolean)) {
    const match =
      /^(?<mode>100644|100755|120000|160000) (?<type>blob|commit) (?<objectId>[0-9a-f]{40})\t(?<path>.+)$/u.exec(
        record,
      );
    if (
      match === null ||
      match[1] === "120000" ||
      match[1] === "160000" ||
      match[2] !== "blob" ||
      !safeSourcePath(match[4]) ||
      match[4]
        .split("/")
        .some((part) => [".git", ".repository-bootstrap-claim"].includes(part.toLowerCase()))
    )
      {throw new Error(
        "Fresh bootstrap rejects submodules, symlinks, reserved names, and unsafe paths.",
      );}
    const bytes = gitBuffer(capability, sourcePath, ["cat-file", "blob", match[3]]);
    files.push({
      blob: match[3],
      bytes,
      mode: match[1] as FreshBootstrapFile["mode"],
      path: match[4],
    });
  }
  return files.toSorted((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
};

const exactPreparedSourceTree = async (
  sourceWorkspace: FreshBootstrapSourceWorkspace,
): Promise<ExactFile[]> => {
  await sourceWorkspace.reverify();
  const paths = new Set<string>();
  const files: ExactFile[] = [];
  for (const file of sourceWorkspace.files) {
    if (
      !["100644", "100755"].includes(file.mode) ||
      !/^[0-9a-f]{40}$/u.test(file.objectId) ||
      !/^[0-9a-f]{64}$/u.test(file.sha256) ||
      !safeSourcePath(file.path) ||
      paths.has(file.path) ||
      file.path
        .split("/")
        .some((part) => [".git", ".repository-bootstrap-claim"].includes(part.toLowerCase()))
    )
      {throw new Error("The prepared fresh-template manifest is invalid.");}
    paths.add(file.path);
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    const bytes = await sourceWorkspace.readSourceFile(file.path);
    if (bytes === null || contentDigest(bytes) !== file.sha256 || blobId(bytes) !== file.objectId)
      {throw new Error(`The prepared fresh-template source drifted at ${file.path}.`);}
    files.push({
      blob: file.objectId,
      bytes: Buffer.from(bytes),
      mode: file.mode,
      path: file.path,
    });
  }
  if (files.length === 0) {throw new Error("The prepared fresh-template source is empty.");}
  await sourceWorkspace.reverify();
  return files.toSorted((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
};

const exactResultTree = async (input: {
  capability: FreshBootstrapCapability;
  sourceReceipt: SourceReceipt;
  review: ReviewedChangeSetReceipt;
  readOverlayFile: (path: string) => Promise<Uint8Array | null>;
  sourceWorkspace?: FreshBootstrapSourceWorkspace;
}): Promise<ExactFile[]> => {
  assertExactReviewedChangeSet(input.review);
  const receipt = parseSourceReceipt(input.sourceReceipt);
  if (
    input.review.sourceReceiptDigest !== receipt.digest ||
    input.review.sourceSha !== receipt.sourceSha ||
    input.review.sourceTree !== receipt.sourceTree ||
    input.review.eligibilityDigest !== receipt.eligibilityDigest ||
    input.review.repositoryContractDigest !== receipt.contractDigest
  )
    {throw new Error("The reviewed change set no longer matches its source receipt.");}
  if (receipt.version !== SOURCE_RECEIPT_VERSION) {
    const current = await inspectSourceReceipt(receipt.sourceKind, receipt.sourcePath);
    if (current.digest !== receipt.digest)
      {throw new Error("The fresh-template source changed after review.");}
  } else if (input.sourceWorkspace === undefined) {
    throw new Error("The canonical fresh-template workspace is required for bootstrap.");
  }
  let sourceFiles: readonly ExactFile[];
  if (receipt.version === SOURCE_RECEIPT_VERSION) {
    const { sourceWorkspace } = input;
    if (sourceWorkspace === undefined)
      {throw new Error("The canonical fresh-template workspace is required for bootstrap.");}
    sourceFiles = await exactPreparedSourceTree(sourceWorkspace);
  } else {
    sourceFiles = exactSourceTree(input.capability, receipt.sourcePath, receipt.sourceSha);
  }
  const files = new Map(sourceFiles.map((file) => [file.path, file]));
  for (const change of input.review.changes) {
    if (
      change.path
        .split("/")
        .some((part) => [".git", ".repository-bootstrap-claim"].includes(part.toLowerCase()))
    )
      {throw new Error("The reviewed bootstrap change uses a reserved nodePath.");}
    const before = files.get(change.path);
    if (
      change.before === undefined
        ? before !== undefined
        : before === undefined ||
          before.mode !== `100${change.before.mode}` ||
          contentDigest(before.bytes) !== change.before.digest
    )
      {throw new Error(`The reviewed bootstrap preimage is stale at ${change.path}.`);}
    if (change.after === undefined) {
      files.delete(change.path);
      continue;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    const bytes = await input.readOverlayFile(change.path);
    if (bytes === null || contentDigest(bytes) !== change.after.digest)
      {throw new Error(`The reviewed bootstrap overlay is stale at ${change.path}.`);}
    const buffer = Buffer.from(bytes);
    files.set(change.path, {
      blob: blobId(buffer),
      bytes: buffer,
      mode: `100${change.after.mode}` as FreshBootstrapFile["mode"],
      path: change.path,
    });
  }
  return [...files.values()].toSorted((left, right) =>
    Buffer.from(left.path).compare(Buffer.from(right.path)),
  );
};

const assertNoLinkRoute = async (root: PathIdentity, destination: string): Promise<void> => {
  if (!within(root.path, destination) || destination === root.path)
    {throw new Error("The bootstrap destination is outside its allowed root.");}
  let cursor = root.path;
  for (const part of nodePath
    .relative(root.path, nodePath.dirname(destination))
    .split(nodePath.sep)) {
    if (part === "") {continue;}
    cursor = nodePath.resolve(cursor, part);
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    const value = await lstat(cursor);
    if (
      value.isSymbolicLink() ||
      !value.isDirectory() ||
      value.uid !== process.geteuid?.() ||
      value.dev.toString() !== root.device ||
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
      (value.mode & 0o022) !== 0 ||
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      (await realpath(cursor)) !== cursor
    )
      {throw new Error("The bootstrap destination traverses an unsafe nodePath.");}
  }
};

const inspectDestinationPrestate = async (input: {
  capability: FreshBootstrapCapability;
  destinationPath: string;
  expected: "absent" | "empty-directory";
  protectedPaths: readonly string[];
}): Promise<FreshBootstrapPrestate> => {
  if (!nodePath.isAbsolute(input.destinationPath))
    {throw new Error("The fresh-bootstrap destination must be absolute.");}
  const destination = nodePath.resolve(input.destinationPath);
  await assertNoLinkRoute(input.capability.allowedRoot, destination);
  const parent = await identity(nodePath.dirname(destination));
  if (
    parent.device !== input.capability.allowedRoot.device ||
    input.protectedPaths.some((path) => pathsOverlap(destination, path)) ||
    pathsOverlap(destination, input.capability.stateRoot.path)
  )
    {throw new Error("The bootstrap destination overlaps protected state.");}
  let value;
  try {
    value = await lstat(destination);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {throw error;}
    if (input.expected !== "absent")
      {throw new Error("The expected empty destination is absent.", {
        cause: error,
      });}
    return { destinationPath: destination, kind: "absent", parent };
  }
  if (
    input.expected !== "empty-directory" ||
    value.isSymbolicLink() ||
    !value.isDirectory() ||
    value.uid !== process.geteuid?.() ||
    value.dev.toString() !== input.capability.allowedRoot.device ||
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    (value.mode & 0o777) !== 0o700 ||
    (await realpath(destination)) !== destination
  )
    {throw new Error("The fresh-bootstrap destination is not exact-empty.");}
  const entries = await readdir(destination);
  if (entries.length !== 0) {throw new Error("The fresh-bootstrap destination is not exact-empty.");}
  return {
    destination: await identity(destination),
    kind: "empty-directory",
    parent,
  };
};

const manifest = (files: readonly ExactFile[]): FreshBootstrapFile[] =>
  files.map(({ path, mode, blob }) => ({ blob, mode, path }));

const pathState = async (path: string): Promise<"absent" | "directory" | "other"> => {
  try {
    const value = await lstat(path);
    return value.isDirectory() && !value.isSymbolicLink() ? "directory" : "other";
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {return "absent";}
    throw error;
  }
};

export const deriveFreshBootstrapProposal = async (input: {
  capability?: FreshBootstrapCapability;
  destinationPath: string;
  expectedPrestate: "absent" | "empty-directory";
  repositoryIdentity: FreshBootstrapIdentity;
  sourceReceipt: SourceReceipt;
  review: ReviewedChangeSetReceipt;
  protectedPaths: readonly string[];
  readOverlayFile: (path: string) => Promise<Uint8Array | null>;
  sourceWorkspace?: FreshBootstrapSourceWorkspace;
}): Promise<FreshBootstrapProposal> => {
  const capability = await assertCapability(input.capability);
  const sourceReceipt = parseSourceReceipt(input.sourceReceipt);
  const sourceGit =
    sourceReceipt.version === SOURCE_RECEIPT_VERSION
      ? undefined
      : await realpath(
          git(capability, sourceReceipt.sourcePath, [
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ]).trim(),
        );
  const protectedPaths = [
    ...input.protectedPaths,
    sourceReceipt.sourcePath,
    ...(sourceGit === undefined ? [] : [sourceGit]),
    process.cwd(),
  ].map((path) => nodePath.resolve(path));
  if (
    protectedPaths.some(
      (path) =>
        pathsOverlap(capability.stateRoot.path, path) ||
        pathsOverlap(capability.allowedRoot.path, path),
    )
  )
    {throw new Error("Bootstrap state and destination roots overlap builder or source authority.");}
  const destinationPrestate = await inspectDestinationPrestate({
    capability,
    destinationPath: input.destinationPath,
    expected: input.expectedPrestate,
    protectedPaths,
  });
  const files = await exactResultTree({
    capability,
    readOverlayFile: input.readOverlayFile,
    review: input.review,
    sourceReceipt: input.sourceReceipt,
    sourceWorkspace: input.sourceWorkspace,
  });
  const placeholder = nodePath.resolve(capability.stateRoot.path, "pending");
  const destinationLockDigest = stableDigest({
    allowedRoot: capability.allowedRoot,
    destinationPath: nodePath.resolve(input.destinationPath),
  });
  const preliminary = createFreshBootstrapProposal({
    atomicAdapterDigest: FRESH_BOOTSTRAP_ATOMIC_ADAPTER_DIGEST,
    capability,
    destinationPath: nodePath.resolve(input.destinationPath),
    destinationPrestate,
    exactTree: manifest(files),
    journalPath: placeholder,
    lockPath: nodePath.resolve(capability.stateRoot.path, "locks", `${destinationLockDigest}.lock`),
    materializeAdapterDigest: FRESH_BOOTSTRAP_MATERIALIZE_ADAPTER_DIGEST,
    repositoryIdentity: input.repositoryIdentity,
    review: input.review,
    sourceReceipt: input.sourceReceipt,
    stagingPath: nodePath.resolve(nodePath.dirname(input.destinationPath), ".pending.stage"),
  });
  const proposal = createFreshBootstrapProposal({
    atomicAdapterDigest: FRESH_BOOTSTRAP_ATOMIC_ADAPTER_DIGEST,
    capability,
    destinationPath: nodePath.resolve(input.destinationPath),
    destinationPrestate,
    exactTree: manifest(files),
    journalPath: nodePath.resolve(
      capability.stateRoot.path,
      "journals",
      `${preliminary.publicationIdentityDigest}.json`,
    ),
    lockPath: nodePath.resolve(capability.stateRoot.path, "locks", `${destinationLockDigest}.lock`),
    materializeAdapterDigest: FRESH_BOOTSTRAP_MATERIALIZE_ADAPTER_DIGEST,
    repositoryIdentity: input.repositoryIdentity,
    review: input.review,
    sourceReceipt: input.sourceReceipt,
    stagingPath: nodePath.resolve(
      nodePath.dirname(input.destinationPath),
      `.${nodePath.basename(input.destinationPath)}.repository-bootstrap-${preliminary.publicationIdentityDigest}.stage`,
    ),
  });
  if ((await pathState(proposal.stagingPath)) !== "absent")
    {throw new Error("The deterministic bootstrap stage is not absent.");}
  return proposal;
};

const assertExactInputs = async (input: {
  capability: FreshBootstrapCapability;
  proposal: FreshBootstrapProposal;
  sourceReceipt: SourceReceipt;
  review: ReviewedChangeSetReceipt;
  readOverlayFile: (path: string) => Promise<Uint8Array | null>;
  sourceWorkspace?: FreshBootstrapSourceWorkspace;
}): Promise<ExactFile[]> => {
  assertExactFreshBootstrapProposal(input.proposal);
  if (
    input.proposal.atomicAdapterDigest !== FRESH_BOOTSTRAP_ATOMIC_ADAPTER_DIGEST ||
    input.proposal.materializeAdapterDigest !== FRESH_BOOTSTRAP_MATERIALIZE_ADAPTER_DIGEST ||
    input.proposal.sourceReceiptDigest !== input.sourceReceipt.digest ||
    input.proposal.sourceSha !== input.sourceReceipt.sourceSha ||
    input.proposal.sourceTree !== input.sourceReceipt.sourceTree ||
    input.proposal.reviewDigest !== input.review.digest ||
    input.proposal.changeSetDigest !== input.review.changeSetDigest ||
    input.proposal.appSpecDigest !== input.review.appSpecDigest ||
    input.proposal.appSpecPath !== input.review.appSpecPath ||
    input.proposal.applyDigest !== input.review.applyDigest ||
    input.proposal.validationDigest !== input.review.validationDigest ||
    JSON.stringify(input.proposal.capability) !==
      JSON.stringify({
        allowedRoot: input.capability.allowedRoot,
        lockHelper: input.capability.lockHelper,
        lockHelperIdentity: input.capability.lockHelperIdentity,
        lockStrategy: input.capability.lockStrategy,
        stateRoot: input.capability.stateRoot,
        systemGit: input.capability.systemGit,
        systemGitIdentity: input.capability.systemGitIdentity,
        systemNode: input.capability.systemNode,
        systemNodeIdentity: input.capability.systemNodeIdentity,
        systemPython: input.capability.systemPython,
        systemPythonIdentity: input.capability.systemPythonIdentity,
      })
  )
    {throw new Error("The exact fresh-bootstrap inputs changed after approval.");}
  const files = await exactResultTree({
    capability: input.capability,
    readOverlayFile: input.readOverlayFile,
    review: input.review,
    sourceReceipt: input.sourceReceipt,
    sourceWorkspace: input.sourceWorkspace,
  });
  if (stableDigest(manifest(files)) !== input.proposal.exactTreeDigest)
    {throw new Error("The exact bootstrap tree changed after approval.");}
  return files;
};

const assertSourceUnchanged = async (
  sourceReceipt: SourceReceipt,
  sourceWorkspace?: FreshBootstrapSourceWorkspace,
): Promise<void> => {
  const receipt = parseSourceReceipt(sourceReceipt);
  if (receipt.version === SOURCE_RECEIPT_VERSION) {
    if (sourceWorkspace === undefined)
      {throw new Error("The canonical fresh-template workspace is required for bootstrap.");}
    await sourceWorkspace.reverify();
    return;
  }
  const current = await inspectSourceReceipt(receipt.sourceKind, receipt.sourcePath);
  if (current.digest !== receipt.digest)
    {throw new Error("The fresh-template source changed across bootstrap mutation.");}
};

const assertPrestate = async (
  capability: FreshBootstrapCapability,
  proposal: FreshBootstrapProposal,
): Promise<void> => {
  await assertExactIdentity(capability.allowedRoot, "directory");
  await assertNoLinkRoute(capability.allowedRoot, proposal.destinationPath);
  const parent = await identity(nodePath.dirname(proposal.destinationPath));
  if (JSON.stringify(parent) !== JSON.stringify(proposal.destinationPrestate.parent))
    {throw new Error("The destination parent changed after approval.");}
  let destination;
  try {
    destination = await lstat(proposal.destinationPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {throw error;}
    if (proposal.destinationPrestate.kind !== "absent")
      {throw new Error("The approved empty destination disappeared.", {
        cause: error,
      });}
    return;
  }
  if (proposal.destinationPrestate.kind !== "empty-directory")
    {throw new Error("The approved absent destination now exists.");}
  if (
    destination.isSymbolicLink() ||
    !destination.isDirectory() ||
    (await realpath(proposal.destinationPath)) !== proposal.destinationPath ||
    JSON.stringify(await identity(proposal.destinationPath)) !==
      JSON.stringify(proposal.destinationPrestate.destination)
  )
    {throw new Error("The approved empty destination changed.");}
  const entries = await readdir(proposal.destinationPath);
  if (entries.length !== 0) {throw new Error("The approved empty destination changed.");}
};

// oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
const markerContent = async (proposal: FreshBootstrapProposal): Promise<Buffer> =>
  Buffer.from(`APP_BUILDER_REPOSITORY_BOOTSTRAP_CLAIM_V1:${proposal.digest}\n`);

const createStage = async (
  capability: FreshBootstrapCapability,
  proposal: FreshBootstrapProposal,
): Promise<void> => {
  await assertNoLinkRoute(capability.allowedRoot, proposal.stagingPath);
  try {
    await mkdir(proposal.stagingPath, { mode: 0o700 });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      {throw new Error("The deterministic bootstrap stage already exists.", {
        cause: error,
      });}
    throw error;
  }
  const stageState = await lstat(proposal.stagingPath);
  if (
    !stageState.isDirectory() ||
    stageState.isSymbolicLink() ||
    stageState.uid !== process.geteuid?.() ||
    String(stageState.dev) !== capability.allowedRoot.device ||
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    (stageState.mode & 0o777) !== 0o700
  )
    {throw new Error("The newly created bootstrap stage is unsafe.");}
  const marker = nodePath.resolve(proposal.stagingPath, proposal.claimMarkerName);
  const handle = await open(
    marker,
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    const markerState = await handle.stat();
    if (
      !markerState.isFile() ||
      markerState.uid !== process.geteuid?.() ||
      markerState.dev !== stageState.dev ||
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
      (markerState.mode & 0o777) !== 0o600 ||
      markerState.nlink !== 1
    )
      {throw new Error("The bootstrap stage marker is unsafe.");}
    await handle.writeFile(await markerContent(proposal));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(proposal.stagingPath);
  await syncDirectory(nodePath.dirname(proposal.stagingPath));
};

const materializeFile = async (
  capability: FreshBootstrapCapability,
  proposal: FreshBootstrapProposal,
  file: ExactFile,
  recovery: boolean,
  stageIdentity: PathIdentity,
): Promise<void> => {
  await assertExactExecutable(capability.systemPythonIdentity);
  // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
  const stage = await open(proposal.stagingPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await stage.stat();
    if (
      !opened.isDirectory() ||
      String(opened.dev) !== stageIdentity.device ||
      String(opened.ino) !== stageIdentity.inode ||
      String(opened.uid) !== stageIdentity.uid ||
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
      (opened.mode & 0o777).toString(8) !== stageIdentity.mode
    )
      {throw new Error("The fd-bound bootstrap stage changed after its durable layout receipt.");}
    const result = spawnSync(
      capability.systemPython,
      ["-I", "-c", materializeAdapter, file.path, file.mode, file.blob, recovery ? "1" : "0"],
      {
        encoding: "utf-8",
        env: minimalEnvironment(),
        input: file.bytes,
        maxBuffer: Math.max(1024 * 1024, file.bytes.length + 64 * 1024),
        stdio: ["pipe", "pipe", "pipe", stage.fd],
        timeout: 30_000,
      },
    );
    if (result.status !== 0) {throw new Error(`Fd-bound materialization failed at ${file.path}.`);}
  } finally {
    await stage.close();
  }
};

const assertRawGitAuthority = async (
  proposal: FreshBootstrapProposal,
  root: string,
): Promise<void> => {
  const rootState = await lstat(root);
  const gitDirectory = nodePath.resolve(root, ".git");
  const gitState = await lstat(gitDirectory);
  if (
    rootState.isSymbolicLink() ||
    !rootState.isDirectory() ||
    gitState.isSymbolicLink() ||
    !gitState.isDirectory() ||
    rootState.uid !== process.geteuid?.() ||
    gitState.uid !== process.geteuid?.() ||
    rootState.dev !== gitState.dev ||
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional permission bitmask.
    (rootState.mode & 0o022) !== 0 ||
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional permission bitmask.
    (gitState.mode & 0o022) !== 0 ||
    (await realpath(root)) !== root ||
    (await realpath(gitDirectory)) !== gitDirectory ||
    (await readFile(nodePath.resolve(gitDirectory, "config"), "utf-8")) !== exactGitConfig ||
    (await readFile(nodePath.resolve(gitDirectory, "HEAD"), "utf-8")) !==
      `ref: refs/heads/${proposal.repositoryIdentity.initialBranch}\n`
  )
    {throw new Error("The fresh repository Git authority is not local and exact.");}
  for (const forbidden of [
    nodePath.resolve(gitDirectory, "commondir"),
    nodePath.resolve(gitDirectory, "gitdir"),
    nodePath.resolve(gitDirectory, "hooks"),
    nodePath.resolve(gitDirectory, "objects", "info", "alternates"),
    nodePath.resolve(gitDirectory, "objects", "info", "http-alternates"),
    nodePath.resolve(gitDirectory, "info", "grafts"),
    nodePath.resolve(gitDirectory, "refs", "replace"),
    nodePath.resolve(gitDirectory, "shallow"),
  ]) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      await lstat(forbidden);
      throw new Error("The fresh repository contains forbidden Git authority.");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {throw error;}
    }
  }
};

const initializeGit = async (input: {
  capability: FreshBootstrapCapability;
  proposal: FreshBootstrapProposal;
  files: readonly ExactFile[];
  hooks?: FreshBootstrapFaultHooks;
  recovery: boolean;
}): Promise<void> => {
  const gitDirectory = nodePath.resolve(input.proposal.stagingPath, ".git");
  let initialized = false;
  try {
    const value = await lstat(gitDirectory);
    initialized = value.isDirectory() && !value.isSymbolicLink();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {throw error;}
  }
  if (!initialized) {
    await input.hooks?.beforeGitInit?.();
    git(input.capability, input.proposal.stagingPath, [
      "init",
      "--object-format=sha1",
      "--ref-format=files",
      `--initial-branch=${input.proposal.repositoryIdentity.initialBranch}`,
      "--template=",
      ".",
    ]);
    const configHandle = await open(
      nodePath.resolve(gitDirectory, "config"),
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional binary open-flag combination.
      fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
    );
    try {
      await configHandle.writeFile(exactGitConfig);
      await configHandle.sync();
    } finally {
      await configHandle.close();
    }
    await syncDirectory(gitDirectory);
    await input.hooks?.afterGitInit?.();
  } else if (!input.recovery) {
    throw new Error("The bootstrap stage unexpectedly contains Git metadata.");
  }
  await assertRawGitAuthority(input.proposal, input.proposal.stagingPath);
  if (
    git(input.capability, input.proposal.stagingPath, [
      "rev-parse",
      "--show-object-format",
    ]).trim() !== "sha1"
  )
    {throw new Error("The fresh repository did not use SHA-1 object format.");}
  if (
    git(input.capability, input.proposal.stagingPath, ["rev-parse", "--show-ref-format"]).trim() !==
    "files"
  )
    {throw new Error("The fresh repository did not use files ref format.");}
  await input.hooks?.beforeGitAdd?.();
  const indexRecords: Buffer[] = [];
  for (const file of input.files) {
    const observed = git(
      input.capability,
      input.proposal.stagingPath,
      ["hash-object", "-w", "--stdin"],
      undefined,
      file.bytes,
    ).trim();
    if (observed !== file.blob) {throw new Error(`Git blob identity changed at ${file.path}.`);}
    indexRecords.push(Buffer.from(`${file.mode} ${file.blob}\t${file.path}\0`));
  }
  git(
    input.capability,
    input.proposal.stagingPath,
    ["update-index", "-z", "--index-info"],
    undefined,
    Buffer.concat(indexRecords),
  );
  await input.hooks?.afterGitAdd?.();
  const tree = git(input.capability, input.proposal.stagingPath, ["write-tree"]).trim();
  if (tree !== input.proposal.expectedGitTree)
    {throw new Error("Git wrote a different bootstrap tree.");}
  await input.hooks?.beforeGitCommit?.();
  const commit = git(
    input.capability,
    input.proposal.stagingPath,
    ["commit-tree", tree],
    input.proposal.repositoryIdentity,
    Buffer.from(
      input.proposal.repositoryIdentity.commitMessage.endsWith("\n")
        ? input.proposal.repositoryIdentity.commitMessage
        : `${input.proposal.repositoryIdentity.commitMessage}\n`,
    ),
  ).trim();
  if (commit !== input.proposal.expectedInitialCommit)
    {throw new Error("Git wrote a different parentless initial commit.");}
  const ref = `refs/heads/${input.proposal.repositoryIdentity.initialBranch}`;
  let currentRef = "";
  try {
    currentRef = git(input.capability, input.proposal.stagingPath, [
      "rev-parse",
      "--verify",
      ref,
    ]).trim();
  } catch {
    currentRef = "";
  }
  if (currentRef === "")
    {git(input.capability, input.proposal.stagingPath, ["update-ref", ref, commit, "0".repeat(40)]);}
  else if (!input.recovery || currentRef !== commit)
    {throw new Error("Recovery found a conflicting initial branch.");}
  git(input.capability, input.proposal.stagingPath, ["symbolic-ref", "HEAD", ref]);
  await input.hooks?.afterGitCommit?.();
};

const rawWorktreeManifest = async (
  root: string,
  proposal: FreshBootstrapProposal,
  allowClaimMarker: boolean,
): Promise<FreshBootstrapFile[]> => {
  const rootState = await lstat(root);
  const output: FreshBootstrapFile[] = [];
  const directories = new Set<string>();
  const walk = async (relativePath: string): Promise<void> => {
    const directory = relativePath === "" ? root : nodePath.resolve(root, relativePath);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
      if (path === ".git") {continue;}
      if (allowClaimMarker && path === proposal.claimMarkerName) {continue;}
      if (!safeSourcePath(path))
        {throw new Error("The fresh repository contains an unsafe raw nodePath.");}
      const absolute = nodePath.resolve(root, path);
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      const state = await lstat(absolute);
      if (
        state.isSymbolicLink() ||
        state.uid !== process.geteuid?.() ||
        state.dev !== rootState.dev ||
        // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
        (state.mode & 0o022) !== 0
      )
        {throw new Error("The fresh repository raw tree is unsafe.");}
      if (state.isDirectory()) {
        // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
        if ((state.mode & 0o777) !== 0o755)
          {throw new Error("The fresh repository contains a directory with an unexpected mode.");}
        directories.add(path);
        // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
        await walk(path);
        continue;
      }
      if (!state.isFile() || state.nlink !== 1)
        {throw new Error("The fresh repository contains a special raw entry.");}
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      const bytes = await readFile(absolute);
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
      const exactMode = (state.mode & 0o777).toString(8);
      if (exactMode !== "644" && exactMode !== "755")
        {throw new Error("The fresh repository contains a file with an unexpected mode.");}
      output.push({
        blob: blobId(bytes),
        // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
        mode: (state.mode & 0o111) === 0 ? "100644" : "100755",
        path,
      });
    }
  };
  await walk("");
  const expectedDirectories = new Set<string>();
  for (const file of proposal.exactTree) {
    const parts = file.path.split("/");
    for (let index = 1; index < parts.length; index += 1)
      {expectedDirectories.add(parts.slice(0, index).join("/"));}
  }
  if (
    JSON.stringify([...directories].toSorted()) !==
    JSON.stringify([...expectedDirectories].toSorted())
  )
    {throw new Error("The fresh repository contains an unexpected raw directory.");}
  return output.toSorted((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
};

const assertExactRepository = async (
  capability: FreshBootstrapCapability,
  proposal: FreshBootstrapProposal,
  root: string,
  options: { allowClaimMarker?: boolean } = {},
): Promise<{
  destinationIdentity: PathIdentity;
  gitDirectoryIdentity: PathIdentity;
  remoteDigest: string;
  worktreeDigest: string;
}> => {
  const gitDirectory = nodePath.resolve(root, ".git");
  await assertRawGitAuthority(proposal, root);
  const destinationIdentity = await identity(root);
  const gitDirectoryIdentity = await identity(gitDirectory);
  const ref = `refs/heads/${proposal.repositoryIdentity.initialBranch}`;
  const rawManifest = await rawWorktreeManifest(root, proposal, options.allowClaimMarker === true);
  const absoluteGitDirectory = await realpath(
    git(capability, root, ["rev-parse", "--path-format=absolute", "--git-dir"]).trim(),
  );
  const absoluteCommonDirectory = await realpath(
    git(capability, root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim(),
  );
  const remotes = git(capability, root, ["remote"]).split("\n").filter(Boolean);
  const refs = git(capability, root, ["for-each-ref", "--format=%(refname)%00%(objectname)"])
    .split("\n")
    .filter(Boolean);
  const parents = git(capability, root, ["rev-list", "--parents", "--max-count=1", "HEAD"]).trim();
  const paths = gitBuffer(capability, root, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"]);
  const observed = paths
    .toString("utf-8")
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^(?<mode>100644|100755) blob (?<objectId>[0-9a-f]{40})\t(?<path>.+)$/u.exec(
        record,
      );
      if (match === null || !safeSourcePath(match[3]))
        {throw new Error("The final repository tree is malformed.");}
      return { blob: match[2], mode: match[1], path: match[3] };
    });
  const reachableObjects = new Set(
    git(capability, root, ["rev-list", "--objects", "--all"])
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" ", 1)[0]),
  );
  const objectDirectory = nodePath.resolve(gitDirectory, "objects");
  const looseObjects = new Set<string>();
  for (const entry of await readdir(objectDirectory, { withFileTypes: true })) {
    if (entry.name === "info" || entry.name === "pack") {
      if (!entry.isDirectory())
        {throw new Error("The fresh repository contains unexpected packed or object authority.");}
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      const entries = await readdir(nodePath.resolve(objectDirectory, entry.name));
      if (entries.length !== 0)
        {throw new Error("The fresh repository contains unexpected packed or object authority.");}
      continue;
    }
    if (!entry.isDirectory() || !/^[0-9a-f]{2}$/u.test(entry.name))
      {throw new Error("The fresh repository contains malformed object storage.");}
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    for (const object of await readdir(nodePath.resolve(objectDirectory, entry.name))) {
      if (!/^[0-9a-f]{38}$/u.test(object))
        {throw new Error("The fresh repository contains malformed loose objects.");}
      looseObjects.add(`${entry.name}${object}`);
    }
  }
  if (
    git(capability, root, ["rev-parse", "--show-object-format"]).trim() !== "sha1" ||
    absoluteGitDirectory !== gitDirectory ||
    absoluteCommonDirectory !== gitDirectory ||
    git(capability, root, ["rev-parse", "--show-ref-format"]).trim() !== "files" ||
    git(capability, root, ["symbolic-ref", "HEAD"]).trim() !== ref ||
    git(capability, root, ["rev-parse", "HEAD"]).trim() !== proposal.expectedInitialCommit ||
    git(capability, root, ["rev-parse", "HEAD^{tree}"]).trim() !== proposal.expectedGitTree ||
    parents !== proposal.expectedInitialCommit ||
    git(capability, root, ["rev-list", "--count", "HEAD"]).trim() !== "1" ||
    remotes.length !== 0 ||
    JSON.stringify(refs) !== JSON.stringify([`${ref}\0${proposal.expectedInitialCommit}`]) ||
    JSON.stringify([...looseObjects].toSorted()) !==
      JSON.stringify([...reachableObjects].toSorted()) ||
    git(capability, root, ["status", "--porcelain=v1", "--untracked-files=all"]).trim() !==
      (options.allowClaimMarker ? `?? ${proposal.claimMarkerName}` : "") ||
    JSON.stringify(observed) !== JSON.stringify(proposal.exactTree) ||
    JSON.stringify(rawManifest) !== JSON.stringify(proposal.exactTree)
  )
    {throw new Error("The final fresh repository failed exact verification.");}
  for (const forbidden of [
    nodePath.resolve(gitDirectory, "objects", "info", "alternates"),
    nodePath.resolve(gitDirectory, "info", "grafts"),
    nodePath.resolve(gitDirectory, "refs", "replace"),
  ]) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      await lstat(forbidden);
      throw new Error("The final repository contains forbidden Git authority.");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {throw error;}
    }
  }
  return {
    destinationIdentity,
    gitDirectoryIdentity,
    remoteDigest: stableDigest(remotes),
    worktreeDigest: stableDigest(observed),
  };
};

const atomicPublish = async (
  capability: FreshBootstrapCapability,
  proposal: FreshBootstrapProposal,
  stageIdentity: PathIdentity,
  hooks?: FreshBootstrapFaultHooks,
): Promise<void> => {
  const parentPath = nodePath.dirname(proposal.destinationPath);
  // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
  const parent = await open(parentPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const parentState = await parent.stat();
    const increment = 1;
    const expectedParentNlink = String(
      BigInt(proposal.destinationPrestate.parent.nlink) + BigInt(increment),
    );
    const approvedEmpty =
      proposal.destinationPrestate.kind === "empty-directory"
        ? proposal.destinationPrestate.destination
        : undefined;
    if (
      String(parentState.dev) !== proposal.destinationPrestate.parent.device ||
      String(parentState.ino) !== proposal.destinationPrestate.parent.inode ||
      String(parentState.uid) !== proposal.destinationPrestate.parent.uid ||
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
      (parentState.mode & 0o777).toString(8) !== proposal.destinationPrestate.parent.mode ||
      String(parentState.nlink) !== expectedParentNlink
    )
      {throw new Error("The destination parent changed before atomic publication.");}
    const stageState = await lstat(proposal.stagingPath);
    if (
      stageState.isSymbolicLink() ||
      !stageState.isDirectory() ||
      JSON.stringify(await identity(proposal.stagingPath)) !== JSON.stringify(stageIdentity)
    )
      {throw new Error("The reviewed bootstrap stage changed before atomic publication.");}
    const originalEmpty =
      approvedEmpty === undefined ? undefined : await lstat(proposal.destinationPath);
    if (
      originalEmpty !== undefined &&
      (originalEmpty.isSymbolicLink() ||
        !originalEmpty.isDirectory() ||
        JSON.stringify(await identity(proposal.destinationPath)) !== JSON.stringify(approvedEmpty))
    )
      {throw new Error("The approved exact-empty destination changed before atomic publication.");}
    if (originalEmpty !== undefined) {
      const entries = await readdir(proposal.destinationPath);
      if (entries.length !== 0)
        {throw new Error("The approved exact-empty destination changed before atomic publication.");}
    }
    await assertExactExecutable(capability.systemPythonIdentity);
    let publicationMode: "exchange" | "exchange-hold" | "noreplace";
    if (proposal.destinationPrestate.kind === "absent") {publicationMode = "noreplace";}
    else if (hooks?.afterAtomicSwap === undefined) {publicationMode = "exchange";}
    else {publicationMode = "exchange-hold";}
    const result = spawnSync(
      capability.systemPython,
      [
        "-I",
        "-c",
        atomicPublicationAdapter,
        publicationMode,
        nodePath.basename(proposal.stagingPath),
        nodePath.basename(proposal.destinationPath),
        stageIdentity.device,
        stageIdentity.inode,
        stageIdentity.uid,
        stageIdentity.mode,
        stageIdentity.nlink,
        approvedEmpty?.device ?? "-",
        approvedEmpty?.inode ?? "-",
        approvedEmpty?.uid ?? "-",
        approvedEmpty?.mode ?? "-",
        approvedEmpty?.nlink ?? "-",
        proposal.destinationPrestate.parent.device,
        proposal.destinationPrestate.parent.inode,
        proposal.destinationPrestate.parent.uid,
        proposal.destinationPrestate.parent.mode,
        expectedParentNlink,
      ],
      {
        encoding: "utf-8",
        env: minimalEnvironment(),
        stdio: ["ignore", "pipe", "pipe", parent.fd],
        timeout: 30_000,
      },
    );
    if (result.status !== 0)
      {throw new Error(
        `Atomic no-replace publication failed${result.stderr.trim() === "" ? "." : `: ${result.stderr.trim()}`}`,
      );}
    const destination = await lstat(proposal.destinationPath);
    if (
      String(destination.dev) !== stageIdentity.device ||
      String(destination.ino) !== stageIdentity.inode
    )
      {throw new Error("Atomic publication did not install the exact stage inode.");}
    await hooks?.afterAtomicSwap?.();
    if (originalEmpty !== undefined) {
      if (
        (await pathState(proposal.stagingPath)) !== "directory" ||
        JSON.stringify(await identity(proposal.stagingPath)) !==
          JSON.stringify(
            proposal.destinationPrestate.kind === "empty-directory"
              ? {
                  ...proposal.destinationPrestate.destination,
                  path: proposal.stagingPath,
                }
              : undefined,
          )
      )
        {throw new Error("Atomic exchange did not retain the exact old empty inode as a tombstone.");}
      const entries = await readdir(proposal.stagingPath);
      if (entries.length !== 0)
        {throw new Error("Atomic exchange did not retain the exact old empty inode as a tombstone.");}
    }
  } finally {
    await parent.close();
  }
};

const removeVerifiedSwappedEmptyDirectory = async (
  capability: FreshBootstrapCapability,
  proposal: FreshBootstrapProposal,
): Promise<void> => {
  if (proposal.destinationPrestate.kind !== "empty-directory") {return;}
  const state = await pathState(proposal.stagingPath);
  if (state === "absent") {return;}
  if (state !== "directory") {throw new Error("Recovery found an invalid swapped-out destination.");}
  if (
    JSON.stringify(await identity(proposal.stagingPath)) !==
    JSON.stringify({
      ...proposal.destinationPrestate.destination,
      path: proposal.stagingPath,
    })
  )
    {throw new Error("Recovery found a changed swapped-out tombstone.");}
  const entries = await readdir(proposal.stagingPath);
  if (entries.length !== 0) {throw new Error("Recovery found a changed swapped-out tombstone.");}
};

const pendingReceipt = (
  proposal: FreshBootstrapProposal,
  publishedByCallId: string,
  recoveryOfDigest: string | undefined,
  leaseMarkerDigest: string,
  previousLeaseMarkerDigest: string | undefined,
  layout: FreshBootstrapLayout,
): FreshBootstrapPendingReceipt => {
  const { digest: proposalDigest, ...proposalFields } = proposal;
  const unsigned = {
    ...proposalFields,
    destinationPublished: layout.phase === "published",
    layout,
    leaseMarkerDigest,
    ...(recoveryOfDigest === undefined ? {} : { recoveryOfDigest }),
    ...(previousLeaseMarkerDigest === undefined ? {} : { previousLeaseMarkerDigest }),
    proposalDigest,
    publishedByCallId,
    stageCreated: layout.phase !== "intent",
    status: "pending" as const,
  };
  return { ...unsigned, digest: freshBootstrapJournalDigest(unsigned) };
};

const failureReceipt = (input: {
  proposal: FreshBootstrapProposal;
  publishedByCallId: string;
  recoveryOfDigest?: string;
  leaseMarkerDigest: string;
  previousLeaseMarkerDigest?: string;
  layout: FreshBootstrapLayout;
  reason: FreshBootstrapFailureReceipt["reason"];
  failureMessage: string;
  stageCreated: boolean;
  destinationPublished: boolean;
}): FreshBootstrapFailureReceipt => {
  const { digest: proposalDigest, ...proposalFields } = input.proposal;
  const unsigned = {
    ...proposalFields,
    destinationPublished: input.destinationPublished,
    failureMessage: input.failureMessage,
    layout: input.layout,
    leaseMarkerDigest: input.leaseMarkerDigest,
    ...(input.previousLeaseMarkerDigest === undefined
      ? {}
      : { previousLeaseMarkerDigest: input.previousLeaseMarkerDigest }),
    proposalDigest,
    publishedByCallId: input.publishedByCallId,
    reason: input.reason,
    ...(input.recoveryOfDigest === undefined ? {} : { recoveryOfDigest: input.recoveryOfDigest }),
    recoveryRequired: true as const,
    stageCreated: input.stageCreated,
    status: "failed" as const,
  };
  return { ...unsigned, digest: freshBootstrapJournalDigest(unsigned) };
};

const successReceipt = (input: {
  proposal: FreshBootstrapProposal;
  publishedByCallId: string;
  recoveryOfDigest?: string;
  leaseMarkerDigest: string;
  previousLeaseMarkerDigest?: string;
  verification: Awaited<ReturnType<typeof assertExactRepository>>;
  swappedOldIdentity?: PathIdentity;
}): FreshBootstrapSuccessReceipt => {
  const { digest: proposalDigest, ...proposalFields } = input.proposal;
  const unsigned = {
    ...proposalFields,
    commitCount: 1 as const,
    destinationIdentity: input.verification.destinationIdentity,
    gitDirectoryIdentity: input.verification.gitDirectoryIdentity,
    headCommit: input.proposal.expectedInitialCommit,
    headReference: `refs/heads/${input.proposal.repositoryIdentity.initialBranch}`,
    headTree: input.proposal.expectedGitTree,
    leaseMarkerDigest: input.leaseMarkerDigest,
    ...(input.previousLeaseMarkerDigest === undefined
      ? {}
      : { previousLeaseMarkerDigest: input.previousLeaseMarkerDigest }),
    proposalDigest,
    publishedByCallId: input.publishedByCallId,
    ...(input.recoveryOfDigest === undefined ? {} : { recoveryOfDigest: input.recoveryOfDigest }),
    recoveryRequired: false as const,
    remoteDigest: input.verification.remoteDigest,
    status: "succeeded" as const,
    ...(input.swappedOldIdentity === undefined
      ? {}
      : { swappedOldIdentity: input.swappedOldIdentity }),
    worktreeDigest: input.verification.worktreeDigest,
  };
  return { ...unsigned, digest: freshBootstrapJournalDigest(unsigned) };
};

export const readFreshBootstrapJournal = async (input: {
  capability?: FreshBootstrapCapability;
  proposal: FreshBootstrapProposal;
}): Promise<FreshBootstrapJournal | undefined> => {
  const capability = await assertCapability(input.capability);
  assertExactFreshBootstrapProposal(input.proposal);
  if (
    input.proposal.journalPath !==
    nodePath.resolve(
      capability.stateRoot.path,
      "journals",
      `${input.proposal.publicationIdentityDigest}.json`,
    )
  )
    {throw new Error("The fresh-bootstrap journal path is not identity-bound.");}
  await assertContainedStatePath(capability, input.proposal.journalPath, "absent-or-file");
  let bytes;
  try {
    bytes = await readFile(input.proposal.journalPath, "utf-8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {return undefined;}
    throw error;
  }
  const parsed = JSON.parse(bytes) as FreshBootstrapJournal;
  assertCanonicalFreshBootstrapJournal(parsed);
  if (!exactFreshBootstrapProposalMatch(proposalFromFreshBootstrapJournal(parsed), input.proposal))
    {throw new Error("The bootstrap journal belongs to another proposal.");}
  return parsed;
};

const executeBootstrap = async (input: {
  capability?: FreshBootstrapCapability;
  proposal: FreshBootstrapProposal;
  sourceReceipt: SourceReceipt;
  review: ReviewedChangeSetReceipt;
  publishedByCallId: string;
  recoveryOfDigest?: string;
  readOverlayFile: (path: string) => Promise<Uint8Array | null>;
  sourceWorkspace?: FreshBootstrapSourceWorkspace;
  hooks?: FreshBootstrapFaultHooks;
}): Promise<
  | { ok: true; receipt: FreshBootstrapSuccessReceipt }
  | { ok: false; receipt: FreshBootstrapFailureReceipt }
> => {
  const capability = await assertCapability(input.capability);
  const files = await assertExactInputs({ ...input, capability });
  let existingJournal = await readFreshBootstrapJournal({
    capability,
    proposal: input.proposal,
  });
  if (input.recoveryOfDigest === undefined && existingJournal !== undefined)
    {throw new Error("Fresh bootstrap already has a durable journal.");}
  if (
    input.recoveryOfDigest !== undefined &&
    (existingJournal === undefined || existingJournal.digest !== input.recoveryOfDigest)
  )
    {throw new Error("Fresh-bootstrap recovery requires the exact journal digest.");}
  const priorLeaseMarkerDigest = existingJournal?.leaseMarkerDigest;
  const lease = await acquireLease(
    capability,
    input.proposal.lockPath,
    input.recoveryOfDigest === undefined ? undefined : priorLeaseMarkerDigest,
  );
  const lockedJournal = await readFreshBootstrapJournal({
    capability,
    proposal: input.proposal,
  });
  if (lockedJournal?.digest !== existingJournal?.digest) {
    await lease.release();
    throw new Error("The fresh-bootstrap journal changed while acquiring the destination lease.");
  }
  existingJournal = lockedJournal;
  try {
    if (existingJournal !== undefined && existingJournal.status !== "succeeded") {
      const { layout } = existingJournal;
      if (layout.phase === "intent") {
        if ((await pathState(input.proposal.stagingPath)) !== "absent")
          {throw new Error("The intent journal no longer matches the bootstrap stage.");}
      } else if (layout.phase === "stage-owned" || layout.phase === "stage-ready") {
        if (
          (await pathState(input.proposal.stagingPath)) !== "directory" ||
          JSON.stringify(await identity(input.proposal.stagingPath)) !==
            JSON.stringify(layout.stageIdentity)
        )
          {throw new Error("The bootstrap stage no longer matches its durable layout receipt.");}
      } else {
        if (
          (await pathState(input.proposal.destinationPath)) !== "directory" ||
          JSON.stringify(await identity(input.proposal.destinationPath)) !==
            JSON.stringify(layout.destinationIdentity)
        )
          {throw new Error(
            "The destination no longer matches its durable published layout receipt.",
          );}
        if (
          layout.swappedOldIdentity !== undefined &&
          ((await pathState(input.proposal.stagingPath)) !== "directory" ||
            JSON.stringify(await identity(input.proposal.stagingPath)) !==
              JSON.stringify(layout.swappedOldIdentity))
        )
          {throw new Error(
            "The swapped-out directory no longer matches its durable layout receipt.",
          );}
      }
    }
  } catch (error) {
    await lease.release();
    throw error;
  }
  let stageCreated = (await pathState(input.proposal.stagingPath)) === "directory";
  let stageReady =
    existingJournal?.status !== "succeeded" && existingJournal?.layout.phase === "stage-ready";
  let stageReadyIdentity =
    existingJournal?.status !== "succeeded" && existingJournal?.layout.phase === "stage-ready"
      ? existingJournal.layout.stageIdentity
      : undefined;
  let destinationPublished = false;
  try {
    await input.hooks?.afterLockReady?.(lease.pid);
    lease.assertHeld();
    if (input.recoveryOfDigest === undefined) {
      const pending = pendingReceipt(
        input.proposal,
        input.publishedByCallId,
        undefined,
        lease.markerDigest,
        undefined,
        { phase: "intent" },
      );
      await createInitialJournal(capability, input.proposal.journalPath, pending);
      await input.hooks?.afterPendingJournal?.();
    } else {
      const recoveryPending = pendingReceipt(
        input.proposal,
        input.publishedByCallId,
        input.recoveryOfDigest,
        lease.markerDigest,
        priorLeaseMarkerDigest,
        stageCreated
          ? {
              phase: stageReady ? "stage-ready" : "stage-owned",
              stageIdentity: await identity(input.proposal.stagingPath),
            }
          : { phase: "intent" },
      );
      await atomicWrite(
        capability,
        input.proposal.journalPath,
        `${JSON.stringify(recoveryPending)}\n`,
      );
    }
    lease.assertHeld();
    const destinationState = await pathState(input.proposal.destinationPath);
    if (destinationState === "directory") {
      let verification: Awaited<ReturnType<typeof assertExactRepository>> | undefined;
      try {
        verification = await assertExactRepository(
          capability,
          input.proposal,
          input.proposal.destinationPath,
        );
      } catch {
        verification = undefined;
      }
      if (verification === undefined) {
        if (input.proposal.destinationPrestate.kind !== "empty-directory")
          {throw new Error("The destination conflicts with recovery state.");}
        await assertPrestate(capability, input.proposal);
      } else {
        destinationPublished = true;
        await removeVerifiedSwappedEmptyDirectory(capability, input.proposal);
        const success = successReceipt({
          leaseMarkerDigest: lease.markerDigest,
          previousLeaseMarkerDigest: priorLeaseMarkerDigest,
          proposal: input.proposal,
          publishedByCallId: input.publishedByCallId,
          recoveryOfDigest: input.recoveryOfDigest,
          verification,
          ...(input.proposal.destinationPrestate.kind === "empty-directory"
            ? {
                swappedOldIdentity: await identity(input.proposal.stagingPath),
              }
            : {}),
        });
        await atomicWrite(capability, input.proposal.journalPath, `${JSON.stringify(success)}\n`);
        return { ok: true, receipt: success };
      }
    }
    if (!stageCreated) {
      await assertPrestate(capability, input.proposal);
      await assertSourceUnchanged(input.sourceReceipt, input.sourceWorkspace);
      await createStage(capability, input.proposal);
      stageCreated = true;
      await input.hooks?.afterStageCreation?.();
      await input.hooks?.afterStageMarker?.();
      const claimed = pendingReceipt(
        input.proposal,
        input.publishedByCallId,
        input.recoveryOfDigest,
        lease.markerDigest,
        priorLeaseMarkerDigest,
        {
          phase: "stage-owned",
          stageIdentity: await identity(input.proposal.stagingPath),
        },
      );
      await atomicWrite(capability, input.proposal.journalPath, `${JSON.stringify(claimed)}\n`);
    } else if (input.recoveryOfDigest === undefined) {
      throw new Error("The deterministic bootstrap stage already exists.");
    }
    lease.assertHeld();
    const durableStageIdentity = await identity(input.proposal.stagingPath);
    for (const [index, file] of files.entries()) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      await materializeFile(
        capability,
        input.proposal,
        file,
        input.recoveryOfDigest !== undefined,
        durableStageIdentity,
      );
      lease.assertHeld();
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      await input.hooks?.afterMaterializeFile?.(file.path, index);
    }
    await initializeGit({
      capability,
      files,
      hooks: input.hooks,
      proposal: input.proposal,
      recovery: input.recoveryOfDigest !== undefined,
    });
    lease.assertHeld();
    const marker = nodePath.resolve(input.proposal.stagingPath, input.proposal.claimMarkerName);
    const markerState = await pathState(marker);
    if (markerState === "other") {
      const markerBytes = await readFile(marker);
      if (Buffer.compare(markerBytes, await markerContent(input.proposal)) !== 0)
        {throw new Error("The bootstrap stage ownership marker changed.");}
      await assertExactRepository(capability, input.proposal, input.proposal.stagingPath, {
        allowClaimMarker: true,
      });
      const claimedReadyIdentity = await identity(input.proposal.stagingPath);
      const ready = pendingReceipt(
        input.proposal,
        input.publishedByCallId,
        input.recoveryOfDigest,
        lease.markerDigest,
        priorLeaseMarkerDigest,
        {
          phase: "stage-ready",
          stageIdentity: claimedReadyIdentity,
        },
      );
      await atomicWrite(capability, input.proposal.journalPath, `${JSON.stringify(ready)}\n`);
      stageReady = true;
      await unlink(marker);
      await syncDirectory(input.proposal.stagingPath);
      stageReadyIdentity = await identity(input.proposal.stagingPath);
      const markerRemovedReady = pendingReceipt(
        input.proposal,
        input.publishedByCallId,
        input.recoveryOfDigest,
        lease.markerDigest,
        priorLeaseMarkerDigest,
        {
          phase: "stage-ready",
          stageIdentity: stageReadyIdentity,
        },
      );
      await atomicWrite(
        capability,
        input.proposal.journalPath,
        `${JSON.stringify(markerRemovedReady)}\n`,
      );
    } else if (!stageReady || markerState !== "absent") {
      throw new Error("Recovery lacks exact stage-ready ownership evidence.");
    }
    await assertExactRepository(capability, input.proposal, input.proposal.stagingPath);
    lease.assertHeld();
    await input.hooks?.beforeAtomicPublication?.();
    await assertSourceUnchanged(input.sourceReceipt, input.sourceWorkspace);
    if (stageReadyIdentity === undefined)
      {throw new Error("Fresh bootstrap lacks durable stage-ready identity.");}
    await atomicPublish(capability, input.proposal, stageReadyIdentity, input.hooks);
    destinationPublished = true;
    lease.assertHeld();
    await input.hooks?.afterAtomicPublication?.();
    const verification = await assertExactRepository(
      capability,
      input.proposal,
      input.proposal.destinationPath,
    );
    await assertSourceUnchanged(input.sourceReceipt, input.sourceWorkspace);
    await input.hooks?.beforeTerminalJournal?.();
    lease.assertHeld();
    const success = successReceipt({
      leaseMarkerDigest: lease.markerDigest,
      previousLeaseMarkerDigest: priorLeaseMarkerDigest,
      proposal: input.proposal,
      publishedByCallId: input.publishedByCallId,
      recoveryOfDigest: input.recoveryOfDigest,
      verification,
      ...(input.proposal.destinationPrestate.kind === "empty-directory"
        ? { swappedOldIdentity: await identity(input.proposal.stagingPath) }
        : {}),
    });
    await atomicWrite(capability, input.proposal.journalPath, `${JSON.stringify(success)}\n`);
    lease.assertHeld();
    return { ok: true, receipt: success };
  } catch (error) {
    if (!destinationPublished) {
      try {
        await assertExactRepository(capability, input.proposal, input.proposal.destinationPath);
        destinationPublished = true;
      } catch {
        destinationPublished = false;
      }
    }
    let layout: FreshBootstrapLayout;
    if (destinationPublished) {
      const destinationIdentity = await identity(input.proposal.destinationPath);
      const stagingPathState = await pathState(input.proposal.stagingPath);
      layout = {
        destinationIdentity,
        phase: "published",
        ...(stagingPathState === "directory"
          ? { swappedOldIdentity: await identity(input.proposal.stagingPath) }
          : {}),
      };
    } else if (stageCreated) {
      layout = {
        phase: stageReady ? "stage-ready" : "stage-owned",
        stageIdentity: await identity(input.proposal.stagingPath),
      };
    } else {
      layout = { phase: "intent" };
    }
    let reason: FreshBootstrapFailureReceipt["reason"];
    if (destinationPublished) {reason = "publication-partial";}
    else if (stageCreated) {reason = "materialization-partial";}
    else {reason = "precondition-failed";}
    let failure = failureReceipt({
      destinationPublished,
      failureMessage: error instanceof Error ? error.message : "Fresh bootstrap failed.",
      layout,
      leaseMarkerDigest: lease.markerDigest,
      previousLeaseMarkerDigest: priorLeaseMarkerDigest,
      proposal: input.proposal,
      publishedByCallId: input.publishedByCallId,
      reason,
      recoveryOfDigest: input.recoveryOfDigest,
      stageCreated,
    });
    let leaseHeld = true;
    try {
      lease.assertHeld();
    } catch {
      leaseHeld = false;
    }
    if (leaseHeld && !input.hooks?.preserveNonterminalJournal)
      {await atomicWrite(capability, input.proposal.journalPath, `${JSON.stringify(failure)}\n`);}
    if (!leaseHeld) {
      const quiesced = await quiesceAbandonedLease(
        capability,
        input.proposal.lockPath,
        lease.markerDigest,
      );
      try {
        const durable = await readFreshBootstrapJournal({
          capability,
          proposal: input.proposal,
        });
        if (durable === undefined)
          {throw new Error(
            "The fresh-bootstrap lease was lost before durable intent; its quiesced marker requires a separate reset.",
            { cause: error },
          );}
        failure = failureReceipt({
          destinationPublished: failure.destinationPublished,
          failureMessage:
            "The mutation lease was lost; all synchronous helpers quiesced before this recovery-required receipt.",
          layout: failure.layout,
          leaseMarkerDigest: quiesced.markerDigest,
          previousLeaseMarkerDigest: priorLeaseMarkerDigest,
          proposal: input.proposal,
          publishedByCallId: input.publishedByCallId,
          reason: failure.reason,
          recoveryOfDigest: input.recoveryOfDigest,
          stageCreated: failure.stageCreated,
        });
        await atomicWrite(capability, input.proposal.journalPath, `${JSON.stringify(failure)}\n`);
      } finally {
        await quiesced.release();
      }
    }
    return { ok: false, receipt: failure };
  } finally {
    try {
      await lease.release();
    } catch {
      // A lost lease is converted to an exact quiesced recovery receipt above.
    }
  }
};

// oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
export const publishFreshBootstrap = async (
  input: Omit<Parameters<typeof executeBootstrap>[0], "recoveryOfDigest">,
) => executeBootstrap(input);

// oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
export const recoverFreshBootstrap = async (
  input: Omit<Parameters<typeof executeBootstrap>[0], "recoveryOfDigest"> & {
    expectedJournalDigest: string;
  },
) =>
  executeBootstrap({
    ...input,
    recoveryOfDigest: input.expectedJournalDigest,
  });

export const verifyFreshBootstrap = async (input: {
  capability?: FreshBootstrapCapability;
  receipt: FreshBootstrapSuccessReceipt;
  sourceReceipt: SourceReceipt;
  review: ReviewedChangeSetReceipt;
  readOverlayFile: (path: string) => Promise<Uint8Array | null>;
  sourceWorkspace?: FreshBootstrapSourceWorkspace;
}): Promise<void> => {
  const capability = await assertCapability(input.capability);
  assertCanonicalFreshBootstrapJournal(input.receipt);
  await assertExactInputs({
    capability,
    proposal: proposalFromFreshBootstrapJournal(input.receipt),
    readOverlayFile: input.readOverlayFile,
    review: input.review,
    sourceReceipt: input.sourceReceipt,
    sourceWorkspace: input.sourceWorkspace,
  });
  const verification = await assertExactRepository(
    capability,
    proposalFromFreshBootstrapJournal(input.receipt),
    input.receipt.destinationPath,
  );
  if (input.receipt.swappedOldIdentity !== undefined) {
    if (
      (await pathState(input.receipt.stagingPath)) !== "directory" ||
      JSON.stringify(await identity(input.receipt.stagingPath)) !==
        JSON.stringify(input.receipt.swappedOldIdentity)
    )
      {throw new Error("The swapped-out empty tombstone changed after receipt.");}
    const entries = await readdir(input.receipt.stagingPath);
    if (entries.length !== 0)
      {throw new Error("The swapped-out empty tombstone changed after receipt.");}
  }
  if (
    JSON.stringify(verification.destinationIdentity) !==
      JSON.stringify(input.receipt.destinationIdentity) ||
    JSON.stringify(verification.gitDirectoryIdentity) !==
      JSON.stringify(input.receipt.gitDirectoryIdentity) ||
    verification.remoteDigest !== input.receipt.remoteDigest ||
    verification.worktreeDigest !== input.receipt.worktreeDigest
  )
    {throw new Error("The published fresh repository changed after receipt.");}
};
