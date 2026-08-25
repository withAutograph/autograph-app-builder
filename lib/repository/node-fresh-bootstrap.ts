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
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  assertCanonicalFreshBootstrapJournal,
  assertExactFreshBootstrapProposal,
  createFreshBootstrapProposal,
  exactFreshBootstrapProposalMatch,
  freshBootstrapJournalDigest,
  proposalFromFreshBootstrapJournal,
  type FreshBootstrapCapability,
  type FreshBootstrapFailureReceipt,
  type FreshBootstrapFile,
  type FreshBootstrapIdentity,
  type FreshBootstrapJournal,
  type FreshBootstrapLayout,
  type FreshBootstrapPendingReceipt,
  type FreshBootstrapPrestate,
  type FreshBootstrapProposal,
  type FreshBootstrapSuccessReceipt,
  type ExecutableIdentity,
  type PathIdentity,
} from "./fresh-bootstrap";
import {
  assertExactReviewedChangeSet,
  contentDigest,
  pathsOverlap,
  stableDigest,
} from "./local-publication";
import type { ReviewedChangeSetReceipt } from "./reviewed-change-set";
import { inspectSourceReceipt, type SourceReceipt } from "./source-receipt";
import { safeSourcePath } from "./source-path";

export type FreshBootstrapFaultHooks = {
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
};

type ExactFile = FreshBootstrapFile & { bytes: Buffer };
const atomicPublicationAdapter = String.raw`
import ctypes, os, platform, stat, sys
mode, stage, destination, stage_dev, stage_ino, empty_dev, empty_ino = sys.argv[1:]
parent_fd = 3
libc = ctypes.CDLL(None, use_errno=True)
stage_b = os.fsencode(stage); destination_b = os.fsencode(destination)
def exact(name, dev, ino):
    value = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if not stat.S_ISDIR(value.st_mode) or str(value.st_dev) != dev or str(value.st_ino) != ino:
        raise SystemExit(76)
    return value
if mode == "noreplace":
    exact(stage, stage_dev, stage_ino)
    try: os.stat(destination, dir_fd=parent_fd, follow_symlinks=False); raise SystemExit(77)
    except FileNotFoundError: pass
else:
    exact(stage, stage_dev, stage_ino)
    exact(destination, empty_dev, empty_ino)
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
    exact(stage, empty_dev, empty_ino)
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
parts = path.split("/")
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

const minimalEnvironment = (
  identity?: FreshBootstrapIdentity,
): NodeJS.ProcessEnv => ({
  NODE_ENV: "production",
  PATH: "/usr/bin:/bin",
  TMPDIR: "/tmp",
  HOME: "/dev/null",
  XDG_CONFIG_HOME: "/dev/null",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_NO_LAZY_FETCH: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/usr/bin/false",
  SSH_ASKPASS: "/usr/bin/false",
  ...(identity === undefined
    ? {}
    : {
        GIT_AUTHOR_NAME: identity.authorName,
        GIT_AUTHOR_EMAIL: identity.authorEmail,
        GIT_AUTHOR_DATE: identity.commitTimestamp,
        GIT_COMMITTER_NAME: identity.authorName,
        GIT_COMMITTER_EMAIL: identity.authorEmail,
        GIT_COMMITTER_DATE: identity.commitTimestamp,
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

function git(
  capability: FreshBootstrapCapability,
  root: string,
  args: readonly string[],
  identity?: FreshBootstrapIdentity,
  input?: Uint8Array,
): string {
  return execFileSync(
    capability.systemGit,
    [...gitOptions, "-C", root, ...args],
    {
      encoding: "utf8",
      env: minimalEnvironment(identity),
      input,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

function gitBuffer(
  capability: FreshBootstrapCapability,
  root: string,
  args: readonly string[],
): Buffer {
  return execFileSync(
    capability.systemGit,
    [...gitOptions, "-C", root, ...args],
    {
      encoding: "buffer",
      env: minimalEnvironment(),
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

async function identity(path: string): Promise<PathIdentity> {
  const canonical = await realpath(path);
  const value = await lstat(canonical);
  return {
    path: canonical,
    device: String(value.dev),
    inode: String(value.ino),
    uid: String(value.uid),
    mode: (value.mode & 0o777).toString(8),
    nlink: String(value.nlink),
  };
}

async function rootIdentity(path: string): Promise<PathIdentity> {
  return { ...(await identity(path)), nlink: "0" };
}

async function assertExactIdentity(
  expected: PathIdentity,
  kind: "directory" | "file",
): Promise<void> {
  if (
    !isAbsolute(expected.path) ||
    (await realpath(expected.path)) !== expected.path
  )
    throw new Error("The bootstrap capability path is not canonical.");
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
    (value.mode & 0o777).toString(8) !== expected.mode ||
    (value.mode & 0o777) !== (kind === "directory" ? 0o700 : 0o600) ||
    (kind === "file" && value.nlink !== 1)
  )
    throw new Error("The bootstrap capability identity changed or is unsafe.");
}

async function executableIdentity(path: string): Promise<ExecutableIdentity> {
  const canonical = await realpath(path);
  const value = await lstat(canonical);
  if (!value.isFile() || value.isSymbolicLink())
    throw new Error("The bootstrap helper is not a fixed regular file.");
  return {
    path: canonical,
    device: String(value.dev),
    inode: String(value.ino),
    uid: String(value.uid),
    mode: (value.mode & 0o777).toString(8),
    nlink: String(value.nlink),
    sha256: createHash("sha256")
      .update(await readFile(canonical))
      .digest("hex"),
  };
}

async function assertExactExecutable(
  expected: ExecutableIdentity,
): Promise<void> {
  if (!isAbsolute(expected.path))
    throw new Error("The bootstrap helper path is not absolute.");
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
    throw new Error("The bootstrap helper identity changed after approval.");
}

async function assertCapability(
  capability: FreshBootstrapCapability | undefined,
): Promise<FreshBootstrapCapability> {
  if (capability === undefined)
    throw new Error(
      "Fresh local bootstrap production capability is not configured.",
    );
  if (
    capability.kind !== "fresh-bootstrap-local-v1" ||
    (capability.authority !== "configured-production" &&
      capability.authority !== "structural-test-injection") ||
    !existsSync(capability.systemGit) ||
    !existsSync(capability.systemPython) ||
    !existsSync(capability.systemNode) ||
    !existsSync(capability.lockHelper)
  )
    throw new Error("The fresh-bootstrap capability is invalid.");
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
    capability.lockHelperIdentity.path !== capability.lockHelper ||
    pathsOverlap(capability.stateRoot.path, capability.allowedRoot.path)
  )
    throw new Error("Bootstrap state and destination roots must be disjoint.");
  return capability;
}

export async function productionFreshBootstrapCapability(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<FreshBootstrapCapability> {
  if (environment.APP_BUILDER_FRESH_BOOTSTRAP_ENABLED !== "1")
    throw new Error("Fresh local bootstrap is disabled on this host.");
  const stateRootPath = environment.APP_BUILDER_FRESH_BOOTSTRAP_STATE_ROOT;
  const allowedRootPath = environment.APP_BUILDER_FRESH_BOOTSTRAP_ALLOWED_ROOT;
  if (
    stateRootPath === undefined ||
    allowedRootPath === undefined ||
    !isAbsolute(stateRootPath) ||
    !isAbsolute(allowedRootPath)
  )
    throw new Error("Fresh local bootstrap roots are not configured.");
  const systemGit = existsSync("/usr/bin/git")
    ? "/usr/bin/git"
    : existsSync("/bin/git")
      ? "/bin/git"
      : undefined;
  const systemPython = existsSync("/usr/bin/python3")
    ? "/usr/bin/python3"
    : existsSync("/bin/python3")
      ? "/bin/python3"
      : undefined;
  const lockHelper = existsSync("/usr/bin/flock")
    ? "/usr/bin/flock"
    : existsSync("/usr/bin/lockf")
      ? "/usr/bin/lockf"
      : undefined;
  const systemNode = await realpath(process.execPath);
  if (
    systemGit === undefined ||
    systemPython === undefined ||
    lockHelper === undefined
  )
    throw new Error(
      "Fixed fresh-bootstrap helper executables are unavailable.",
    );
  const capability: FreshBootstrapCapability = {
    kind: "fresh-bootstrap-local-v1",
    stateRoot: await rootIdentity(resolve(stateRootPath)),
    allowedRoot: await rootIdentity(resolve(allowedRootPath)),
    systemGit,
    systemPython,
    systemGitIdentity: await executableIdentity(systemGit),
    systemPythonIdentity: await executableIdentity(systemPython),
    systemNode,
    systemNodeIdentity: await executableIdentity(systemNode),
    lockHelper,
    lockHelperIdentity: await executableIdentity(lockHelper),
    authority: "configured-production",
  };
  return assertCapability(capability);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    if (!(await handle.stat()).isDirectory())
      throw new Error("The durable bootstrap path is not a directory.");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertContainedStatePath(
  capability: FreshBootstrapCapability,
  candidate: string,
  leaf: "absent-or-file" | "absent-or-directory" | "directory",
): Promise<void> {
  await assertExactIdentity(capability.stateRoot, "directory");
  if (
    !within(capability.stateRoot.path, candidate) ||
    candidate === capability.stateRoot.path
  )
    throw new Error("The bootstrap state path escapes its owner-only root.");
  const segments = relative(capability.stateRoot.path, candidate).split(sep);
  let cursor = capability.stateRoot.path;
  for (let index = 0; index < segments.length; index += 1) {
    cursor = resolve(cursor, segments[index]);
    let value;
    try {
      value = await lstat(cursor);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (leaf !== "directory") return;
      }
      throw error;
    }
    const isLeaf = index === segments.length - 1;
    if (
      value.isSymbolicLink() ||
      value.uid !== process.geteuid?.() ||
      value.dev.toString() !== capability.stateRoot.device ||
      (!isLeaf && !value.isDirectory()) ||
      (value.isDirectory() && (value.mode & 0o777) !== 0o700) ||
      (isLeaf && leaf === "directory" && !value.isDirectory()) ||
      (isLeaf &&
        leaf === "absent-or-file" &&
        (!value.isFile() ||
          (value.mode & 0o777) !== 0o600 ||
          value.nlink !== 1)) ||
      (await realpath(cursor)) !== cursor
    )
      throw new Error("The bootstrap state path is unsafe.");
  }
}

async function durableDirectory(
  capability: FreshBootstrapCapability,
  path: string,
): Promise<void> {
  await assertContainedStatePath(capability, path, "absent-or-directory");
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  await assertContainedStatePath(capability, path, "directory");
  await syncDirectory(path);
  await syncDirectory(dirname(path));
}

async function atomicWrite(
  capability: FreshBootstrapCapability,
  path: string,
  value: string,
): Promise<void> {
  await durableDirectory(capability, dirname(path));
  await assertContainedStatePath(capability, path, "absent-or-file");
  const temporary = `${path}.${randomUUID()}.tmp`;
  await assertContainedStatePath(capability, temporary, "absent-or-file");
  const handle = await open(
    temporary,
    fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_WRONLY |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.uid !== process.geteuid?.() ||
      String(opened.dev) !== capability.stateRoot.device ||
      (opened.mode & 0o777) !== 0o600 ||
      opened.nlink !== 1
    )
      throw new Error("The durable state temporary file is unsafe.");
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await assertContainedStatePath(capability, path, "absent-or-file");
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

async function createInitialJournal(
  capability: FreshBootstrapCapability,
  path: string,
  receipt: FreshBootstrapPendingReceipt,
): Promise<void> {
  await durableDirectory(capability, dirname(path));
  await assertContainedStatePath(capability, path, "absent-or-file");
  const candidate = `${path}.${randomUUID()}.pending`;
  const handle = await open(
    candidate,
    fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_WRONLY |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.uid !== process.geteuid?.() ||
      String(opened.dev) !== capability.stateRoot.device ||
      (opened.mode & 0o777) !== 0o600 ||
      opened.nlink !== 1
    )
      throw new Error("The initial journal temporary file is unsafe.");
    await handle.writeFile(`${JSON.stringify(receipt)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(candidate, path);
    await syncDirectory(dirname(path));
  } finally {
    await unlink(candidate).catch(() => undefined);
    await syncDirectory(dirname(path));
  }
}

