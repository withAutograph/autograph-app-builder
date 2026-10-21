import path from "node:path";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";

const countSchema = z.number().int().nonnegative();
const decimalSchema = z.string().regex(/^\d+$/u);
const capacitySnapshotSchema = z.strictObject({
  bytes: z.strictObject({ total: decimalSchema, available: decimalSchema }).optional(),
  inodes: z.strictObject({ total: decimalSchema, free: decimalSchema }).optional(),
});
const retirementAdvisorySchema = z.strictObject({
  status: z.enum(["complete", "partial", "unavailable"]),
  retired: countSchema,
  retained: countSchema,
  reasons: z.partialRecord(
    z.enum([
      "referenced",
      "private_state",
      "ownership_or_registration",
      "changed_during_inspection",
      "retention_ref",
      "removal_refused",
      "inspection_unavailable",
    ]),
    countSchema,
  ),
  capacity: z
    .strictObject({
      before: capacitySnapshotSchema.optional(),
      after: capacitySnapshotSchema.optional(),
    })
    .optional(),
});

export type DraftWorktreeRetirementAdvisory = z.infer<typeof retirementAdvisorySchema>;

const unavailableAdvisory = (): DraftWorktreeRetirementAdvisory => ({
  status: "unavailable",
  retired: 0,
  retained: 0,
  reasons: {},
});

/** Preserve the same failure and cause; reporting must never mask it or change cancellation. */
export const annotateDraftWorktreeRetirementError = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- JavaScript throw values are untrusted; preserve them and annotate only verified Error instances.
  error: unknown,
  advisory: DraftWorktreeRetirementAdvisory,
  signal?: AbortSignal,
): void => {
  try {
    if (signal?.aborted === true || !(error instanceof Error) || error.name === "AbortError") {
      return;
    }
    const message = Object.getOwnPropertyDescriptor(error, "message");
    const originalMessage = z.string().safeParse(message?.value);
    const parsed = retirementAdvisorySchema.safeParse(advisory);
    if (message?.writable !== true || !originalMessage.success || !parsed.success) {
      return;
    }
    Object.defineProperty(error, "message", {
      ...message,
      value: `${originalMessage.data}\nWorkspace maintenance advisory: ${JSON.stringify(parsed.data)}`,
    });
  } catch {
    // Frozen/custom errors and unavailable diagnostic serialization retain the original failure.
  }
};

// All filesystem changes below use Git's exact worktree/ref APIs. Unknown state
// is retained; this maintenance must never become preparation admission policy.
const retirementProgram = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const request = JSON.parse(process.argv[1]);
const overlap = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
const git = (root, args, input) => new Promise((resolve, reject) => {
  const child = spawn("git", ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", root, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" }
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.resume();
  child.on("error", reject);
  child.stdin.on("error", reject);
  child.on("close", (status, signal) => signal || status === null ? reject(Error("Unknown Git outcome")) : resolve({ status, stdout }));
  child.stdin.end(input);
});
const read = async (root, args, input) => {
  const result = await git(root, args, input);
  if (result.status !== 0) throw Error("Git inspection failed");
  return result.stdout;
};
const records = text => text.split("\0").filter(Boolean);
const sampleCapacity = workspace => {
  try {
    const observed = fs.statfsSync(workspace, { bigint: true });
    const snapshot = {};
    const unavailable = 2n ** 64n - 1n;
    if (typeof observed.bsize === "bigint" && observed.bsize > 0n && observed.bsize !== unavailable && typeof observed.blocks === "bigint" && observed.blocks > 0n && observed.blocks !== unavailable && typeof observed.bavail === "bigint" && observed.bavail >= 0n && observed.bavail !== unavailable && observed.bavail <= observed.blocks) {
      snapshot.bytes = { total: String(observed.blocks * observed.bsize), available: String(observed.bavail * observed.bsize) };
    }
    if (typeof observed.files === "bigint" && observed.files > 0n && observed.files !== unavailable && typeof observed.ffree === "bigint" && observed.ffree >= 0n && observed.ffree !== unavailable && observed.ffree <= observed.files) {
      snapshot.inodes = { total: String(observed.files), free: String(observed.ffree) };
    }
    return Object.keys(snapshot).length ? snapshot : undefined;
  } catch { return undefined; }
};
const reasonByMessage = new Map([
  ["Referenced worktree", "referenced"],
  ...["Private files remain", "Ambiguous index flags", "Index differs from HEAD", "Private staged or unresolved changes remain", "Untracked directory remains", "Untracked or ignored bytes remain", "Private symlink change remains", "Private mode change remains", "Tracked file is missing", "Private tracked bytes remain"].map(message => [message, "private_state"]),
  ...["Referenced or ambiguous worktree", "Unowned worktree", "Worktree ownership changed", "Worktree is not detached", "Unsupported tracked entry", "Ambiguous tracked path", "Ambiguous Git registration"].map(message => [message, "ownership_or_registration"]),
  ...["Worktree HEAD changed", "Dependency parent changed", "Dependency link changed", "Dependency links changed", "Dependency link changed before removal", "Dependency links reappeared"].map(message => [message, "changed_during_inspection"]),
  ...["Symbolic retention ref", "Retention ref unavailable", "Retention ref names different history", "Retention ref changed"].map(message => [message, "retention_ref"]),
  ["Worktree removal refused", "removal_refused"],
]);
const retentionReason = error => {
  try { return error instanceof Error ? reasonByMessage.get(error.message) ?? "inspection_unavailable" : "inspection_unavailable"; }
  catch { return "inspection_unavailable"; }
};
const registered = async checkout => (await read(checkout, ["worktree", "list", "--porcelain", "-z"]))
  .split("\0\0").filter(Boolean).map(block => records(block));
