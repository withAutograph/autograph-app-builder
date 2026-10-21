import path from "node:path";
import type { SandboxSession } from "eve/sandbox";

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
const registered = async checkout => (await read(checkout, ["worktree", "list", "--porcelain", "-z"]))
  .split("\0\0").filter(Boolean).map(block => records(block));
const entry = fields => {
  if (fields.length !== 3 || !fields[0].startsWith("worktree ") || !fields[1].startsWith("HEAD ") || fields[2] !== "detached") return null;
  return { root: fields[0].slice(9), head: fields[1].slice(5) };
};
const common = async root => fs.realpathSync((await read(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
const inspect = async (checkout, candidate, commonDirectory, retainedRoots, directory) => {
  const root = candidate.root;
  if (path.dirname(root) !== directory || fs.realpathSync(root) !== root || retainedRoots.some(retained => overlap(root, retained))) throw Error("Referenced or ambiguous worktree");
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw Error("Unowned worktree");
  const current = (await registered(checkout)).map(entry).filter(Boolean).filter(item => item.root === root);
  if (current.length !== 1 || current[0].head !== candidate.head || await common(root) !== commonDirectory || await common(checkout) !== commonDirectory) throw Error("Worktree ownership changed");
  if ((await read(root, ["rev-parse", "--verify", "HEAD"])).trim() !== candidate.head) throw Error("Worktree HEAD changed");
  if ((await git(root, ["symbolic-ref", "--quiet", "HEAD"])).status !== 1) throw Error("Worktree is not detached");
  if (await read(root, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none", "-z"]) !== "") throw Error("Private files remain");
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
};
async function main() {
let retired = 0;
let retained = 0;
try {
  const workspace = fs.realpathSync(request.workspaceRoot);
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
    try {
      await inspect(checkout, candidate, commonDirectory, retainedRoots, directory);
      const ref = "refs/app-builder/retired-draft-worktrees/" + createHash("sha256").update(candidate.root).digest("hex");
      if ((await git(checkout, ["symbolic-ref", "--quiet", ref])).status !== 1) throw Error("Symbolic retention ref");
      const prior = await git(checkout, ["rev-parse", "--verify", "--quiet", ref]);
      if (prior.status === 1) {
        if ((await git(checkout, ["update-ref", "--no-deref", ref, candidate.head, "0".repeat(candidate.head.length)])).status !== 0) throw Error("Retention ref unavailable");
      } else if (prior.status !== 0 || prior.stdout.trim() !== candidate.head) throw Error("Retention ref names different history");
      await inspect(checkout, candidate, commonDirectory, retainedRoots, directory);
      if ((await git(checkout, ["symbolic-ref", "--quiet", ref])).status !== 1 || (await read(checkout, ["rev-parse", "--verify", "--quiet", ref])).trim() !== candidate.head) throw Error("Retention ref changed");
      if ((await git(checkout, ["worktree", "remove", "--", candidate.root])).status !== 0) throw Error("Worktree removal refused");
      retired += 1;
    } catch { retained += 1; }
  }
} catch { /* Unknown scope/transport is a maintenance no-op. */ }
console.log(JSON.stringify({ retired, retained }));
}
main().catch(() => { console.log(JSON.stringify({ retired: 0, retained: 0 })); });
`;

/** Retire only unreferenced, byte-clean registered worktrees; preserve their HEADs. */
export const retireUnusedDraftWorktrees = async (input: {
  sandbox: Pick<SandboxSession, "run">;
  retainedRoots: readonly string[];
  workspaceRoot?: string;
  signal?: AbortSignal;
}): Promise<void> => {
  const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
  try {
    await input.sandbox.run({
      abortSignal: input.signal,
      command: `node -e ${quote(retirementProgram)} ${quote(
        JSON.stringify({
          workspaceRoot: path.posix.resolve(input.workspaceRoot ?? "/workspace"),
          retainedRoots: input.retainedRoots,
        }),
      )}`,
      workingDirectory: input.workspaceRoot ?? "/workspace",
    });
  } catch {
    // No cleanup retry or inferred success after an unknown provider outcome.
    input.signal?.throwIfAborted();
  }
};
