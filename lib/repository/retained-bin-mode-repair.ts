import { z } from "zod";
import { OVERLAY_SNAPSHOT_INVENTORY_SCRIPT } from "./target-apply";
import { WORKSPACE_BIN_CAPTURE_SCRIPT } from "./workspace-bin-install";
import { safeSourcePath } from "./source-path";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const retainedBinModeTarget = z.strictObject({
  path: z.string().refine(safeSourcePath),
  digest,
  device: z.string().regex(/^\d+$/u),
  inode: z.string().regex(/^\d+$/u),
});
export const retainedBinModeObservation = z.strictObject({
  beforeDigest: digest,
  targets: z.array(retainedBinModeTarget).min(1).max(32),
});
export const retainedBinModeRepairResult = z.union([
  retainedBinModeObservation,
  z.strictObject({ status: z.enum(["restored", "reconciliation-required"]) }),
]);
type Observation = z.infer<typeof retainedBinModeObservation>;

const script = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const input = JSON.parse(process.argv[1]);
const digest = (files) => createHash("sha256").update(JSON.stringify(files)).digest("hex");
const snapshot = () => {
  const expectedOverlayRoot = input.root;
  ${OVERLAY_SNAPSHOT_INVENTORY_SCRIPT}
  return files.map(({ digest, mode, path }) => ({ digest, mode, path }));
};
const declaredBins = () => {
  ${WORKSPACE_BIN_CAPTURE_SCRIPT}
  return capture(true);
};
const descriptors = [];
function checkTarget({ fd, name, target }) {
  const current = fs.fstatSync(fd, { bigint: true });
  const entry = fs.lstatSync(name, { bigint: true });
  if (fs.realpathSync(name) !== name || !current.isFile() || current.nlink !== 1n ||
      current.uid !== BigInt(process.getuid()) || (current.mode & 0o7777n) !== 0o777n ||
      current.dev !== entry.dev || current.ino !== entry.ino || current.mode !== entry.mode ||
      String(current.dev) !== target.device || String(current.ino) !== target.inode) throw Error();
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(65536);
  let offset = 0;
  for (;;) {
    const length = fs.readSync(fd, buffer, 0, buffer.length, offset);
    if (length === 0) break;
    hash.update(buffer.subarray(0, length));
    offset += length;
  }
  if (hash.digest("hex") !== target.digest) throw Error();
}
function withReservationDirectory(visit) {
  const directory = path.join(path.dirname(input.root), ".app-builder");
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const metadata = fs.fstatSync(fd, { bigint: true });
    const assertDirectory = () => {
      const entry = fs.lstatSync(directory, { bigint: true });
      if (!metadata.isDirectory() || metadata.uid !== BigInt(process.getuid()) ||
          (entry.mode & 0o022n) !== 0n || fs.realpathSync(directory) !== directory ||
          entry.dev !== metadata.dev || entry.ino !== metadata.ino) throw Error();
    };
    assertDirectory();
    const base = process.platform === "linux" ? "/proc/self/fd/" + fd : directory;
    const marker = path.join(base, "retained-bin-mode-repair-" + input.expectedDigest);
    const result = visit(marker, fd);
    assertDirectory();
    return result;
  } finally {
    fs.closeSync(fd);
  }
}
function hasReservation() {
  return withReservationDirectory((marker) => {
    let fd;
    try {
      fd = fs.openSync(marker, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 ||
          stat.size !== 0 || (stat.mode & 0o7777) !== 0o600) throw Error();
      return true;
    } finally {
      fs.closeSync(fd);
    }
  });
}
function reserve() {
  // Keep the reservation even if Eve terminates before retaining its step.
  withReservationDirectory((marker, directory) => {
    const fd = fs.openSync(marker, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.fsyncSync(directory);
  });
}
function repair() {
  if (!/^[a-f0-9]{64}$/.test(input.expectedDigest)) throw Error();
  const files = snapshot();
  const beforeDigest = digest(files);
  if (hasReservation()) {
    if (input.approved !== undefined) throw Error();
    return { status: beforeDigest === input.expectedDigest ? "restored" : "reconciliation-required" };
  }
  const declared = declaredBins();
  const targets = files.flatMap((file) => {
    const source = declared.get(path.join(input.root, file.path));
    if (!source || file.mode !== "777" || source.digest !== file.digest) return [];
    return [{ path: file.path, digest: file.digest, device: String(source.identity.dev), inode: String(source.identity.ino) }];
  });
  const selected = new Set(targets.map(({path}) => path));
  const normalized = files.map((file) => selected.has(file.path) ? { ...file, mode: "755" } : file);
  if (targets.length === 0 || targets.length > 32 || digest(normalized) !== input.expectedDigest) throw Error();
  const observation = { beforeDigest, targets };
  if (input.approved !== undefined) {
    if (JSON.stringify(observation) !== JSON.stringify(input.approved)) throw Error();
    for (const target of targets) {
      const name = path.join(input.root, target.path);
      if (fs.realpathSync(name) !== name) throw Error();
      const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      descriptors.push({ fd, name, target });
    }
    for (const descriptor of descriptors) checkTarget(descriptor);
    reserve();
    if (digest(snapshot()) !== beforeDigest) throw Error();
    for (const descriptor of descriptors) {
      checkTarget(descriptor);
      fs.fchmodSync(descriptor.fd, 0o755);
      fs.fsyncSync(descriptor.fd);
    }
    if (digest(snapshot()) !== input.expectedDigest) throw Error();
  }
  return observation;
}
try {
  console.log(JSON.stringify(repair()));
} catch {
  process.stderr.write("The retained executable mode repair could not be verified. Reconcile the exact checkout before any further repair.\n");
  process.exitCode = 1;
} finally {
  for (const {fd} of descriptors) fs.closeSync(fd);
}
`;

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export const retainedBinModeRepairCommand = (input: {
  root: string;
  expectedDigest: string;
  approved?: Observation;
}) => `node -e ${quote(script)} ${quote(JSON.stringify(input))}`;