const entry = fields => {
  if (fields.length !== 3 || !fields[0].startsWith("worktree ") || !fields[1].startsWith("HEAD ") || fields[2] !== "detached") return null;
  return { root: fields[0].slice(9), head: fields[1].slice(5) };
};
const common = async root => fs.realpathSync((await read(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
// Same derived-link convention as candidate attachment/replay; never follow its target.
const ownedDependencyRoot = (root, workspace, relative) => {
  if (relative.split("/").at(-1) !== "node_modules") return false;
  const entry = path.join(root, relative);
  const stat = fs.lstatSync(entry, { throwIfNoEntry: false });
  if (!stat?.isSymbolicLink() || stat.uid !== process.getuid()) return false;
  const key = createHash("sha256").update(root).digest("hex");
  const expected = path.join(workspace, ".app-builder/dependency-views/checkout", key, relative);
  return path.resolve(path.dirname(entry), fs.readlinkSync(entry)) === expected;
};
const parentIdentity = (root, relative) => {
  let parent = root;
  if (fs.realpathSync(root) !== root) throw Error("Dependency parent changed");
  const parents = [];
  for (const part of ["", ...relative.split("/").slice(0, -1)]) {
    if (part) parent = path.join(parent, part);
    const stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw Error("Dependency parent changed");
    parents.push({ dev: stat.dev, ino: stat.ino });
  }
  if (fs.realpathSync(parent) !== parent) throw Error("Dependency parent changed");
  return parents;
};
const linkIdentity = (root, relative) => {
  const entry = path.join(root, relative);
  const stat = fs.lstatSync(entry);
  if (!stat.isSymbolicLink() || stat.uid !== process.getuid()) throw Error("Dependency link changed");
  return { relative, target: fs.readlinkSync(entry), dev: stat.dev, ino: stat.ino, ctime: stat.ctimeMs, parents: parentIdentity(root, relative) };
};
const sameLink = (root, link) => JSON.stringify(linkIdentity(root, link.relative)) === JSON.stringify(link);
const restoreLinks = (root, links) => {
  for (const link of links) {
    try {
      if (JSON.stringify(parentIdentity(root, link.relative)) === JSON.stringify(link.parents) && !fs.lstatSync(path.join(root, link.relative), { throwIfNoEntry: false })) {
        fs.symlinkSync(link.target, path.join(root, link.relative));
      }
    } catch { /* Never overwrite a replacement or follow a changed parent. */ }
  }
};
const inspect = async (checkout, candidate, commonDirectory, retainedRoots, directory, workspace) => {
  const root = candidate.root;
  if (path.dirname(root) !== directory || fs.realpathSync(root) !== root) throw Error("Referenced or ambiguous worktree");
  if (retainedRoots.some(retained => overlap(root, retained))) throw Error("Referenced worktree");
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw Error("Unowned worktree");
  const current = (await registered(checkout)).map(entry).filter(Boolean).filter(item => item.root === root);
  if (current.length !== 1 || current[0].head !== candidate.head || await common(root) !== commonDirectory || await common(checkout) !== commonDirectory) throw Error("Worktree ownership changed");
  if ((await read(root, ["rev-parse", "--verify", "HEAD"])).trim() !== candidate.head) throw Error("Worktree HEAD changed");
  if ((await git(root, ["symbolic-ref", "--quiet", "HEAD"])).status !== 1) throw Error("Worktree is not detached");
  const status = records(await read(root, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none", "-z"]));
  if (records(await read(root, ["ls-files", "-v", "-z"])).some(line => !line.startsWith("H "))) throw Error("Ambiguous index flags");
  const tree = new Map(records(await read(root, ["ls-tree", "-r", "-z", "--full-tree", candidate.head])).map(line => {
    const match = /^(100644|100755|120000) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
    if (!match) throw Error("Unsupported tracked entry");
    return [match[3], { mode: match[1], hash: match[2] }];
  }));
  const index = records(await read(root, ["ls-files", "--stage", "-z"]));
  if (index.length !== tree.size) throw Error("Index differs from HEAD");
  const directories = new Set();
  for (const line of index) {
    const match = /^(100644|100755|120000) ([a-f0-9]+) 0\t([\s\S]+)$/.exec(line);
    const expected = match && tree.get(match[3]);
    if (!expected || expected.mode !== match[1] || expected.hash !== match[2]) throw Error("Private staged or unresolved changes remain");
    const parts = match[3].split("/");
    if (parts.some(part => !part || part === "." || part === ".." || part === ".git")) throw Error("Ambiguous tracked path");
    parts.pop();
    while (parts.length) { directories.add(parts.join("/")); parts.pop(); }
  }
  if (status.some(record => !["?? ", "!! "].includes(record.slice(0, 3)) || tree.has(record.slice(3)) || !ownedDependencyRoot(root, workspace, record.slice(3)))) throw Error("Private files remain");
  const links = [];
  const regular = [];
  const observedPaths = new Set();
  const visit = async (parent, relative = "") => {
    for (const item of fs.readdirSync(parent, { withFileTypes: true })) {
      if (relative === "" && item.name === ".git") {
        if (!fs.lstatSync(path.join(parent, item.name)).isFile()) throw Error("Ambiguous Git registration");
        continue;
      }
      const name = relative ? relative + "/" + item.name : item.name;
      const absolute = path.join(root, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) {
        if (!directories.has(name)) throw Error("Untracked directory remains");
        await visit(absolute, name);
        continue;
      }
      const expected = tree.get(name);
      if (!expected && ownedDependencyRoot(root, workspace, name)) {
        links.push(linkIdentity(root, name));
        continue;
      }
      if (!expected) throw Error("Untracked or ignored bytes remain");
      observedPaths.add(name);
      if (expected.mode === "120000") {
        if (!stat.isSymbolicLink() || (await read(root, ["hash-object", "--stdin"], fs.readlinkSync(absolute))).trim() !== expected.hash) throw Error("Private symlink change remains");
      } else {
        if (!stat.isFile() || (stat.mode & 0o777) !== (expected.mode === "100755" ? 0o755 : 0o644)) throw Error("Private mode change remains");
        regular.push(name);
      }
    }
  };
  await visit(root);
  if (observedPaths.size !== tree.size) throw Error("Tracked file is missing");
  if (regular.length) {
    const hashes = (await read(root, ["hash-object", "--no-filters", "--stdin-paths"], regular.map(name => JSON.stringify(name)).join("\n") + "\n")).trim().split("\n");
    if (hashes.length !== regular.length || regular.some((name, index) => tree.get(name).hash !== hashes[index])) throw Error("Private tracked bytes remain");
  }
  return links.sort((a, b) => a.relative.localeCompare(b.relative));
};
async function main() {
let retired = 0;
let retained = 0;
let status = "complete";
const reasons = {};
let workspace;
let before;
try {
  workspace = fs.realpathSync(request.workspaceRoot);
  before = sampleCapacity(workspace);
  const checkout = fs.realpathSync(path.join(workspace, "repository"));
  const directory = path.join(workspace, ".app-builder", "draft-reconcile");
  if (fs.realpathSync(directory) !== directory || !fs.lstatSync(directory).isDirectory()) throw Error("No owned worktree directory");
  const commonDirectory = await common(checkout);
  const canonicalRetained = root => {
    const suffix = [];
    let ancestor = root;
    for (;;) {
      try { return path.join(fs.realpathSync(ancestor), ...suffix); }
      catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
        if (path.dirname(ancestor) === ancestor) throw error;
        suffix.unshift(path.basename(ancestor));
        ancestor = path.dirname(ancestor);
      }
    }
  };
  const retainedRoots = request.retainedRoots.flatMap(root => {
    const absolute = path.resolve(workspace, root);
    return [absolute, canonicalRetained(absolute)];
  });
  for (const fields of await registered(checkout)) {
    const candidate = entry(fields);
    if (!candidate || path.dirname(candidate.root) !== directory) continue;
    const detachedLinks = [];
    try {
      const links = await inspect(checkout, candidate, commonDirectory, retainedRoots, directory, workspace);
      const ref = "refs/app-builder/retired-draft-worktrees/" + createHash("sha256").update(candidate.root).digest("hex");
      if ((await git(checkout, ["symbolic-ref", "--quiet", ref])).status !== 1) throw Error("Symbolic retention ref");
      const prior = await git(checkout, ["rev-parse", "--verify", "--quiet", ref]);
      if (prior.status === 1) {
        if ((await git(checkout, ["update-ref", "--no-deref", ref, candidate.head, "0".repeat(candidate.head.length)])).status !== 0) throw Error("Retention ref unavailable");
      } else if (prior.status !== 0 || prior.stdout.trim() !== candidate.head) throw Error("Retention ref names different history");
      const currentLinks = await inspect(checkout, candidate, commonDirectory, retainedRoots, directory, workspace);
      if (JSON.stringify(currentLinks) !== JSON.stringify(links)) throw Error("Dependency links changed");
      if ((await git(checkout, ["symbolic-ref", "--quiet", ref])).status !== 1 || (await read(checkout, ["rev-parse", "--verify", "--quiet", ref])).trim() !== candidate.head) throw Error("Retention ref changed");
      for (const link of links) {
        // No awaited command between the real-parent/identity check and unlink.
        if (!sameLink(candidate.root, link) || !ownedDependencyRoot(candidate.root, workspace, link.relative)) throw Error("Dependency link changed before removal");
        fs.unlinkSync(path.join(candidate.root, link.relative));
        detachedLinks.push(link);
      }
      if (detachedLinks.length && (await inspect(checkout, candidate, commonDirectory, retainedRoots, directory, workspace)).length) throw Error("Dependency links reappeared");
      if ((await git(checkout, ["worktree", "remove", "--", candidate.root])).status !== 0) throw Error("Worktree removal refused");
      retired += 1;
    } catch (error) {
      restoreLinks(candidate.root, detachedLinks);
      retained += 1;
      const reason = retentionReason(error);
      reasons[reason] = (reasons[reason] ?? 0) + 1;
      if (reason === "inspection_unavailable") status = "partial";
    }
  }
} catch { status = retired || retained ? "partial" : "unavailable"; }
const after = workspace === undefined ? undefined : sampleCapacity(workspace);
console.log(JSON.stringify({ status, retired, retained, reasons, ...(before || after ? { capacity: { before, after } } : {}) }));
}
main().catch(() => { console.log(JSON.stringify({ status: "unavailable", retired: 0, retained: 0, reasons: {} })); });
`;

/** Retire only unreferenced, byte-clean registered worktrees; preserve their HEADs. */
export const retireUnusedDraftWorktrees = async (input: {
  sandbox: Pick<SandboxSession, "run">;
  retainedRoots: readonly string[];
  workspaceRoot?: string;
  signal?: AbortSignal;
}): Promise<DraftWorktreeRetirementAdvisory> => {
  const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
  try {
    const result = await input.sandbox.run({
      abortSignal: input.signal,
      command: `node -e ${quote(retirementProgram)} ${quote(
        JSON.stringify({
          workspaceRoot: path.posix.resolve(input.workspaceRoot ?? "/workspace"),
          retainedRoots: input.retainedRoots,
        }),
      )}`,
      workingDirectory: input.workspaceRoot ?? "/workspace",
    });
    if (result.exitCode === 0) {
      const parsed = retirementAdvisorySchema.safeParse(JSON.parse(result.stdout));
      if (parsed.success) {
        return parsed.data;
      }
    }
  } catch {
    // No cleanup retry or inferred success after an unknown provider outcome.
    input.signal?.throwIfAborted();
  }
  return unavailableAdvisory();
};