const lockHolder = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");
const [path, dev, ino, uid, mode, lease, expectedPriorDigest] = process.argv.slice(1);
const fd = fs.openSync(path, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
const s = fs.fstatSync(fd);
if (!s.isFile() || s.nlink !== 1 || String(s.dev) !== dev || String(s.ino) !== ino || String(s.uid) !== uid || String(s.mode & 0o777) !== mode) process.exit(74);
const priorBytes = Buffer.alloc(s.size); fs.readSync(fd, priorBytes, 0, priorBytes.length, 0);
const prior = priorBytes.toString("utf8");
if (prior.startsWith("APP_BUILDER_FRESH_BOOTSTRAP_LEASE_ACTIVE_V1:")) process.exit(73);
if (prior.startsWith("APP_BUILDER_FRESH_BOOTSTRAP_LEASE_QUIESCED_V1:")) {
  const digest = crypto.createHash("sha256").update(prior).digest("hex");
  if (expectedPriorDigest === "-" || digest !== expectedPriorDigest) process.exit(73);
} else if (prior !== "") process.exit(72);
fs.ftruncateSync(fd, 0); const leaseBytes = Buffer.from(lease); let offset = 0;
while (offset < leaseBytes.length) offset += fs.writeSync(fd, leaseBytes, offset, leaseBytes.length - offset, offset);
fs.fsyncSync(fd);
const check = Buffer.alloc(leaseBytes.length); fs.readSync(fd, check, 0, check.length, 0);
if (check.toString("utf8") !== lease) process.exit(75);
process.stdout.write("READY\n");
let command = ""; process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => command += chunk);
process.stdin.on("end", () => { if (command === "RELEASE\n") { fs.ftruncateSync(fd, 0); fs.fsyncSync(fd); } fs.closeSync(fd); });
process.stdin.resume();
`;

type Lease = {
  pid: number;
  markerDigest: string;
  assertHeld(): void;
  release(): Promise<void>;
};

async function acquireLease(
  capability: FreshBootstrapCapability,
  path: string,
  expectedPriorDigest?: string,
): Promise<Lease> {
  await durableDirectory(capability, dirname(path));
  await assertContainedStatePath(capability, path, "absent-or-file");
  try {
    const handle = await open(
      path,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.uid !== process.geteuid?.() ||
        String(opened.dev) !== capability.stateRoot.device ||
        (opened.mode & 0o777) !== 0o600 ||
        opened.nlink !== 1
      )
        throw new Error("The fresh-bootstrap lease file is unsafe.");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(dirname(path));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await assertContainedStatePath(capability, path, "absent-or-file");
  const state = await lstat(path);
  await assertExactExecutable(capability.lockHelperIdentity);
  await assertExactExecutable(capability.systemNodeIdentity);
  const helper = capability.lockHelper.endsWith("flock")
    ? { command: capability.lockHelper, args: ["-n", path] }
    : { command: capability.lockHelper, args: ["-k", "-t", "0", path] };
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
      String(state.mode & 0o777),
      marker,
      expectedPriorDigest ?? "-",
    ],
    { env: minimalEnvironment(), stdio: ["pipe", "pipe", "pipe"] },
  );
  if (holder.pid === undefined)
    throw new Error("The lease helper did not start.");
  let terminal: Error | undefined;
  let releasing = false;
  let helperError = "";
  holder.stderr.setEncoding("utf8");
  holder.stderr.on("data", (chunk: string) => {
    helperError = `${helperError}${chunk}`.slice(-2_000);
  });
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => (resolveExit = resolve));
  holder.once("error", (error) => {
    terminal = error;
    resolveExit();
  });
  holder.once("exit", (code, signal) => {
    if (terminal === undefined && (!releasing || code !== 0 || signal !== null))
      terminal = new Error(
        `The fresh-bootstrap lease was lost (code ${String(code)}, signal ${String(signal)})${helperError.trim() === "" ? "." : `: ${helperError.trim()}`}`,
      );
    resolveExit();
  });
  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      holder.kill("SIGKILL");
      rejectReady(new Error("Lease timeout."));
    }, 5_000);
    holder.stdout.setEncoding("utf8");
    holder.stdout.once("data", (chunk: string) => {
      clearTimeout(timeout);
      if (chunk === "READY\n") resolveReady();
      else rejectReady(new Error("Lease handshake failed."));
    });
    void exited.then(() => {
      clearTimeout(timeout);
      rejectReady(terminal ?? new Error("Fresh bootstrap is already leased."));
    });
  });
  let released = false;
  return {
    pid: holder.pid,
    markerDigest: createHash("sha256").update(marker).digest("hex"),
    assertHeld: () => {
      if (
        !releasing &&
        (holder.exitCode !== null || holder.signalCode !== null)
      )
        terminal ??= new Error("The fresh-bootstrap lease was lost.");
      if (terminal !== undefined) throw terminal;
    },
    release: async () => {
      if (released) return;
      released = true;
      releasing = true;
      if (terminal === undefined) holder.stdin.end("RELEASE\n");
      await exited;
      if (terminal !== undefined) throw terminal;
    },
  };
}

const quiesceHolder = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");
const [path, dev, ino, uid, mode, expectedActiveDigest, quiesced] = process.argv.slice(1);
const fd = fs.openSync(path, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
const s = fs.fstatSync(fd);
if (!s.isFile() || s.nlink !== 1 || String(s.dev) !== dev || String(s.ino) !== ino || String(s.uid) !== uid || String(s.mode & 0o777) !== mode) process.exit(74);
const priorBytes = Buffer.alloc(s.size); fs.readSync(fd, priorBytes, 0, priorBytes.length, 0);
const prior = priorBytes.toString("utf8");
if (!prior.startsWith("APP_BUILDER_FRESH_BOOTSTRAP_LEASE_ACTIVE_V1:") || crypto.createHash("sha256").update(prior).digest("hex") !== expectedActiveDigest) process.exit(73);
fs.ftruncateSync(fd, 0); const bytes = Buffer.from(quiesced); let offset = 0;
while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
fs.fsyncSync(fd);
const check = Buffer.alloc(bytes.length); fs.readSync(fd, check, 0, check.length, 0);
if (check.toString("utf8") !== quiesced) process.exit(75);
process.stdout.write("READY\n");
process.stdin.resume(); process.stdin.on("end", () => fs.closeSync(fd));
`;

