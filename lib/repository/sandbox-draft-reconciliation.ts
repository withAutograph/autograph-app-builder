import { createHash } from "node:crypto";

import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";

import type { GitHubDraftPullRequestContentSource } from "./github-publication";
import { ensureSandboxDirectories } from "./sandbox-filesystem";
import { safeSourcePath } from "./source-path";
import type { OverlayChange } from "./target-apply";

const SHA = /^[0-9a-f]{40}$/u;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/u;
const APP_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const BRANCH =
  /^(?![./])(?!.*(?:\.\.|@\{))(?!.*(?:[/.]|\.lock)$)[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;
const DEFAULT_WORKSPACE = "/workspace";
const DIFF_COMMAND = "diff";
const NAME_ONLY = "--name-only";
const ZERO_TERMINATED = "-z";
const UNMERGED_PATHS = [DIFF_COMMAND, NAME_ONLY, "--diff-filter=U", ZERO_TERMINATED];
const INVALID_INPUT =
  "Builder cannot reconcile the draft: a repository, app, branch, or revision is invalid.";

const quote = (value: string) => {
  const replacement = "'\"'\"'";
  return `'${value.replaceAll("'", replacement)}'`;
};
const git = (root: string, args: readonly string[]) =>
  `git -c core.hooksPath=/dev/null -c commit.gpgsign=false -C ${quote(root)} ${args.map(quote).join(" ")}`;
const mergeBase = (root: string, baseSha: string) =>
  git(root, [
    "-c",
    "user.name=Autograph App Builder",
    "-c",
    "user.email=builder@autograph.so",
    "merge",
    "--no-commit",
    "--no-ff",
    baseSha,
  ]);
const records = (value: string) => value.split("\0").filter((part) => part !== "");
const redact = (value: string) =>
  value
    .replaceAll(/https?:\/\/[^\s]+/giu, "[URL REDACTED]")
    .replaceAll(/Bearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replaceAll(/\b(?:gh[oprsu]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/gu, "[REDACTED]")
    .replaceAll(/\s+/gu, " ")
    .trim();

const run = async (sandbox: SandboxSession, operation: string, command: string) => {
  let result: Awaited<ReturnType<SandboxSession["run"]>>;
  try {
    result = await sandbox.run({ command, workingDirectory: "/workspace" });
  } catch (error) {
    throw new Error(
      `Builder could not ${operation} in its isolated checkout. Check sandbox availability and retry. Cause: ${redact(error instanceof Error ? error.message : String(error)) || "The sandbox provider returned no detail."}`,
      { cause: error },
    );
  }
  return result;
};

const checked = async (sandbox: SandboxSession, operation: string, command: string) => {
  const result = await run(sandbox, operation, command);
  if (result.exitCode !== 0) {
    throw new Error(
      `Builder could not ${operation} (exit ${result.exitCode}). Check the selected repository and GitHub access, then retry. Cause: ${redact(result.stderr || result.stdout) || "The command returned no diagnostic output."}`,
    );
  }
  return result.stdout.trim();
};

export interface DraftReconciliationInput {
  sandbox: SandboxSession;
  /** The sandbox workspace root; tests may supply a local temporary workspace. */
  workspaceRoot?: string;
  repository: { owner: string; name: string };
  appId: string;
  headBranch: string;
  headSha: string;
  baseBranch: string;
  baseSha: string;
  unpublished?: {
    reviewDigest: string;
    changes: readonly OverlayChange[];
    contentSource: GitHubDraftPullRequestContentSource;
  };
}

export interface PreparedDraftReconciliation {
  workspaceRoot: string;
  root: string;
  appId: string;
  baseSha: string;
  baseTree: string;
  headSha: string;
  headTree: string;
  conflicts: readonly string[];
}

const appPath = (appId: string, path: string) =>
  safeSourcePath(path) && path.startsWith(`apps/${appId}/`);

const verifyInputs = (input: DraftReconciliationInput) => {
  const fields = [
    [NAME, input.repository.owner],
    [NAME, input.repository.name],
    [APP_ID, input.appId],
    [BRANCH, input.headBranch],
    [BRANCH, input.baseBranch],
    [SHA, input.headSha],
    [SHA, input.baseSha],
  ] as const;
  if (fields.some(([pattern, value]) => !pattern.test(value))) {
    throw new Error(INVALID_INPUT);
  }
};

const inspectRevision = async (sandbox: SandboxSession, root: string, sha: string) => {
  const tree = await checked(
    sandbox,
    `inspect commit ${sha}`,
    git(root, ["rev-parse", `${sha}^{tree}`]),
  );
  if (!SHA.test(tree)) {
    throw new Error(`Builder could not read the tree for commit ${sha}. Refresh the draft source.`);
  }
  return tree;
};

const preimageProgram = String.raw`
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { closeSync, mkdtempSync, openSync, readSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const [root, path] = process.argv.slice(1);
const entry = spawnSync("git", ["-C", root, "ls-tree", "-z", "HEAD", "--", path], { encoding: "utf8" });
if (entry.status !== 0) throw Error(entry.stderr || "Git ls-tree failed");
if (!entry.stdout) { console.log("null"); process.exit(0); }
const match = /^(100644|100755) blob ([0-9a-f]{40})\t/.exec(entry.stdout);
if (!match) throw Error("Unsupported Git entry at " + path);
const directory = mkdtempSync(join(tmpdir(), "builder-preimage-"));
const descriptor = openSync(join(directory, "blob"), "w+");
try {
  const blob = spawnSync("git", ["-C", root, "cat-file", "blob", match[2]], { stdio: ["ignore", descriptor, "pipe"], encoding: "utf8" });
  if (blob.status !== 0) throw Error(blob.stderr || "Git cat-file failed");
  const buffer = Buffer.alloc(64 * 1024);
  const hash = createHash("sha256");
  let offset = 0;
  for (;;) {
    const length = readSync(descriptor, buffer, 0, buffer.length, offset);
    if (length === 0) break;
    hash.update(buffer.subarray(0, length));
    offset += length;
  }
  console.log(JSON.stringify({ mode: match[1] === "100755" ? "755" : "644", digest: hash.digest("hex") }));
} finally {
  closeSync(descriptor);
  rmSync(directory, { force: true, recursive: true });
}
`;

const currentFileState = async (
  sandbox: SandboxSession,
  root: string,
  path: string,
): Promise<{ digest: string; mode: "644" | "755" } | null> => {
  const raw = await checked(
    sandbox,
    `inspect draft file ${path}`,
    `node -e ${quote(preimageProgram)} ${quote(root)} ${quote(path)}`,
  );
  return z
    .strictObject({ digest: z.string(), mode: z.enum(["644", "755"]) })
    .nullable()
    .parse(JSON.parse(raw));
};

const matchesFileState = (
  observed: { digest: string; mode: "644" | "755" } | null,
  expected: OverlayChange["before"] | OverlayChange["after"],
): boolean => {
  if (expected === undefined) {
    return observed === null;
  }
  const mode = expected.mode === "100755" ? "755" : "644";
  return observed?.digest === expected.digest && observed.mode === mode;
};

const stageUnpublished = async (
  input: DraftReconciliationInput,
  root: string,
  workspaceRoot: string,
): Promise<void> => {
  const { unpublished } = input;
  if (unpublished === undefined || unpublished.changes.length === 0) {
    return;
  }
  const observed = await Promise.all(
    unpublished.changes.map(
      async (change) => await currentFileState(input.sandbox, root, change.path),
    ),
  );
  if (
    unpublished.changes.every((change, index) =>
      matchesFileState(observed[index] ?? null, change.after),
    )
  ) {
    return;
  }
  const changedPreimage = unpublished.changes.find(
    (change, index) => !matchesFileState(observed[index] ?? null, change.before),
  );
  if (changedPreimage !== undefined) {
    throw new Error(
      `Builder cannot replay reviewed change ${changedPreimage.path}: the current draft head matches neither its reviewed starting content nor the complete reviewed result. Reopen the current PR head and review its files again.`,
    );
  }
  // oxlint-disable-next-line react-doctor/async-await-in-loop -- reviewed postimages are staged in deterministic order.
  for (const change of unpublished.changes) {
    if (!appPath(input.appId, change.path)) {
      throw new Error(
        `Builder cannot reconcile unpublished change ${change.path}: it is outside apps/${input.appId}/.`,
      );
    }
    const relative = `${root.slice(workspaceRoot.length + 1)}/${change.path}`;
    if (change.kind === "deleted") {
      // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- preserve reviewed change order.
      await input.sandbox.removePath({ force: true, path: relative });
      continue;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- each reviewed file is read before staging.
    const file = await unpublished.contentSource.readFile(change.path);
    if (
      file === null ||
      file.digest !== change.after?.digest ||
      file.mode !== change.after.mode ||
      createHash("sha256").update(file.bytes).digest("hex") !== file.digest
    ) {
      throw new Error(
        `Builder's unpublished app file ${change.path} changed after review. Review it again before reconciling the draft.`,
      );
    }
    const directory = relative.slice(0, relative.lastIndexOf("/"));
    // oxlint-disable-next-line eslint/no-await-in-loop -- the directory must exist before its file.
    await ensureSandboxDirectories(input.sandbox, [directory]);
    // oxlint-disable-next-line eslint/no-await-in-loop -- stage each validated postimage.
    await input.sandbox.writeBinaryFile({ content: file.bytes, path: relative });
    const filePath = `${root}/${change.path}`;
    const fileMode = file.mode === "755" || file.mode === "100755" ? "755" : "644";
    // oxlint-disable-next-line eslint/no-await-in-loop -- apply exact reviewed mode.
    await checked(
      input.sandbox,
      `set mode for ${change.path}`,
      `chmod ${fileMode} ${quote(filePath)}`,
    );
  }
  await checked(
    input.sandbox,
    "stage unpublished app changes",
    git(root, ["add", "--all", "--", `apps/${input.appId}`]),
  );
  await checked(
    input.sandbox,
    "record unpublished app changes for local merge analysis",
    `${git(root, ["-c", "user.name=Autograph App Builder", "-c", "user.email=builder@autograph.so", "commit", "--no-verify", "--no-gpg-sign", "-m", "Local reviewed app changes for draft reconciliation"])} >/dev/null`,
  );
};

/** Prepare a private merge candidate. This never updates the GitHub PR branch. */
export const prepareDraftReconciliation = async (
  input: DraftReconciliationInput,
): Promise<PreparedDraftReconciliation> => {
  verifyInputs(input);
  const { sandbox } = input;
  const workspaceRoot = input.workspaceRoot ?? DEFAULT_WORKSPACE;
  const checkout = `${workspaceRoot}/repository`;
  const expectedRemote = `https://github.com/${input.repository.owner}/${input.repository.name}.git`;
  const remote = await checked(
    sandbox,
    "inspect the selected GitHub remote",
    git(checkout, ["remote", "get-url", "origin"]),
  );
  if (remote !== expectedRemote) {
    throw new Error(
      `Builder cannot reconcile the draft: its checkout is bound to ${redact(remote)}, not ${expectedRemote}. Select the intended repository again.`,
    );
  }
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        input.repository,
        input.headSha,
        input.baseSha,
        input.unpublished?.reviewDigest,
      ]),
    )
    .digest("hex");
  const root = `${workspaceRoot}/.app-builder/draft-reconcile/${key}`;
  const exists = await run(
    sandbox,
    "inspect the saved reconciliation candidate",
    `test -e ${quote(root)}`,
  );
  // oxlint-disable-next-line eslint/no-negated-condition, unicorn/no-negated-condition -- creation has the longer branch and recovery is handled after it.
  if (exists.exitCode !== 0) {
    const head = await checked(
      sandbox,
      "fetch the current draft head",
      git(checkout, ["fetch", "--no-tags", "origin", `refs/heads/${input.headBranch}`]),
    );
    void head;
    const fetchedHead = await checked(
      sandbox,
      "verify the fetched draft head",
      git(checkout, ["rev-parse", "FETCH_HEAD"]),
    );
    if (fetchedHead !== input.headSha) {
      throw new Error(
        `Builder's draft branch moved from ${input.headSha} to ${fetchedHead}. Re-observe the PR and review its current content before retrying.`,
      );
    }
    await checked(
      sandbox,
      "fetch the current base branch",
      git(checkout, ["fetch", "--no-tags", "origin", `refs/heads/${input.baseBranch}`]),
    );
    const fetchedBase = await checked(
      sandbox,
      "verify the fetched base branch",
      git(checkout, ["rev-parse", "FETCH_HEAD"]),
    );
    if (fetchedBase !== input.baseSha) {
      throw new Error(
        `Builder's base branch moved from ${input.baseSha} to ${fetchedBase}. Re-observe main and review the resulting resolution before retrying.`,
      );
    }
    await checked(
      sandbox,
      "create the isolated reconciliation directory",
      `mkdir -p ${quote(root.slice(0, root.lastIndexOf("/")))}`,
    );
    await checked(
      sandbox,
      "create the isolated reconciliation checkout",
      git(checkout, ["worktree", "add", "--detach", root, input.headSha]),
    );
    await stageUnpublished(input, root, workspaceRoot);
    const merge = await run(
      sandbox,
      "merge the base into the private draft candidate",
      mergeBase(root, input.baseSha),
    );
    const conflictOutput = await checked(
      sandbox,
      "inspect merge conflicts",
      git(root, UNMERGED_PATHS),
    );
    const conflicts = records(conflictOutput);
    if (merge.exitCode !== 0 && conflicts.length === 0) {
      throw new Error(
        `Builder could not merge the current base into the draft candidate (exit ${merge.exitCode}). Check the checkout and retry. Cause: ${redact(merge.stderr || merge.stdout) || "Git returned no diagnostic output."}`,
      );
    }
  } else {
    const merged = await run(
      sandbox,
      "inspect whether the saved candidate already contains the base",
      git(root, ["merge-base", "--is-ancestor", input.baseSha, "HEAD"]),
    );
    const inProgress = await run(
      sandbox,
      "inspect the saved candidate's merge state",
      git(root, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]),
    );
    if (merged.exitCode !== 0 && inProgress.exitCode !== 0) {
      const retry = await run(
        sandbox,
        "resume the base merge in the saved candidate",
        mergeBase(root, input.baseSha),
      );
      const conflicts = records(
        await checked(sandbox, "inspect resumed merge conflicts", git(root, UNMERGED_PATHS)),
      );
      if (retry.exitCode !== 0 && conflicts.length === 0) {
        throw new Error(
          `Builder could not resume the base merge in its saved candidate (exit ${retry.exitCode}). Check the isolated checkout and retry. Cause: ${redact(retry.stderr || retry.stdout) || "Git returned no diagnostic output."}`,
        );
      }
    }
  }
  const currentHead = await checked(
    sandbox,
    "inspect the isolated draft candidate",
    git(root, ["rev-parse", "HEAD"]),
  );
  if (currentHead !== input.headSha && input.unpublished === undefined) {
    throw new Error(
      `Builder's saved reconciliation checkout has a different head (${currentHead}). Re-observe the current draft before retrying.`,
    );
  }
  const conflictOutput = await checked(
    sandbox,
    "inspect unresolved app conflicts",
    git(root, UNMERGED_PATHS),
  );
  const conflicts = records(conflictOutput);
  const outside = conflicts.find((path) => !appPath(input.appId, path));
  if (outside !== undefined) {
    throw new Error(
      `Builder cannot resolve merge conflict at ${outside}: this path is outside apps/${input.appId}/. A repository owner must resolve it before Builder can continue this draft.`,
    );
  }
  return {
    appId: input.appId,
    baseSha: input.baseSha,
    baseTree: await inspectRevision(sandbox, checkout, input.baseSha),
    conflicts,
    headSha: input.headSha,
    headTree: await inspectRevision(sandbox, checkout, input.headSha),
    root,
    workspaceRoot,
  };
};

const safeResolutionProgram = String.raw`
const { lstatSync, realpathSync } = require("node:fs");
const { join } = require("node:path");
const root = realpathSync(process.argv[1]);
const parts = process.argv[2].split("/");
let current = root;
for (const part of parts) {
  current = join(current, part);
  try {
    if (lstatSync(current).isSymbolicLink()) throw Error("symlink in app path");
  } catch (error) {
    if (error.code === "ENOENT") break;
    throw error;
  }
}
`;

/** Write only an app-owned conflicted text file in the private merge candidate. */
export const writeDraftReconciliationResolution = async (input: {
  sandbox: SandboxSession;
  prepared: PreparedDraftReconciliation;
  path: string;
  content: string | null;
}): Promise<void> => {
  const { prepared, path } = input;
  if (!appPath(prepared.appId, path) || !prepared.conflicts.includes(path)) {
    throw new Error(
      `Builder cannot resolve ${path}: it is not an app-owned conflict in this draft candidate.`,
    );
  }
  await checked(
    input.sandbox,
    `verify the resolution path ${path}`,
    `node -e ${quote(safeResolutionProgram)} ${quote(prepared.root)} ${quote(path)}`,
  );
  const relative = `${prepared.root.slice(prepared.workspaceRoot.length + 1)}/${path}`;
  await (input.content === null
    ? input.sandbox.removePath({ force: true, path: relative })
    : input.sandbox.writeTextFile({ content: input.content, path: relative }));
};

/** Read the conflict markers for one app-owned path before proposing a resolution. */
export const readDraftReconciliationConflict = async (input: {
  sandbox: SandboxSession;
  prepared: PreparedDraftReconciliation;
  path: string;
}): Promise<string | null> => {
  const { prepared, path } = input;
  if (!appPath(prepared.appId, path) || !prepared.conflicts.includes(path)) {
    throw new Error(
      `Builder cannot read ${path}: it is not an app-owned conflict in this draft candidate.`,
    );
  }
  await checked(
    input.sandbox,
    `verify the conflict path ${path}`,
    `node -e ${quote(safeResolutionProgram)} ${quote(prepared.root)} ${quote(path)}`,
  );
  const relative = `${prepared.root.slice(prepared.workspaceRoot.length + 1)}/${path}`;
  try {
    return await input.sandbox.readTextFile({ path: relative });
  } catch (error) {
    throw new Error(
      `Builder could not read conflict content at ${path}. Resolve this app-owned file in a fresh candidate or inspect its Git stages. Cause: ${redact(error instanceof Error ? error.message : String(error)) || "The sandbox returned no detail."}`,
      { cause: error },
    );
  }
};

const diffPageProgram = String.raw`
const { spawnSync } = require("node:child_process");
const { closeSync, fstatSync, mkdtempSync, openSync, readSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const [root, from, to, appPath, cursorText] = process.argv.slice(1);
const cursor = Number(cursorText);
if (!Number.isSafeInteger(cursor) || cursor < 0) throw Error("Invalid diff cursor");
const directory = mkdtempSync(join(tmpdir(), "builder-draft-diff-"));
const output = join(directory, "diff");
const descriptor = openSync(output, "w+");
try {
  const result = spawnSync("git", ["-C", root, "diff", "--no-ext-diff", "--no-textconv", "--binary", from, to, "--", appPath], { stdio: ["ignore", descriptor, "pipe"], encoding: "utf8" });
  if (result.status !== 0) throw Error("Git diff failed: " + (result.stderr || "no diagnostic output"));
  const totalBytes = fstatSync(descriptor).size;
  if (cursor > totalBytes) throw Error("Diff cursor is past the end of the reviewed tree");
  const size = Math.min(32768, totalBytes - cursor);
  const buffer = Buffer.alloc(size);
  const length = readSync(descriptor, buffer, 0, size, cursor);
  console.log(JSON.stringify({ cursor, totalBytes, chunkBase64: buffer.subarray(0, length).toString("base64"), nextCursor: cursor + length < totalBytes ? cursor + length : null }));
} finally {
  closeSync(descriptor);
  rmSync(directory, { force: true, recursive: true });
}
`;

/** Page the exact resolved app diff against either parent without a total-size gate. */
export const readDraftReconciliationDiff = async (input: {
  sandbox: SandboxSession;
  prepared: PreparedDraftReconciliation;
  resolvedTree: string;
  against: "base" | "head";
  cursor?: number;
}): Promise<{
  cursor: number;
  nextCursor: number | null;
  totalBytes: number;
  chunkBase64: string;
}> => {
  if (!SHA.test(input.resolvedTree)) {
    throw new Error("Builder cannot read the resolution diff: the reviewed tree ID is invalid.");
  }
  const currentTree = await checked(
    input.sandbox,
    "verify the current resolved tree",
    git(input.prepared.root, ["write-tree"]),
  );
  if (currentTree !== input.resolvedTree) {
    throw new Error(
      "The resolved app changed after review. Inspect the current merge candidate and review both diffs again.",
    );
  }
  const from = input.against === "base" ? input.prepared.baseSha : input.prepared.headSha;
  const pathspec = input.against === "base" ? `apps/${input.prepared.appId}` : ".";
  const raw = await checked(
    input.sandbox,
    `read the resolved app diff against ${input.against}`,
    `node -e ${quote(diffPageProgram)} ${quote(input.prepared.root)} ${quote(from)} ${quote(input.resolvedTree)} ${quote(pathspec)} ${quote(String(input.cursor ?? 0))}`,
  );
  return z
    .strictObject({
      chunkBase64: z.string(),
      cursor: z.number().int().nonnegative(),
      nextCursor: z.number().int().nonnegative().nullable(),
      totalBytes: z.number().int().nonnegative(),
    })
    .parse(JSON.parse(raw));
};

const deltaProgram = String.raw`
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { closeSync, mkdtempSync, openSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const root = process.argv[1];
const base = process.argv[2];
const head = process.argv[3];
const git = (args) => {
  const directory = mkdtempSync(join(tmpdir(), "builder-git-output-"));
  const path = join(directory, "output");
  const descriptor = openSync(path, "w");
  try {
    const result = spawnSync("git", ["-C", root, ...args], { stdio: ["ignore", descriptor, "pipe"], encoding: "utf8" });
    if (result.status !== 0) throw Error(result.stderr || "Git operation failed: " + args.join(" "));
    return readFileSync(path);
  } finally {
    closeSync(descriptor);
    rmSync(directory, { force: true, recursive: true });
  }
};
const digest = (oid) => createHash("sha256").update(git(["cat-file", "blob", oid])).digest("hex");
const mode = (value, path) => {
  if (value === "100644") return "644";
  if (value === "100755") return "755";
  throw Error("Unsupported file mode " + value + " at " + path);
};
const changes = (from, to) => {
  const data = git(["diff", "--raw", "--no-renames", "-z", "--full-index", from, to]);
  const records = data.toString("utf8").split("\0");
  const result = [];
  for (let i = 0; i < records.length - 1; i += 2) {
    const header = records[i];
    const path = records[i + 1];
    if (!header || !path || !header.startsWith(":")) throw Error("Invalid Git diff record");
    const [oldMode, newMode, oldOid, newOid, status] = header.slice(1).split(" ");
    if (!/^[AMD]$/.test(status)) throw Error("Unsupported Git change " + status + " at " + path);
    const kind = status === "A" ? "added" : status === "D" ? "deleted" : "modified";
    result.push({ path, kind,
      ...(kind === "added" ? {} : { before: { mode: mode(oldMode, path), digest: digest(oldOid) } }),
      ...(kind === "deleted" ? {} : { after: { mode: mode(newMode, path), digest: digest(newOid) } }),
    });
  }
  return result;
};
const resolvedTree = git(["write-tree"]).toString("utf8").trim();
console.log(JSON.stringify({ resolvedTree, baseChanges: changes(base, resolvedTree), headChanges: changes(head, resolvedTree) }));
`;

export const inspectDraftReconciliation = async (input: {
  sandbox: SandboxSession;
  prepared: PreparedDraftReconciliation;
}): Promise<{
  resolvedTree: string;
  baseChanges: readonly OverlayChange[];
  headChanges: readonly OverlayChange[];
  unresolvedConflicts: readonly string[];
}> => {
  const { sandbox, prepared } = input;
  const unstaged = records(
    await checked(
      sandbox,
      "inspect unstaged reconciliation changes",
      git(prepared.root, [DIFF_COMMAND, NAME_ONLY, ZERO_TERMINATED]),
    ),
  );
  const untracked = records(
    await checked(
      sandbox,
      "inspect untracked reconciliation changes",
      git(prepared.root, ["ls-files", "--others", "--exclude-standard", ZERO_TERMINATED]),
    ),
  );
  const outside = [...unstaged, ...untracked].find((path) => !appPath(prepared.appId, path));
  if (outside !== undefined) {
    throw new Error(
      `Builder cannot accept reconciliation edit ${outside}: only apps/${prepared.appId}/ may be edited while resolving this draft.`,
    );
  }
  await checked(
    sandbox,
    "stage resolved app files",
    git(prepared.root, ["add", "--all", "--", `apps/${prepared.appId}`]),
  );
  const unresolvedConflicts = records(
    await checked(
      sandbox,
      "inspect unresolved merge paths",
      git(prepared.root, ["diff", "--name-only", "--diff-filter=U", "-z"]),
    ),
  );
  if (unresolvedConflicts.length > 0) {
    return { baseChanges: [], headChanges: [], resolvedTree: "", unresolvedConflicts };
  }
  await checked(
    sandbox,
    "check the resolved merge for whitespace and conflict markers",
    git(prepared.root, ["diff", "--cached", "--check"]),
  );
  const raw = await checked(
    sandbox,
    "inspect the resolved merge tree and both diffs",
    `node -e ${quote(deltaProgram)} ${quote(prepared.root)} ${quote(prepared.baseSha)} ${quote(prepared.headSha)}`,
  );
  const changeSchema = z.strictObject({
    after: z.strictObject({ digest: z.string(), mode: z.string() }).optional(),
    before: z.strictObject({ digest: z.string(), mode: z.string() }).optional(),
    kind: z.enum(["added", "modified", "deleted"]),
    path: z.string().refine(safeSourcePath),
  });
  const parsed = z
    .strictObject({
      baseChanges: z.array(changeSchema),
      headChanges: z.array(changeSchema),
      resolvedTree: z.string().regex(SHA),
    })
    .parse(JSON.parse(raw));
  const nonAppChange = parsed.baseChanges.find((change) => !appPath(prepared.appId, change.path));
  if (nonAppChange !== undefined) {
    throw new Error(
      `Builder's resolved PR differs from main at ${nonAppChange.path}, outside apps/${prepared.appId}/. Restore main's content there before review.`,
    );
  }
  return { ...parsed, unresolvedConflicts: [] };
};
