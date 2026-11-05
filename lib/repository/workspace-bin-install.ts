// Bun links workspace bins into node_modules and can chmod the source target.
// Keep that installation detail out of the owned checkout's source snapshot.
const installProgram = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const root = process.cwd();
const statMode = (stat) => stat.mode & 0o7777;
const hash = (fd) => createHash("sha256").update(fs.readFileSync(fd)).digest("hex");

function readManifest(file) {
  if (fs.realpathSync(file) !== file) throw Error();
  return withFile(file, (fd) => JSON.parse(fs.readFileSync(fd, "utf8")));
}

function withFile(file, inspect) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid()) throw Error();
    return inspect(descriptor, stat);
  } finally {
    fs.closeSync(descriptor);
  }
}

function capture() {
  const manifests = new Set();
  const targets = new Map();
  const declared = readManifest(path.join(root, "package.json")).workspaces;
  for (const pattern of (Array.isArray(declared) ? declared : declared?.packages) ?? []) {
    if (typeof pattern !== "string" || path.isAbsolute(pattern) || pattern.split("/").includes("..")) throw Error();
    for (const file of fs.globSync(pattern + "/package.json", { cwd: root, exclude: ["**/node_modules/**", "**/.git/**"] })) {
      manifests.add(path.join(root, file));
    }
  }
  for (const file of manifests) {
    const { bin } = readManifest(file);
    const bins = typeof bin === "string" ? [bin] : Object.values(bin ?? {});
    const directory = path.dirname(file);
    for (const entry of bins) {
      if (typeof entry !== "string" || path.isAbsolute(entry) || entry.split("/").includes("..")) throw Error();
      const target = path.resolve(directory, entry);
      if (!target.startsWith(directory + path.sep)) throw Error();
      let current = directory;
      let exists = true;
      for (const segment of path.relative(directory, target).split(path.sep)) {
        current = path.join(current, segment);
        const stat = fs.lstatSync(current, { throwIfNoEntry: false });
        if (stat === undefined) {
          exists = false;
          break;
        }
        if (stat.isSymbolicLink()) throw Error();
      }
      if (!exists) continue;
      withFile(target, (fd, stat) => {
        const mode = statMode(stat);
        if (!(mode & 0o100) || (mode & 0o7000)) throw Error();
        targets.set(target, { stat, mode, digest: hash(fd) });
      });
    }
  }
  return targets;
}

function restore(targets) {
  let valid = true;
  for (const [file, before] of targets) {
    try {
      if (fs.realpathSync(file) !== file) throw Error();
      const sameIdentity = (current) => current.dev === before.stat.dev && current.ino === before.stat.ino;
      withFile(file, (fd, stat) => {
        if (!sameIdentity(stat) || hash(fd) !== before.digest) throw Error();
        if (statMode(stat) === 0o777) fs.fchmodSync(fd, before.mode);
      });
      withFile(file, (fd, stat) => {
        if (statMode(stat) !== before.mode || !sameIdentity(stat) || hash(fd) !== before.digest) throw Error();
      });
    } catch {
      valid = false;
    }
  }
  if (!valid) throw Error();
}

try {
  if (root !== process.argv[1] || fs.realpathSync(root) !== root || typeof process.getuid !== "function") throw Error();
  const targets = capture();
  const install = spawnSync("bun", ["install", ...process.argv.slice(2)], { stdio: "inherit" });
  restore(targets);
  process.exitCode = install.status ?? 1;
} catch {
  process.stderr.write("Workspace executable permissions could not be verified after dependency installation.\n");
  process.exitCode = 1;
}
`;

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export const workspaceBinInstallCommand = (root: string, frozen: boolean) =>
  `node -e ${shellQuote(installProgram)} -- ${shellQuote(root)}${frozen ? " --frozen-lockfile" : ""}`;