async function quiesceAbandonedLease(
  capability: FreshBootstrapCapability,
  path: string,
  expectedActiveDigest: string,
): Promise<{ markerDigest: string; release(): Promise<void> }> {
  await assertContainedStatePath(capability, path, "absent-or-file");
  const state = await lstat(path);
  await assertExactExecutable(capability.lockHelperIdentity);
  await assertExactExecutable(capability.systemNodeIdentity);
  const helper = capability.lockHelper.endsWith("flock")
    ? { command: capability.lockHelper, args: ["-n", path] }
    : { command: capability.lockHelper, args: ["-k", "-t", "0", path] };
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
      String(state.mode & 0o777),
      expectedActiveDigest,
      marker,
    ],
    { env: minimalEnvironment(), stdio: ["pipe", "pipe", "pipe"] },
  );
  if (holder.pid === undefined)
    throw new Error("The quiescence helper did not start.");
  let stderr = "";
  holder.stderr.setEncoding("utf8");
  holder.stderr.on("data", (chunk: string) => (stderr += chunk));
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => (resolveExit = resolve));
  holder.once("exit", resolveExit);
  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      holder.kill("SIGKILL");
      rejectReady(new Error("Lease quiescence timeout."));
    }, 5_000);
    holder.stdout.setEncoding("utf8");
    holder.stdout.once("data", (chunk: string) => {
      clearTimeout(timeout);
      if (chunk === "READY\n") resolveReady();
      else rejectReady(new Error("Lease quiescence handshake failed."));
    });
    void exited.then(() => {
      clearTimeout(timeout);
      rejectReady(
        new Error(
          `Lease quiescence failed${stderr.trim() === "" ? "." : `: ${stderr.trim()}`}`,
        ),
      );
    });
  });
  let released = false;
  return {
    markerDigest: createHash("sha256").update(marker).digest("hex"),
    release: async () => {
      if (released) return;
      released = true;
      holder.stdin.end();
      await exited;
      if (holder.exitCode !== 0)
        throw new Error("The quiescence helper exited abnormally.");
    },
  };
}

const blobId = (bytes: Uint8Array) =>
  createHash("sha1")
    .update(Buffer.from(`blob ${bytes.byteLength}\0`))
    .update(bytes)
    .digest("hex");

function exactSourceTree(
  capability: FreshBootstrapCapability,
  sourcePath: string,
  sourceSha: string,
): ExactFile[] {
  const output = gitBuffer(capability, sourcePath, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    sourceSha,
  ]);
  const files: ExactFile[] = [];
  for (const record of output.toString("utf8").split("\0").filter(Boolean)) {
    const match =
      /^(100644|100755|120000|160000) (blob|commit) ([0-9a-f]{40})\t(.+)$/u.exec(
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
        .some((part) =>
          [".git", ".repository-bootstrap-claim"].includes(part.toLowerCase()),
        )
    )
      throw new Error(
        "Fresh bootstrap rejects submodules, symlinks, reserved names, and unsafe paths.",
      );
    const bytes = gitBuffer(capability, sourcePath, [
      "cat-file",
      "blob",
      match[3],
    ]);
    files.push({
      path: match[4],
      mode: match[1] as FreshBootstrapFile["mode"],
      blob: match[3],
      bytes,
    });
  }
  return files.toSorted((left, right) =>
    Buffer.from(left.path).compare(Buffer.from(right.path)),
  );
}

async function exactResultTree(input: {
  capability: FreshBootstrapCapability;
  sourceReceipt: SourceReceipt;
  review: ReviewedChangeSetReceipt;
  readOverlayFile(path: string): Promise<Uint8Array | null>;
}): Promise<ExactFile[]> {
  assertExactReviewedChangeSet(input.review);
  const current = await inspectSourceReceipt(
    input.sourceReceipt.sourceKind,
    input.sourceReceipt.sourcePath,
  );
  if (current.digest !== input.sourceReceipt.digest)
    throw new Error("The fresh-template source changed after review.");
  const files = new Map(
    exactSourceTree(
      input.capability,
      input.sourceReceipt.sourcePath,
      input.sourceReceipt.sourceSha,
    ).map((file) => [file.path, file]),
  );
  for (const change of input.review.changes) {
    if (
      change.path
        .split("/")
        .some((part) =>
          [".git", ".repository-bootstrap-claim"].includes(part.toLowerCase()),
        )
    )
      throw new Error("The reviewed bootstrap change uses a reserved path.");
    const before = files.get(change.path);
    if (
      change.before === undefined
        ? before !== undefined
        : before === undefined ||
          before.mode !== `100${change.before.mode}` ||
          contentDigest(before.bytes) !== change.before.digest
    )
      throw new Error(
        `The reviewed bootstrap preimage is stale at ${change.path}.`,
      );
    if (change.after === undefined) {
      files.delete(change.path);
      continue;
    }
    const bytes = await input.readOverlayFile(change.path);
    if (bytes === null || contentDigest(bytes) !== change.after.digest)
      throw new Error(
        `The reviewed bootstrap overlay is stale at ${change.path}.`,
      );
    const buffer = Buffer.from(bytes);
    files.set(change.path, {
      path: change.path,
      mode: `100${change.after.mode}` as FreshBootstrapFile["mode"],
      blob: blobId(buffer),
      bytes: buffer,
    });
  }
  return [...files.values()].toSorted((left, right) =>
    Buffer.from(left.path).compare(Buffer.from(right.path)),
  );
}

async function assertNoLinkRoute(
  root: PathIdentity,
  destination: string,
): Promise<void> {
  if (!within(root.path, destination) || destination === root.path)
    throw new Error("The bootstrap destination is outside its allowed root.");
  let cursor = root.path;
  for (const part of relative(root.path, dirname(destination)).split(sep)) {
    if (part === "") continue;
    cursor = resolve(cursor, part);
    const value = await lstat(cursor);
    if (
      value.isSymbolicLink() ||
      !value.isDirectory() ||
      value.uid !== process.geteuid?.() ||
      value.dev.toString() !== root.device ||
      (value.mode & 0o022) !== 0 ||
      (await realpath(cursor)) !== cursor
    )
      throw new Error("The bootstrap destination traverses an unsafe path.");
  }
}

async function inspectDestinationPrestate(input: {
  capability: FreshBootstrapCapability;
  destinationPath: string;
  expected: "absent" | "empty-directory";
  protectedPaths: readonly string[];
}): Promise<FreshBootstrapPrestate> {
  if (!isAbsolute(input.destinationPath))
    throw new Error("The fresh-bootstrap destination must be absolute.");
  const destination = resolve(input.destinationPath);
  await assertNoLinkRoute(input.capability.allowedRoot, destination);
  const parent = await identity(dirname(destination));
  if (
    parent.device !== input.capability.allowedRoot.device ||
    input.protectedPaths.some((path) => pathsOverlap(destination, path)) ||
    pathsOverlap(destination, input.capability.stateRoot.path)
  )
    throw new Error("The bootstrap destination overlaps protected state.");
  let value;
  try {
    value = await lstat(destination);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (input.expected !== "absent")
      throw new Error("The expected empty destination is absent.");
    return { kind: "absent", destinationPath: destination, parent };
  }
  if (
    input.expected !== "empty-directory" ||
    value.isSymbolicLink() ||
    !value.isDirectory() ||
    value.uid !== process.geteuid?.() ||
    value.dev.toString() !== input.capability.allowedRoot.device ||
    (value.mode & 0o777) !== 0o700 ||
    (await realpath(destination)) !== destination ||
    (await readdir(destination)).length !== 0
  )
    throw new Error("The fresh-bootstrap destination is not exact-empty.");
  return {
    kind: "empty-directory",
    destination: await identity(destination),
    parent,
  };
}

function manifest(files: readonly ExactFile[]): FreshBootstrapFile[] {
  return files.map(({ path, mode, blob }) => ({ path, mode, blob }));
}

export async function deriveFreshBootstrapProposal(input: {
  capability?: FreshBootstrapCapability;
  destinationPath: string;
  expectedPrestate: "absent" | "empty-directory";
  repositoryIdentity: FreshBootstrapIdentity;
  sourceReceipt: SourceReceipt;
  review: ReviewedChangeSetReceipt;
  protectedPaths: readonly string[];
  readOverlayFile(path: string): Promise<Uint8Array | null>;
}): Promise<FreshBootstrapProposal> {
  const capability = await assertCapability(input.capability);
  const sourceGit = await realpath(
    git(capability, input.sourceReceipt.sourcePath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]).trim(),
  );
  const protectedPaths = [
    ...input.protectedPaths,
    input.sourceReceipt.sourcePath,
    sourceGit,
    process.cwd(),
  ].map((path) => resolve(path));
  if (
    protectedPaths.some(
      (path) =>
        pathsOverlap(capability.stateRoot.path, path) ||
        pathsOverlap(capability.allowedRoot.path, path),
    )
  )
    throw new Error(
      "Bootstrap state and destination roots overlap builder or source authority.",
    );
  const destinationPrestate = await inspectDestinationPrestate({
    capability,
    destinationPath: input.destinationPath,
    expected: input.expectedPrestate,
    protectedPaths,
  });
  const files = await exactResultTree({
    capability,
    sourceReceipt: input.sourceReceipt,
    review: input.review,
    readOverlayFile: input.readOverlayFile,
  });
  const placeholder = resolve(capability.stateRoot.path, "pending");
  const destinationLockDigest = stableDigest({
    allowedRoot: capability.allowedRoot,
    destinationPath: resolve(input.destinationPath),
  });
  const preliminary = createFreshBootstrapProposal({
    capability,
    destinationPath: resolve(input.destinationPath),
    stagingPath: resolve(dirname(input.destinationPath), ".pending.stage"),
    atomicAdapterDigest: FRESH_BOOTSTRAP_ATOMIC_ADAPTER_DIGEST,
    materializeAdapterDigest: FRESH_BOOTSTRAP_MATERIALIZE_ADAPTER_DIGEST,
    journalPath: placeholder,
    lockPath: resolve(
      capability.stateRoot.path,
      "locks",
      `${destinationLockDigest}.lock`,
    ),
    destinationPrestate,
    sourceReceipt: input.sourceReceipt,
    review: input.review,
    repositoryIdentity: input.repositoryIdentity,
    exactTree: manifest(files),
  });
  const proposal = createFreshBootstrapProposal({
    capability,
    destinationPath: resolve(input.destinationPath),
    stagingPath: resolve(
      dirname(input.destinationPath),
      `.${basename(input.destinationPath)}.repository-bootstrap-${preliminary.publicationIdentityDigest}.stage`,
    ),
    atomicAdapterDigest: FRESH_BOOTSTRAP_ATOMIC_ADAPTER_DIGEST,
    materializeAdapterDigest: FRESH_BOOTSTRAP_MATERIALIZE_ADAPTER_DIGEST,
    journalPath: resolve(
      capability.stateRoot.path,
      "journals",
      `${preliminary.publicationIdentityDigest}.json`,
    ),
    lockPath: resolve(
      capability.stateRoot.path,
      "locks",
      `${destinationLockDigest}.lock`,
    ),
    destinationPrestate,
    sourceReceipt: input.sourceReceipt,
    review: input.review,
    repositoryIdentity: input.repositoryIdentity,
    exactTree: manifest(files),
  });
  if ((await pathState(proposal.stagingPath)) !== "absent")
    throw new Error("The deterministic bootstrap stage is not absent.");
  return proposal;
}

async function assertExactInputs(input: {
  capability: FreshBootstrapCapability;
  proposal: FreshBootstrapProposal;
  sourceReceipt: SourceReceipt;
  review: ReviewedChangeSetReceipt;
  readOverlayFile(path: string): Promise<Uint8Array | null>;
}): Promise<ExactFile[]> {
  assertExactFreshBootstrapProposal(input.proposal);
  if (
    input.proposal.atomicAdapterDigest !==
      FRESH_BOOTSTRAP_ATOMIC_ADAPTER_DIGEST ||
    input.proposal.materializeAdapterDigest !==
      FRESH_BOOTSTRAP_MATERIALIZE_ADAPTER_DIGEST ||
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
        stateRoot: input.capability.stateRoot,
        allowedRoot: input.capability.allowedRoot,
        systemGit: input.capability.systemGit,
        systemPython: input.capability.systemPython,
        systemGitIdentity: input.capability.systemGitIdentity,
        systemPythonIdentity: input.capability.systemPythonIdentity,
        systemNode: input.capability.systemNode,
        systemNodeIdentity: input.capability.systemNodeIdentity,
        lockHelper: input.capability.lockHelper,
        lockHelperIdentity: input.capability.lockHelperIdentity,
      })
  )
    throw new Error("The exact fresh-bootstrap inputs changed after approval.");
  const files = await exactResultTree({
    capability: input.capability,
    sourceReceipt: input.sourceReceipt,
    review: input.review,
    readOverlayFile: input.readOverlayFile,
  });
  if (stableDigest(manifest(files)) !== input.proposal.exactTreeDigest)
    throw new Error("The exact bootstrap tree changed after approval.");
  return files;
}

async function assertSourceUnchanged(
  sourceReceipt: SourceReceipt,
): Promise<void> {
  const current = await inspectSourceReceipt(
    sourceReceipt.sourceKind,
    sourceReceipt.sourcePath,
  );
  if (current.digest !== sourceReceipt.digest)
    throw new Error(
      "The fresh-template source changed across bootstrap mutation.",
    );
}

async function assertPrestate(
  capability: FreshBootstrapCapability,
  proposal: FreshBootstrapProposal,
): Promise<void> {
  await assertExactIdentity(capability.allowedRoot, "directory");
  await assertNoLinkRoute(capability.allowedRoot, proposal.destinationPath);
  const parent = await identity(dirname(proposal.destinationPath));
  if (
    JSON.stringify(parent) !==
    JSON.stringify(proposal.destinationPrestate.parent)
  )
    throw new Error("The destination parent changed after approval.");
  let destination;
  try {
    destination = await lstat(proposal.destinationPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (proposal.destinationPrestate.kind !== "absent")
      throw new Error("The approved empty destination disappeared.");
    return;
  }
  if (proposal.destinationPrestate.kind !== "empty-directory")
    throw new Error("The approved absent destination now exists.");
  if (
    destination.isSymbolicLink() ||
    !destination.isDirectory() ||
    (await realpath(proposal.destinationPath)) !== proposal.destinationPath ||
    JSON.stringify(await identity(proposal.destinationPath)) !==
      JSON.stringify(proposal.destinationPrestate.destination) ||
    (await readdir(proposal.destinationPath)).length !== 0
  )
    throw new Error("The approved empty destination changed.");
}

async function markerContent(
  proposal: FreshBootstrapProposal,
): Promise<Buffer> {
  return Buffer.from(
    `APP_BUILDER_REPOSITORY_BOOTSTRAP_CLAIM_V1:${proposal.digest}\n`,
  );
}

async function createStage(
  capability: FreshBootstrapCapability,
  proposal: FreshBootstrapProposal,
): Promise<void> {
  await assertNoLinkRoute(capability.allowedRoot, proposal.stagingPath);
  try {
    await mkdir(proposal.stagingPath, { mode: 0o700 });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("The deterministic bootstrap stage already exists.");
    throw error;
  }
  const stageState = await lstat(proposal.stagingPath);
  if (
    !stageState.isDirectory() ||
    stageState.isSymbolicLink() ||
    stageState.uid !== process.geteuid?.() ||
    String(stageState.dev) !== capability.allowedRoot.device ||
    (stageState.mode & 0o777) !== 0o700
  )
    throw new Error("The newly created bootstrap stage is unsafe.");
  const marker = resolve(proposal.stagingPath, proposal.claimMarkerName);
  const handle = await open(
    marker,
    fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_WRONLY |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    const markerState = await handle.stat();
    if (
      !markerState.isFile() ||
      markerState.uid !== process.geteuid?.() ||
      markerState.dev !== stageState.dev ||
      (markerState.mode & 0o777) !== 0o600 ||
      markerState.nlink !== 1
    )
      throw new Error("The bootstrap stage marker is unsafe.");
    await handle.writeFile(await markerContent(proposal));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(proposal.stagingPath);
  await syncDirectory(dirname(proposal.stagingPath));
}

async function materializeFile(
  capability: FreshBootstrapCapability,
  proposal: FreshBootstrapProposal,
  file: ExactFile,
  recovery: boolean,
  stageIdentity: PathIdentity,
): Promise<void> {
  await assertExactExecutable(capability.systemPythonIdentity);
  const stage = await open(
    proposal.stagingPath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const opened = await stage.stat();
    if (
      !opened.isDirectory() ||
      String(opened.dev) !== stageIdentity.device ||
      String(opened.ino) !== stageIdentity.inode ||
      String(opened.uid) !== stageIdentity.uid ||
      (opened.mode & 0o777).toString(8) !== stageIdentity.mode
    )
      throw new Error(
        "The fd-bound bootstrap stage changed after its durable layout receipt.",
      );
    const result = spawnSync(
      capability.systemPython,
      [
        "-I",
        "-c",
        materializeAdapter,
        file.path,
        file.mode,
        file.blob,
        recovery ? "1" : "0",
      ],
      {
        env: minimalEnvironment(),
        input: file.bytes,
        encoding: "utf8",
        maxBuffer: Math.max(1024 * 1024, file.bytes.length + 64 * 1024),
        timeout: 30_000,
        stdio: ["pipe", "pipe", "pipe", stage.fd],
      },
    );
    if (result.status !== 0)
      throw new Error(`Fd-bound materialization failed at ${file.path}.`);
  } finally {
    await stage.close();
  }
}

async function initializeGit(input: {
  capability: FreshBootstrapCapability;
  proposal: FreshBootstrapProposal;
  files: readonly ExactFile[];
  hooks?: FreshBootstrapFaultHooks;
  recovery: boolean;
}): Promise<void> {
  const gitDirectory = resolve(input.proposal.stagingPath, ".git");
  let initialized = false;
  try {
    const value = await lstat(gitDirectory);
    initialized = value.isDirectory() && !value.isSymbolicLink();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
      resolve(gitDirectory, "config"),
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
    throw new Error("The fresh repository did not use SHA-1 object format.");
  if (
    git(input.capability, input.proposal.stagingPath, [
      "rev-parse",
      "--show-ref-format",
    ]).trim() !== "files"
  )
    throw new Error("The fresh repository did not use files ref format.");
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
    if (observed !== file.blob)
      throw new Error(`Git blob identity changed at ${file.path}.`);
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
  const tree = git(input.capability, input.proposal.stagingPath, [
    "write-tree",
  ]).trim();
  if (tree !== input.proposal.expectedGitTree)
    throw new Error("Git wrote a different bootstrap tree.");
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
    throw new Error("Git wrote a different parentless initial commit.");
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
    git(input.capability, input.proposal.stagingPath, [
      "update-ref",
      ref,
      commit,
      "0".repeat(40),
    ]);
  else if (!input.recovery || currentRef !== commit)
    throw new Error("Recovery found a conflicting initial branch.");
  git(input.capability, input.proposal.stagingPath, [
    "symbolic-ref",
    "HEAD",
    ref,
  ]);
  await input.hooks?.afterGitCommit?.();
}

async function assertRawGitAuthority(
  proposal: FreshBootstrapProposal,
  root: string,
): Promise<void> {
  const rootState = await lstat(root);
  const gitDirectory = resolve(root, ".git");
  const gitState = await lstat(gitDirectory);
  if (
    rootState.isSymbolicLink() ||
    !rootState.isDirectory() ||
    gitState.isSymbolicLink() ||
    !gitState.isDirectory() ||
    rootState.uid !== process.geteuid?.() ||
    gitState.uid !== process.geteuid?.() ||
    rootState.dev !== gitState.dev ||
    (rootState.mode & 0o022) !== 0 ||
    (gitState.mode & 0o022) !== 0 ||
    (await realpath(root)) !== root ||
    (await realpath(gitDirectory)) !== gitDirectory ||
    (await readFile(resolve(gitDirectory, "config"), "utf8")) !==
      exactGitConfig ||
    (await readFile(resolve(gitDirectory, "HEAD"), "utf8")) !==
      `ref: refs/heads/${proposal.repositoryIdentity.initialBranch}\n`
  )
    throw new Error(
      "The fresh repository Git authority is not local and exact.",
    );
  for (const forbidden of [
    resolve(gitDirectory, "commondir"),
    resolve(gitDirectory, "gitdir"),
    resolve(gitDirectory, "hooks"),
    resolve(gitDirectory, "objects", "info", "alternates"),
    resolve(gitDirectory, "objects", "info", "http-alternates"),
    resolve(gitDirectory, "info", "grafts"),
    resolve(gitDirectory, "refs", "replace"),
    resolve(gitDirectory, "shallow"),
  ]) {
    try {
      await lstat(forbidden);
      throw new Error("The fresh repository contains forbidden Git authority.");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function rawWorktreeManifest(
  root: string,
  proposal: FreshBootstrapProposal,
  allowClaimMarker: boolean,
): Promise<FreshBootstrapFile[]> {
  const rootState = await lstat(root);
  const output: FreshBootstrapFile[] = [];
  const directories = new Set<string>();
  const walk = async (relativePath: string): Promise<void> => {
    const directory = relativePath === "" ? root : resolve(root, relativePath);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path =
        relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
      if (path === ".git") continue;
      if (allowClaimMarker && path === proposal.claimMarkerName) continue;
      if (!safeSourcePath(path))
        throw new Error("The fresh repository contains an unsafe raw path.");
      const absolute = resolve(root, path);
      const state = await lstat(absolute);
      if (
        state.isSymbolicLink() ||
        state.uid !== process.geteuid?.() ||
        state.dev !== rootState.dev ||
        (state.mode & 0o022) !== 0
      )
        throw new Error("The fresh repository raw tree is unsafe.");
      if (state.isDirectory()) {
        if ((state.mode & 0o777) !== 0o755)
          throw new Error(
            "The fresh repository contains a directory with an unexpected mode.",
          );
        directories.add(path);
        await walk(path);
        continue;
      }
      if (!state.isFile() || state.nlink !== 1)
        throw new Error("The fresh repository contains a special raw entry.");
      const bytes = await readFile(absolute);
      const exactMode = (state.mode & 0o777).toString(8);
      if (exactMode !== "644" && exactMode !== "755")
        throw new Error(
          "The fresh repository contains a file with an unexpected mode.",
        );
      output.push({
        path,
        mode: (state.mode & 0o111) === 0 ? "100644" : "100755",
        blob: blobId(bytes),
      });
    }
  };
  await walk("");
  const expectedDirectories = new Set<string>();
  for (const file of proposal.exactTree) {
    const parts = file.path.split("/");
    for (let index = 1; index < parts.length; index += 1)
      expectedDirectories.add(parts.slice(0, index).join("/"));
  }
  if (
    JSON.stringify([...directories].toSorted()) !==
    JSON.stringify([...expectedDirectories].toSorted())
  )
    throw new Error(
      "The fresh repository contains an unexpected raw directory.",
    );
  return output.toSorted((left, right) =>
    Buffer.from(left.path).compare(Buffer.from(right.path)),
  );
}

async function assertExactRepository(
  capability: FreshBootstrapCapability,
  proposal: FreshBootstrapProposal,
  root: string,
  options: { allowClaimMarker?: boolean } = {},
): Promise<{
  destinationIdentity: PathIdentity;
  gitDirectoryIdentity: PathIdentity;
  remoteDigest: string;
  worktreeDigest: string;
}> {
  const gitDirectory = resolve(root, ".git");
  await assertRawGitAuthority(proposal, root);
  const destinationIdentity = await identity(root);
  const gitDirectoryIdentity = await identity(gitDirectory);
  const ref = `refs/heads/${proposal.repositoryIdentity.initialBranch}`;
  const rawManifest = await rawWorktreeManifest(
    root,
    proposal,
    options.allowClaimMarker === true,
  );
  const absoluteGitDirectory = await realpath(
    git(capability, root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
    ]).trim(),
  );
  const absoluteCommonDirectory = await realpath(
    git(capability, root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]).trim(),
  );
  const remotes = git(capability, root, ["remote"]).split("\n").filter(Boolean);
  const refs = git(capability, root, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)",
  ])
    .split("\n")
    .filter(Boolean);
  const parents = git(capability, root, [
    "rev-list",
    "--parents",
    "--max-count=1",
    "HEAD",
  ]).trim();
  const paths = gitBuffer(capability, root, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    "HEAD",
  ]);
  const observed = paths
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/u.exec(record);
      if (match === null || !safeSourcePath(match[3]))
        throw new Error("The final repository tree is malformed.");
      return { path: match[3], mode: match[1], blob: match[2] };
    });
  const reachableObjects = new Set(
    git(capability, root, ["rev-list", "--objects", "--all"])
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" ", 1)[0]),
  );
  const objectDirectory = resolve(gitDirectory, "objects");
  const looseObjects = new Set<string>();
  for (const entry of await readdir(objectDirectory, { withFileTypes: true })) {
    if (entry.name === "info" || entry.name === "pack") {
      if (
        !entry.isDirectory() ||
        (await readdir(resolve(objectDirectory, entry.name))).length !== 0
      )
        throw new Error(
          "The fresh repository contains unexpected packed or object authority.",
        );
      continue;
    }
    if (!entry.isDirectory() || !/^[0-9a-f]{2}$/u.test(entry.name))
      throw new Error(
        "The fresh repository contains malformed object storage.",
      );
    for (const object of await readdir(resolve(objectDirectory, entry.name))) {
      if (!/^[0-9a-f]{38}$/u.test(object))
        throw new Error(
          "The fresh repository contains malformed loose objects.",
        );
      looseObjects.add(`${entry.name}${object}`);
    }
  }
  if (
    git(capability, root, ["rev-parse", "--show-object-format"]).trim() !==
      "sha1" ||
    absoluteGitDirectory !== gitDirectory ||
    absoluteCommonDirectory !== gitDirectory ||
    git(capability, root, ["rev-parse", "--show-ref-format"]).trim() !==
      "files" ||
    git(capability, root, ["symbolic-ref", "HEAD"]).trim() !== ref ||
    git(capability, root, ["rev-parse", "HEAD"]).trim() !==
      proposal.expectedInitialCommit ||
    git(capability, root, ["rev-parse", "HEAD^{tree}"]).trim() !==
      proposal.expectedGitTree ||
    parents !== proposal.expectedInitialCommit ||
    git(capability, root, ["rev-list", "--count", "HEAD"]).trim() !== "1" ||
    remotes.length !== 0 ||
    JSON.stringify(refs) !==
      JSON.stringify([`${ref}\0${proposal.expectedInitialCommit}`]) ||
    JSON.stringify([...looseObjects].toSorted()) !==
      JSON.stringify([...reachableObjects].toSorted()) ||
    git(capability, root, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]).trim() !==
      (options.allowClaimMarker ? `?? ${proposal.claimMarkerName}` : "") ||
    JSON.stringify(observed) !== JSON.stringify(proposal.exactTree) ||
    JSON.stringify(rawManifest) !== JSON.stringify(proposal.exactTree)
  )
    throw new Error("The final fresh repository failed exact verification.");
  for (const forbidden of [
    resolve(gitDirectory, "objects", "info", "alternates"),
    resolve(gitDirectory, "info", "grafts"),
    resolve(gitDirectory, "refs", "replace"),
  ]) {
    try {
      await lstat(forbidden);
      throw new Error("The final repository contains forbidden Git authority.");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return {
    destinationIdentity,
    gitDirectoryIdentity,
    remoteDigest: stableDigest(remotes),
    worktreeDigest: stableDigest(observed),
  };
}

async function atomicPublish(
  capability: FreshBootstrapCapability,
  proposal: FreshBootstrapProposal,
  hooks?: FreshBootstrapFaultHooks,
): Promise<void> {
  const parentPath = dirname(proposal.destinationPath);
  const parent = await open(
    parentPath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const parentState = await parent.stat();
    if (
      String(parentState.dev) !== proposal.destinationPrestate.parent.device ||
      String(parentState.ino) !== proposal.destinationPrestate.parent.inode
    )
      throw new Error(
        "The destination parent changed before atomic publication.",
      );
    const stageState = await lstat(proposal.stagingPath);
    const originalEmpty =
      proposal.destinationPrestate.kind === "empty-directory"
        ? await lstat(proposal.destinationPath)
        : undefined;
    const result = spawnSync(
      capability.systemPython,
      [
        "-I",
        "-c",
        atomicPublicationAdapter,
        proposal.destinationPrestate.kind === "absent"
          ? "noreplace"
          : hooks?.afterAtomicSwap === undefined
            ? "exchange"
            : "exchange-hold",
        basename(proposal.stagingPath),
        basename(proposal.destinationPath),
        String(stageState.dev),
        String(stageState.ino),
        originalEmpty === undefined ? "-" : String(originalEmpty.dev),
        originalEmpty === undefined ? "-" : String(originalEmpty.ino),
      ],
      {
        env: minimalEnvironment(),
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe", parent.fd],
      },
    );
    if (result.status !== 0)
      throw new Error(
        `Atomic no-replace publication failed${result.stderr.trim() === "" ? "." : `: ${result.stderr.trim()}`}`,
      );
    const destination = await lstat(proposal.destinationPath);
    if (
      destination.dev !== stageState.dev ||
      destination.ino !== stageState.ino
    )
      throw new Error(
        "Atomic publication did not install the exact stage inode.",
      );
    await hooks?.afterAtomicSwap?.();
    if (
      originalEmpty !== undefined &&
      ((await pathState(proposal.stagingPath)) !== "directory" ||
        JSON.stringify(await identity(proposal.stagingPath)) !==
          JSON.stringify(
            proposal.destinationPrestate.kind === "empty-directory"
              ? {
                  ...proposal.destinationPrestate.destination,
                  path: proposal.stagingPath,
                }
              : undefined,
          ) ||
        (await readdir(proposal.stagingPath)).length !== 0)
    )
      throw new Error(
        "Atomic exchange did not retain the exact old empty inode as a tombstone.",
      );
  } finally {
    await parent.close();
  }
}

async function removeVerifiedSwappedEmptyDirectory(
  capability: FreshBootstrapCapability,
  proposal: FreshBootstrapProposal,
): Promise<void> {
  if (proposal.destinationPrestate.kind !== "empty-directory") return;
  const state = await pathState(proposal.stagingPath);
  if (state === "absent") return;
  if (state !== "directory")
    throw new Error("Recovery found an invalid swapped-out destination.");
  if (
    JSON.stringify(await identity(proposal.stagingPath)) !==
      JSON.stringify({
        ...proposal.destinationPrestate.destination,
        path: proposal.stagingPath,
      }) ||
    (await readdir(proposal.stagingPath)).length !== 0
  )
    throw new Error("Recovery found a changed swapped-out tombstone.");
}

function pendingReceipt(
  proposal: FreshBootstrapProposal,
  publishedByCallId: string,
  recoveryOfDigest: string | undefined,
  leaseMarkerDigest: string,
  previousLeaseMarkerDigest: string | undefined,
  layout: FreshBootstrapLayout,
): FreshBootstrapPendingReceipt {
  const { digest: proposalDigest, ...proposalFields } = proposal;
  const unsigned = {
    ...proposalFields,
    proposalDigest,
    status: "pending" as const,
    publishedByCallId,
    leaseMarkerDigest,
    ...(recoveryOfDigest === undefined ? {} : { recoveryOfDigest }),
    ...(previousLeaseMarkerDigest === undefined
      ? {}
      : { previousLeaseMarkerDigest }),
    layout,
    stageCreated: layout.phase !== "intent",
    destinationPublished: layout.phase === "published",
  };
  return { ...unsigned, digest: freshBootstrapJournalDigest(unsigned) };
}

function failureReceipt(input: {
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
}): FreshBootstrapFailureReceipt {
  const { digest: proposalDigest, ...proposalFields } = input.proposal;
  const unsigned = {
    ...proposalFields,
    proposalDigest,
    status: "failed" as const,
    publishedByCallId: input.publishedByCallId,
    leaseMarkerDigest: input.leaseMarkerDigest,
    ...(input.recoveryOfDigest === undefined
      ? {}
      : { recoveryOfDigest: input.recoveryOfDigest }),
    ...(input.previousLeaseMarkerDigest === undefined
      ? {}
      : { previousLeaseMarkerDigest: input.previousLeaseMarkerDigest }),
    reason: input.reason,
    failureMessage: input.failureMessage,
    layout: input.layout,
    stageCreated: input.stageCreated,
    destinationPublished: input.destinationPublished,
    recoveryRequired: true as const,
  };
  return { ...unsigned, digest: freshBootstrapJournalDigest(unsigned) };
}

function successReceipt(input: {
  proposal: FreshBootstrapProposal;
  publishedByCallId: string;
  recoveryOfDigest?: string;
  leaseMarkerDigest: string;
  previousLeaseMarkerDigest?: string;
  verification: Awaited<ReturnType<typeof assertExactRepository>>;
  swappedOldIdentity?: PathIdentity;
}): FreshBootstrapSuccessReceipt {
  const { digest: proposalDigest, ...proposalFields } = input.proposal;
  const unsigned = {
    ...proposalFields,
    proposalDigest,
    status: "succeeded" as const,
    publishedByCallId: input.publishedByCallId,
    leaseMarkerDigest: input.leaseMarkerDigest,
    ...(input.recoveryOfDigest === undefined
      ? {}
      : { recoveryOfDigest: input.recoveryOfDigest }),
    ...(input.previousLeaseMarkerDigest === undefined
      ? {}
      : { previousLeaseMarkerDigest: input.previousLeaseMarkerDigest }),
    destinationIdentity: input.verification.destinationIdentity,
    gitDirectoryIdentity: input.verification.gitDirectoryIdentity,
    ...(input.swappedOldIdentity === undefined
      ? {}
      : { swappedOldIdentity: input.swappedOldIdentity }),
    headReference: `refs/heads/${input.proposal.repositoryIdentity.initialBranch}`,
    headCommit: input.proposal.expectedInitialCommit,
    headTree: input.proposal.expectedGitTree,
    commitCount: 1 as const,
    remoteDigest: input.verification.remoteDigest,
    worktreeDigest: input.verification.worktreeDigest,
    recoveryRequired: false as const,
  };
  return { ...unsigned, digest: freshBootstrapJournalDigest(unsigned) };
}

async function pathState(
  path: string,
): Promise<"absent" | "directory" | "other"> {
  try {
    const value = await lstat(path);
    return value.isDirectory() && !value.isSymbolicLink()
      ? "directory"
      : "other";
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

export async function readFreshBootstrapJournal(input: {
  capability?: FreshBootstrapCapability;
  proposal: FreshBootstrapProposal;
}): Promise<FreshBootstrapJournal | undefined> {
  const capability = await assertCapability(input.capability);
  assertExactFreshBootstrapProposal(input.proposal);
  if (
    input.proposal.journalPath !==
    resolve(
      capability.stateRoot.path,
      "journals",
      `${input.proposal.publicationIdentityDigest}.json`,
    )
  )
    throw new Error("The fresh-bootstrap journal path is not identity-bound.");
  await assertContainedStatePath(
    capability,
    input.proposal.journalPath,
    "absent-or-file",
  );
  let bytes;
  try {
    bytes = await readFile(input.proposal.journalPath, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = JSON.parse(bytes) as FreshBootstrapJournal;
  assertCanonicalFreshBootstrapJournal(parsed);
  if (
    !exactFreshBootstrapProposalMatch(
      proposalFromFreshBootstrapJournal(parsed),
      input.proposal,
    )
  )
    throw new Error("The bootstrap journal belongs to another proposal.");
  return parsed;
}

async function executeBootstrap(input: {
  capability?: FreshBootstrapCapability;
  proposal: FreshBootstrapProposal;
  sourceReceipt: SourceReceipt;
  review: ReviewedChangeSetReceipt;
  publishedByCallId: string;
  recoveryOfDigest?: string;
  readOverlayFile(path: string): Promise<Uint8Array | null>;
  hooks?: FreshBootstrapFaultHooks;
}): Promise<
  | { ok: true; receipt: FreshBootstrapSuccessReceipt }
  | { ok: false; receipt: FreshBootstrapFailureReceipt }
> {
  const capability = await assertCapability(input.capability);
  const files = await assertExactInputs({ ...input, capability });
  let existingJournal = await readFreshBootstrapJournal({
    capability,
    proposal: input.proposal,
  });
  if (input.recoveryOfDigest === undefined && existingJournal !== undefined)
    throw new Error("Fresh bootstrap already has a durable journal.");
  if (
    input.recoveryOfDigest !== undefined &&
    (existingJournal === undefined ||
      existingJournal.digest !== input.recoveryOfDigest)
  )
    throw new Error(
      "Fresh-bootstrap recovery requires the exact journal digest.",
    );
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
    throw new Error(
      "The fresh-bootstrap journal changed while acquiring the destination lease.",
    );
  }
  existingJournal = lockedJournal;
  try {
    if (
      existingJournal !== undefined &&
      existingJournal.status !== "succeeded"
    ) {
      const layout = existingJournal.layout;
      if (layout.phase === "intent") {
        if ((await pathState(input.proposal.stagingPath)) !== "absent")
          throw new Error(
            "The intent journal no longer matches the bootstrap stage.",
          );
      } else if (
        layout.phase === "stage-owned" ||
        layout.phase === "stage-ready"
      ) {
        if (
          (await pathState(input.proposal.stagingPath)) !== "directory" ||
          JSON.stringify(await identity(input.proposal.stagingPath)) !==
            JSON.stringify(layout.stageIdentity)
        )
          throw new Error(
            "The bootstrap stage no longer matches its durable layout receipt.",
          );
      } else {
        if (
          (await pathState(input.proposal.destinationPath)) !== "directory" ||
          JSON.stringify(await identity(input.proposal.destinationPath)) !==
            JSON.stringify(layout.destinationIdentity)
        )
          throw new Error(
            "The destination no longer matches its durable published layout receipt.",
          );
        if (
          layout.swappedOldIdentity !== undefined &&
          ((await pathState(input.proposal.stagingPath)) !== "directory" ||
            JSON.stringify(await identity(input.proposal.stagingPath)) !==
              JSON.stringify(layout.swappedOldIdentity))
        )
          throw new Error(
            "The swapped-out directory no longer matches its durable layout receipt.",
          );
      }
    }
  } catch (error) {
    await lease.release();
    throw error;
  }
  let stageCreated =
    (await pathState(input.proposal.stagingPath)) === "directory";
  let stageReady =
    existingJournal?.status !== "succeeded" &&
    existingJournal?.layout.phase === "stage-ready";
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
      await createInitialJournal(
        capability,
        input.proposal.journalPath,
        pending,
      );
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
      let verification:
        Awaited<ReturnType<typeof assertExactRepository>> | undefined;
      try {
        verification = await assertExactRepository(
          capability,
          input.proposal,
          input.proposal.destinationPath,
        );
      } catch {
        verification = undefined;
      }
      if (verification !== undefined) {
        destinationPublished = true;
        await removeVerifiedSwappedEmptyDirectory(capability, input.proposal);
        const success = successReceipt({
          proposal: input.proposal,
          publishedByCallId: input.publishedByCallId,
          recoveryOfDigest: input.recoveryOfDigest,
          leaseMarkerDigest: lease.markerDigest,
          previousLeaseMarkerDigest: priorLeaseMarkerDigest,
          verification,
          ...(input.proposal.destinationPrestate.kind === "empty-directory"
            ? {
                swappedOldIdentity: await identity(input.proposal.stagingPath),
              }
            : {}),
        });
        await atomicWrite(
          capability,
          input.proposal.journalPath,
          `${JSON.stringify(success)}\n`,
        );
        return { ok: true, receipt: success };
      } else {
        if (input.proposal.destinationPrestate.kind !== "empty-directory")
          throw new Error("The destination conflicts with recovery state.");
        await assertPrestate(capability, input.proposal);
      }
    }
    if (!stageCreated) {
      await assertPrestate(capability, input.proposal);
      await assertSourceUnchanged(input.sourceReceipt);
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
      await atomicWrite(
        capability,
        input.proposal.journalPath,
        `${JSON.stringify(claimed)}\n`,
      );
    } else if (input.recoveryOfDigest === undefined) {
      throw new Error("The deterministic bootstrap stage already exists.");
    }
    lease.assertHeld();
    const durableStageIdentity = await identity(input.proposal.stagingPath);
    for (const [index, file] of files.entries()) {
      await materializeFile(
        capability,
        input.proposal,
        file,
        input.recoveryOfDigest !== undefined,
        durableStageIdentity,
      );
      lease.assertHeld();
      await input.hooks?.afterMaterializeFile?.(file.path, index);
    }
    await initializeGit({
      capability,
      proposal: input.proposal,
      files,
      hooks: input.hooks,
      recovery: input.recoveryOfDigest !== undefined,
    });
    lease.assertHeld();
    const marker = resolve(
      input.proposal.stagingPath,
      input.proposal.claimMarkerName,
    );
    const markerState = await pathState(marker);
    if (markerState === "other") {
      const markerBytes = await readFile(marker);
      if (
        Buffer.compare(markerBytes, await markerContent(input.proposal)) !== 0
      )
        throw new Error("The bootstrap stage ownership marker changed.");
      await assertExactRepository(
        capability,
        input.proposal,
        input.proposal.stagingPath,
        { allowClaimMarker: true },
      );
      const ready = pendingReceipt(
        input.proposal,
        input.publishedByCallId,
        input.recoveryOfDigest,
        lease.markerDigest,
        priorLeaseMarkerDigest,
        {
          phase: "stage-ready",
          stageIdentity: await identity(input.proposal.stagingPath),
        },
      );
      await atomicWrite(
        capability,
        input.proposal.journalPath,
        `${JSON.stringify(ready)}\n`,
      );
      stageReady = true;
      await unlink(marker);
      await syncDirectory(input.proposal.stagingPath);
    } else if (!stageReady || markerState !== "absent") {
      throw new Error("Recovery lacks exact stage-ready ownership evidence.");
    }
    await assertExactRepository(
      capability,
      input.proposal,
      input.proposal.stagingPath,
    );
    lease.assertHeld();
    await input.hooks?.beforeAtomicPublication?.();
    await assertSourceUnchanged(input.sourceReceipt);
    await atomicPublish(capability, input.proposal, input.hooks);
    destinationPublished = true;
    lease.assertHeld();
    await input.hooks?.afterAtomicPublication?.();
    const verification = await assertExactRepository(
      capability,
      input.proposal,
      input.proposal.destinationPath,
    );
    await assertSourceUnchanged(input.sourceReceipt);
    await input.hooks?.beforeTerminalJournal?.();
    lease.assertHeld();
    const success = successReceipt({
      proposal: input.proposal,
      publishedByCallId: input.publishedByCallId,
      recoveryOfDigest: input.recoveryOfDigest,
      leaseMarkerDigest: lease.markerDigest,
      previousLeaseMarkerDigest: priorLeaseMarkerDigest,
      verification,
      ...(input.proposal.destinationPrestate.kind === "empty-directory"
        ? { swappedOldIdentity: await identity(input.proposal.stagingPath) }
        : {}),
    });
    await atomicWrite(
      capability,
      input.proposal.journalPath,
      `${JSON.stringify(success)}\n`,
    );
    lease.assertHeld();
    return { ok: true, receipt: success };
  } catch (error) {
    if (!destinationPublished) {
      try {
        await assertExactRepository(
          capability,
          input.proposal,
          input.proposal.destinationPath,
        );
        destinationPublished = true;
      } catch {
        destinationPublished = false;
      }
    }
    let failure = failureReceipt({
      proposal: input.proposal,
      publishedByCallId: input.publishedByCallId,
      recoveryOfDigest: input.recoveryOfDigest,
      leaseMarkerDigest: lease.markerDigest,
      previousLeaseMarkerDigest: priorLeaseMarkerDigest,
      reason: destinationPublished
        ? "publication-partial"
        : stageCreated
          ? "materialization-partial"
          : "precondition-failed",
      failureMessage:
        error instanceof Error ? error.message : "Fresh bootstrap failed.",
      layout: destinationPublished
        ? {
            phase: "published",
            destinationIdentity: await identity(input.proposal.destinationPath),
            ...((await pathState(input.proposal.stagingPath)) === "directory"
              ? {
                  swappedOldIdentity: await identity(
                    input.proposal.stagingPath,
                  ),
                }
              : {}),
          }
        : stageCreated
          ? {
              phase: stageReady ? "stage-ready" : "stage-owned",
              stageIdentity: await identity(input.proposal.stagingPath),
            }
          : { phase: "intent" },
      stageCreated,
      destinationPublished,
    });
    let leaseHeld = true;
    try {
      lease.assertHeld();
    } catch {
      leaseHeld = false;
    }
    if (leaseHeld && !input.hooks?.preserveNonterminalJournal)
      await atomicWrite(
        capability,
        input.proposal.journalPath,
        `${JSON.stringify(failure)}\n`,
      );
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
          throw new Error(
            "The fresh-bootstrap lease was lost before durable intent; its quiesced marker requires a separate reset.",
          );
        failure = failureReceipt({
          proposal: input.proposal,
          publishedByCallId: input.publishedByCallId,
          recoveryOfDigest: input.recoveryOfDigest,
          leaseMarkerDigest: quiesced.markerDigest,
          previousLeaseMarkerDigest: priorLeaseMarkerDigest,
          reason: failure.reason,
          failureMessage:
            "The mutation lease was lost; all synchronous helpers quiesced before this recovery-required receipt.",
          layout: failure.layout,
          stageCreated: failure.stageCreated,
          destinationPublished: failure.destinationPublished,
        });
        await atomicWrite(
          capability,
          input.proposal.journalPath,
          `${JSON.stringify(failure)}\n`,
        );
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
}

export async function publishFreshBootstrap(
  input: Omit<Parameters<typeof executeBootstrap>[0], "recoveryOfDigest">,
) {
  return executeBootstrap(input);
}

export async function recoverFreshBootstrap(
  input: Omit<Parameters<typeof executeBootstrap>[0], "recoveryOfDigest"> & {
    expectedJournalDigest: string;
  },
) {
  return executeBootstrap({
    ...input,
    recoveryOfDigest: input.expectedJournalDigest,
  });
}

export async function verifyFreshBootstrap(input: {
  capability?: FreshBootstrapCapability;
  receipt: FreshBootstrapSuccessReceipt;
  sourceReceipt: SourceReceipt;
  review: ReviewedChangeSetReceipt;
  readOverlayFile(path: string): Promise<Uint8Array | null>;
}): Promise<void> {
  const capability = await assertCapability(input.capability);
  assertCanonicalFreshBootstrapJournal(input.receipt);
  await assertExactInputs({
    capability,
    proposal: proposalFromFreshBootstrapJournal(input.receipt),
    sourceReceipt: input.sourceReceipt,
    review: input.review,
    readOverlayFile: input.readOverlayFile,
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
        JSON.stringify(input.receipt.swappedOldIdentity) ||
      (await readdir(input.receipt.stagingPath)).length !== 0
    )
      throw new Error("The swapped-out empty tombstone changed after receipt.");
  }
  if (
    JSON.stringify(verification.destinationIdentity) !==
      JSON.stringify(input.receipt.destinationIdentity) ||
    JSON.stringify(verification.gitDirectoryIdentity) !==
      JSON.stringify(input.receipt.gitDirectoryIdentity) ||
    verification.remoteDigest !== input.receipt.remoteDigest ||
    verification.worktreeDigest !== input.receipt.worktreeDigest
  )
    throw new Error("The published fresh repository changed after receipt.");
}
