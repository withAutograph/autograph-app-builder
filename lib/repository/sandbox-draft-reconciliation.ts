import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";

import type { GitHubDraftPullRequestContentSource } from "./github-publication";
import {
  assertOwnedPublicationReconciliationOrigin,
  assertOwnedPublicationReconciliationScope,
} from "./github-draft-reconciliation";
import type { OwnedPublicationReconciliationScope } from "./github-draft-reconciliation";
import { ensureSandboxDirectories } from "./sandbox-filesystem";
import { safeSourcePath } from "./source-path";
import { attachCheckoutDependencyView } from "./dependency-cache";
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
  /** Server-retained private candidate; replay authority is checked by the prepare tool. */
  previousCandidate?: PreparedDraftReconciliation;
  replayPreviousCandidate?: boolean;
  /** Explicit owned-draft reopening preserves all previous roots and creates a new private candidate. */
  forceFreshCandidate?: boolean;
  ownedPublication?: Pick<OwnedPublicationReconciliationScope, "proposal" | "publication">;
  unpublished?: {
    reviewDigest: string;
    /** Exact original publication head, resolved from this workflow's tenant receipt. */
    priorPublishedHeadSha?: string;
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
  publicationScope?: OwnedPublicationReconciliationScope;
}

/** A saved candidate is sandbox-local; an expired sandbox can retain its receipt but not its files. */
export const assertDraftReconciliationCandidateAvailable = async (input: {
  sandbox: SandboxSession;
  prepared: PreparedDraftReconciliation;
}): Promise<void> => {
  const result = await run(
    input.sandbox,
    "inspect the private draft candidate",
    git(input.prepared.root, ["rev-parse", "--show-prefix", "--is-inside-work-tree"]),
  );
  if (result.exitCode !== 0 || result.stdout.trim() !== "true") {
    throw new Error(
      "Builder's private draft merge candidate is no longer in this sandbox. The sandbox may have expired; its uncommitted conflict resolutions and edits cannot be assumed to survive. Run prepare_github_draft_pr_reconciliation for this PR again to rebuild from the verified branch commits, then resolve any conflicts, rerun validation, review the changed source, and request exact outward update approval. Nothing was published.",
    );
  }
};

const candidateNeedsCreation = async (sandbox: SandboxSession, root: string): Promise<boolean> => {
  const exists = await run(
    sandbox,
    "inspect the saved reconciliation candidate",
    `test -e ${quote(root)}`,
  );
  if (exists.exitCode === 0) {
    return false;
  }
  if (exists.exitCode === 1) {
    return true;
  }
  throw new Error(
    `Builder could not inspect the private draft candidate (exit ${exists.exitCode}). Check the sandbox command runner before retrying; no candidate was replaced. Cause: ${redact(exists.stderr || exists.stdout) || "The command returned no diagnostic output."}`,
  );
};

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
    ...(input.unpublished?.priorPublishedHeadSha === undefined
      ? []
      : [[SHA, input.unpublished.priorPublishedHeadSha] as const]),
  ] as const;
  if (fields.some(([pattern, value]) => !pattern.test(value))) {
    throw new Error(INVALID_INPUT);
  }
  if (input.ownedPublication !== undefined) {
    assertOwnedPublicationReconciliationOrigin(input.ownedPublication);
    const { proposal } = input.ownedPublication;
    if (
      proposal.owner !== input.repository.owner ||
      proposal.name !== input.repository.name ||
      proposal.branchName !== input.headBranch ||
      proposal.baseBranch !== input.baseBranch
    ) {
      throw new Error("The owned publication does not match the selected reconciliation branches.");
    }
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
const { chmodSync, closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readSync, renameSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const [root, path, revision, operation] = process.argv.slice(1);
const entry = spawnSync("git", ["--literal-pathspecs", "-C", root, "ls-tree", "-z", revision, "--", path], { encoding: "utf8" });
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
  if (operation === "restore") {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    const replacement = mkdtempSync(join(dirname(destination), ".builder-restore-"));
    try {
      const file = join(replacement, "blob");
      copyFileSync(join(directory, "blob"), file);
      chmodSync(file, match[1] === "100755" ? 0o755 : 0o644);
      renameSync(file, destination);
    } finally {
      rmSync(replacement, { force: true, recursive: true });
    }
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
  revision = "HEAD",
): Promise<{ digest: string; mode: "644" | "755" } | null> => {
  const raw = await checked(
    sandbox,
    `inspect draft file ${path}`,
    `node -e ${quote(preimageProgram)} ${quote(root)} ${quote(path)} ${quote(revision)}`,
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
  const candidates = unpublished.changes.filter(
    (change, index) =>
      !matchesFileState(observed[index] ?? null, change.after) &&
      !matchesFileState(observed[index] ?? null, change.before),
  );
  const { priorPublishedHeadSha } = unpublished;
  const observedByPath = new Map(
    unpublished.changes.map((change, index) => [change.path, observed[index] ?? null]),
  );
  const unchangedPublished = new Set<string>();
  if (priorPublishedHeadSha !== undefined) {
    await Promise.all(
      candidates.map(async (change) => {
        const original = await currentFileState(
          input.sandbox,
          root,
          change.path,
          priorPublishedHeadSha,
        );
        if (isDeepStrictEqual(observedByPath.get(change.path) ?? null, original)) {
          unchangedPublished.add(change.path);
        }
      }),
    );
  }
  const changedPreimage = candidates.find((change) => !unchangedPublished.has(change.path));
  if (changedPreimage !== undefined) {
    throw new Error(
      `Builder cannot replay reviewed change ${changedPreimage.path}: the current draft head matches neither its reviewed starting content nor the complete reviewed result. Reopen the current PR head and review its files again.`,
    );
  }
  const pendingChanges = unpublished.changes.filter(
    (change, index) => !matchesFileState(observed[index] ?? null, change.after),
  );
  // oxlint-disable-next-line react-doctor/async-await-in-loop -- reviewed postimages are staged in deterministic order.
  for (const change of pendingChanges) {
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
    let file: Awaited<ReturnType<typeof unpublished.contentSource.readFile>>;
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each reviewed postimage is loaded in order.
      file = await unpublished.contentSource.readFile(change.path);
    } catch (error) {
      throw new Error(
        `Builder could not recover unpublished app file ${change.path} from the previous checkout. Its sandbox may have expired before those bytes reached the draft branch. Reopen the current app, recreate and review the missing edit, then prepare a new reconciliation. Cause: ${redact(error instanceof Error ? error.message : String(error)) || "The source returned no detail."}`,
        { cause: error },
      );
    }
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

const ownedDependencyRootProgram = String.raw`
const ownedDependencyRoot = (root, workspace, relative) => {
  if (relative.split("/").at(-1) !== "node_modules") return false;
  const fs = require("node:fs");
  const path = require("node:path");
  const entry = path.join(root, relative);
  if (!fs.lstatSync(entry, { throwIfNoEntry: false })?.isSymbolicLink()) return false;
  const key = require("node:crypto").createHash("sha256").update(root).digest("hex");
  const expected = path.join(fs.realpathSync(workspace), ".app-builder/dependency-views/checkout", key, relative);
  return path.resolve(path.dirname(entry), fs.readlinkSync(entry)) === expected;
};
`;

const candidateUntrackedProgram = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const [root, workspace] = process.argv.slice(1);
${ownedDependencyRootProgram}
const directory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "builder-untracked-"));
const output = path.join(directory, "paths");
const descriptor = fs.openSync(output, "w");
try {
  const result = spawnSync("git", ["--no-optional-locks", "-C", root, "ls-files", "--others", "--exclude-standard", "-z"], { stdio: ["ignore", descriptor, "pipe"], encoding: "utf8" });
  if (result.status !== 0) throw Error(result.stderr || "Git untracked read failed");
  const paths = fs.readFileSync(output, "utf8").split("\0").filter(Boolean);
  const dependencyRoots = paths.filter(relative => ownedDependencyRoot(root, workspace, relative));
  console.log(JSON.stringify({ paths: paths.filter(relative => !dependencyRoots.includes(relative)), dependencyRoots }));
} finally { fs.closeSync(descriptor); fs.rmSync(directory, { force: true, recursive: true }); }
`;

const candidateUntracked = async (sandbox: SandboxSession, root: string, workspace: string) =>
  z
    .strictObject({ paths: z.array(z.string()), dependencyRoots: z.array(z.string()) })
    .parse(
      JSON.parse(
        await checked(
          sandbox,
          "inspect private candidate untracked files",
          `node -e ${quote(candidateUntrackedProgram)} ${quote(root)} ${quote(workspace)}`,
        ),
      ),
    );

/** Git's stage-zero entries preserve inherited main and originally published non-app content. */
const nonAppIndexDigest = async (sandbox: SandboxSession, root: string, appId: string) => {
  const result = await run(
    sandbox,
    "inspect the automatic merge index",
    git(root, ["ls-files", "--stage", "-z"]),
  );
  if (result.exitCode !== 0) {
    throw new Error(`Builder could not inspect the merge index (exit ${result.exitCode}).`);
  }
  const entries = records(result.stdout).filter((entry) => {
    const match = /^(?<mode>\d{6}) (?<blob>[a-f0-9]+) (?<stage>[0-3])\t(?<path>[\s\S]+)$/u.exec(
      entry,
    );
    if (match === null) {
      throw new Error("Git returned an unreadable merge index entry.");
    }
    if (appPath(appId, match.groups?.path ?? "")) {
      return false;
    }
    if (match.groups?.stage !== "0") {
      throw new Error(
        "A repository owner must resolve non-app merge conflicts before Builder can continue.",
      );
    }
    return true;
  });
  return createHash("sha256").update(JSON.stringify(entries.toSorted())).digest("hex");
};

const retainedPublicationScope = (input: DraftReconciliationInput, root: string) => {
  const previous = input.previousCandidate;
  const scope = previous?.publicationScope;
  if (
    // oxlint-disable-next-line sonarjs/expression-complexity -- All retained candidate and original publication fields must match before reusing merge provenance.
    input.ownedPublication === undefined ||
    previous === undefined ||
    scope === undefined ||
    previous.root !== root ||
    previous.headSha !== input.headSha ||
    previous.baseSha !== input.baseSha ||
    !isDeepStrictEqual(
      { proposal: scope.proposal, publication: scope.publication },
      input.ownedPublication,
    )
  ) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Keep optional retained scope explicit on both return branches.
    return undefined;
  }
  assertOwnedPublicationReconciliationScope(scope);
  return scope;
};

const outsideCandidateChanges = async (
  input: DraftReconciliationInput,
  root: string,
): Promise<boolean> => {
  if (input.ownedPublication !== undefined) {
    const scope = retainedPublicationScope(input, root);
    if (
      scope === undefined ||
      scope.automaticMergeNonAppDigest !==
        (await nonAppIndexDigest(input.sandbox, root, input.appId))
    ) {
      return true;
    }
    const unstaged = records(
      await checked(
        input.sandbox,
        "inspect private candidate changes",
        git(root, [DIFF_COMMAND, NAME_ONLY, ZERO_TERMINATED]),
      ),
    );
    const { paths: untracked } = await candidateUntracked(
      input.sandbox,
      root,
      input.workspaceRoot ?? DEFAULT_WORKSPACE,
    );
    return [...unstaged, ...untracked].some((path) => !appPath(input.appId, path));
  }
  const merge = await run(
    input.sandbox,
    "inspect the private candidate merge state",
    git(root, ["rev-parse", "--quiet", "--verify", "MERGE_HEAD"]),
  );
  if (merge.exitCode !== 0 && merge.exitCode !== 1) {
    throw new Error(
      `Builder could not inspect its private candidate merge state (exit ${merge.exitCode}). The old candidate remains intact. Cause: ${redact(merge.stderr || merge.stdout)}`,
    );
  }
  const baseline = merge.exitCode === 0 ? input.baseSha : "HEAD";
  const changed = records(
    await checked(
      input.sandbox,
      "inspect private candidate changes",
      git(root, [
        "--no-optional-locks",
        DIFF_COMMAND,
        "--no-renames",
        NAME_ONLY,
        ZERO_TERMINATED,
        baseline,
        "--",
      ]),
    ),
  );
  const { paths: untracked } = await candidateUntracked(
    input.sandbox,
    root,
    input.workspaceRoot ?? DEFAULT_WORKSPACE,
  );
  return [...changed, ...untracked].some((path) => !appPath(input.appId, path));
};

const replayCandidateProgram = String.raw`
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, rmdirSync, chmodSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const [oldRoot, newRoot, head, base, app, workspace, previousBase] = process.argv.slice(1);
${ownedDependencyRootProgram}
const git = (root, args, input, options = {}) => {
  const temporary = mkdtempSync(join(tmpdir(), "builder-candidate-git-"));
  const output = join(temporary, "output");
  const fd = openSync(output, "w");
  try {
    const result = spawnSync("git", ["--no-optional-locks", "-C", root, ...args], {input, stdio:[options.stdin ?? "pipe",options.stdout ?? fd,"pipe"], encoding:"utf8", env:{...process.env,GIT_OPTIONAL_LOCKS:"0",...options.environment}});
    if(result.status !== 0 && !(options.allowConflict && result.status === 1)) throw Error(result.stderr || "Candidate Git read/replay failed");
    return readFileSync(output);
  } finally {closeSync(fd);rmSync(temporary,{force:true,recursive:true});}
};
const records = bytes => bytes.toString("utf8").split("\0").filter(Boolean);
const appPath = path => path.startsWith("apps/" + app + "/") && !path.split("/").some(part => !part || part === "." || part === ".." || part === ".git" || part.includes("\\"));
const file = (root, path) => {
  if (!appPath(path)) throw Error("Cannot preserve unsafe candidate app path");
  let current = root;
  for (const part of path.split("/")) {
    current = join(current,part);
    try {if(lstatSync(current).isSymbolicLink()) throw Error("Cannot preserve candidate symlink at " + path);}
    catch(error) {if(error.code === "ENOENT" || error.code === "ENOTDIR") return null;throw error;}
  }
  const stat=lstatSync(current);
  if(stat.isDirectory()) return null;
  if(!stat.isFile()) throw Error("Cannot preserve non-file candidate path " + path);
  return {path:current,mode:stat.mode & 511};
};
const hash = path => {
  const fd=openSync(path,"r");const digest=createHash("sha256");const buffer=Buffer.alloc(65536);let position=0;
  try {for(;;){const count=readSync(fd,buffer,0,buffer.length,position);if(!count)break;digest.update(buffer.subarray(0,count));position+=count;}return digest.digest("hex");}finally{closeSync(fd);}
};
// Base advancement is a three-way merge, never an overwrite of the new base's app files.
if (previousBase && previousBase !== base) {
  const temporary = mkdtempSync(join(tmpdir(), "builder-candidate-merge-"));
  const indexEnvironment = { GIT_INDEX_FILE: join(temporary, "index") };
  const scoped = ["--", "apps/" + app];
  const indexPath = git(oldRoot,["rev-parse","--git-path","index"]).toString("utf8").trim();
  const oldIndex = hash(indexPath);
  const oldHead = git(oldRoot,["rev-parse","HEAD"]);
  const oldUnmerged = git(oldRoot,["ls-files","--unmerged","-z",...scoped]);
  const entries = revision => new Map(records(git(oldRoot,["ls-tree","-r","-z",revision,...scoped])).map(record => {
    const match = /^(100644|100755) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(record);
    if (!match || !appPath(match[3])) throw Error("Cannot merge unsupported candidate app entry");
    return [match[3], {mode:match[1],object:match[2]}];
  }));
  const workingPaths = () => [...new Set(records(git(oldRoot,["ls-files","--cached","--others","--exclude-standard","-z",...scoped])).filter(relative => !ownedDependencyRoot(oldRoot,workspace,relative)))].sort();
  const originalPaths = workingPaths();
  const snapshot = new Map(originalPaths.map(path => {
    const observed = file(oldRoot,path);
    return [path,observed===null?null:{mode:observed.mode,digest:hash(observed.path)}];
  }));
  const unchanged = () => {
    if (JSON.stringify(workingPaths())!==JSON.stringify(originalPaths) || !git(oldRoot,["rev-parse","HEAD"]).equals(oldHead) || hash(indexPath)!==oldIndex || !git(oldRoot,["ls-files","--unmerged","-z",...scoped]).equals(oldUnmerged)) throw Error("Original candidate changed during three-way replay; old candidate retained");
    for (const [path,observed] of snapshot) {
      const current=file(oldRoot,path);
      if(observed===null?current!==null:current===null||current.mode!==observed.mode||hash(current.path)!==observed.digest) throw Error("Original candidate app changed during three-way replay at " + path);
    }
  };
  const removed = path => "0 " + "0".repeat(40) + "\t" + path;
  const indexed = (path,entry,stage) => entry.mode + " " + entry.object + (stage===undefined?"":" "+stage) + "\t" + path;
  const updateIndex = (root,lines,environment) => {
    if(lines.length) git(root,["update-index","-z","--index-info"],lines.join("\0")+"\0",{environment});
  };
  try {
    const ancestor = entries(previousBase);
    const incoming = entries(base);
    git(oldRoot,["read-tree",previousBase],undefined,{environment:indexEnvironment});
    updateIndex(oldRoot,[...ancestor.keys()].map(removed),indexEnvironment);
    const authored = new Map();
    for(const [path,observed] of snapshot) {
      if(observed===null) continue;
      const fd=openSync(join(oldRoot,path),"r");
      let object;
      try { object=git(oldRoot,["hash-object","-w","--stdin","--no-filters"],undefined,{stdin:fd}).toString("utf8").trim(); }
      finally {closeSync(fd);}
      authored.set(path,{mode:observed.mode & 73 ? "100755":"100644",object});
    }
    updateIndex(oldRoot,[...authored].map(([path,entry])=>indexed(path,entry)),indexEnvironment);
    const tree=git(oldRoot,["write-tree"],undefined,{environment:indexEnvironment}).toString("utf8").trim();
    const privateCommit = (tree,message) => git(oldRoot,["-c","user.name=Autograph App Builder","-c","user.email=builder@autograph.so","-c","commit.gpgsign=false","commit-tree",tree,"-p",previousBase],message).toString("utf8").trim();
    const commit=privateCommit(tree,"Private candidate app snapshot for base reconciliation\n");
    // Sibling commits make previousBase the explicit ancestor with the existing merge-tree API,
    // including when the current base's public history was rewritten. Neither updates a ref.
    const incomingTree=git(oldRoot,["rev-parse",base+"^{tree}"]).toString("utf8").trim();
    const incomingCommit=privateCommit(incomingTree,"Current base tree for private candidate reconciliation\n");
    const output=records(git(oldRoot,["merge-tree","--write-tree","--no-messages","-z",commit,incomingCommit],undefined,{allowConflict:true}));
    const mergedTree=output.shift();
    if(!/^[a-f0-9]{40}$/.test(mergedTree ?? "")) throw Error("Git returned no candidate merge tree");
    const merged=entries(mergedTree);
    const conflicts=new Map();
    for(const record of output) {
      const match=/^(100644|100755) ([a-f0-9]+) ([123])\t([\s\S]+)$/.exec(record);
      if(!match || !appPath(match[4])) throw Error("Git returned an unsupported candidate conflict");
      const lines=conflicts.get(match[4]) ?? [];lines.push(record);conflicts.set(match[4],lines);
    }
    const priorConflicts=new Map();
    for(const record of records(oldUnmerged)) {
      const path=record.slice(record.indexOf("\t")+1);
      const lines=priorConflicts.get(path) ?? [];lines.push(record);priorConflicts.set(path,lines);
    }
    for(const [path,lines] of priorConflicts) {
      if(JSON.stringify(ancestor.get(path))===JSON.stringify(incoming.get(path))) {
        conflicts.set(path,lines);
        if(authored.has(path)) merged.set(path,authored.get(path));else merged.delete(path);
      } else if(!conflicts.has(path)) {
        // A formerly unresolved file cannot become resolved merely by checkpointing its bytes.
        conflicts.set(path,[ancestor.get(path),authored.get(path),incoming.get(path)].flatMap((entry,index)=>entry?[indexed(path,entry,index+1)]:[]));
      }
    }
    unchanged();
    const currentPaths=[...new Set(records(git(newRoot,["ls-files","--cached","--others","--exclude-standard","-z",...scoped])).filter(relative => !ownedDependencyRoot(newRoot,workspace,relative)))];
    for(const path of currentPaths.filter(path=>!merged.has(path)).sort((a,b)=>b.split("/").length-a.split("/").length)) {
      const current=file(newRoot,path);
      if(current!==null) {
        rmSync(current.path);
        const parts=path.split("/");parts.pop();
        while(parts.length>2) {
          try {rmdirSync(join(newRoot,...parts));} catch(error) {if(error.code==="ENOTEMPTY"||error.code==="EEXIST")break;if(error.code!=="ENOENT")throw error;}
          parts.pop();
        }
      }
    }
    for(const [path,entry] of merged) {
      file(newRoot,path);
      const parts=path.split("/");parts.pop();let parent=newRoot;
      for(const part of parts){parent=join(parent,part);if(!existsSync(parent))mkdirSync(parent);const stat=lstatSync(parent);if(stat.isSymbolicLink()||!stat.isDirectory())throw Error("Candidate replay parent is not an owned directory");}
      const destination=join(newRoot,path);
      if(existsSync(destination)&&lstatSync(destination).isDirectory())rmdirSync(destination);
      const fd=openSync(destination,"w");
      try {git(oldRoot,["cat-file","blob",entry.object],undefined,{stdout:fd});} finally {closeSync(fd);}
      chmodSync(destination,entry.mode==="100755"?493:420);
    }
    updateIndex(newRoot,[...currentPaths.map(removed),...[...merged].map(([path,entry])=>indexed(path,entry))]);
    updateIndex(newRoot,[...[...conflicts.keys()].map(removed),...[...conflicts.values()].flat()]);
    unchanged();
    console.log("preserved");
  } finally {rmSync(temporary,{recursive:true,force:true});}
  process.exit(0);
}

const scoped=["--","apps/"+app];
const paths=[...new Set([
  ...records(git(oldRoot,["diff","--no-renames","--name-only","-z",head,...scoped])),
  ...records(git(oldRoot,["diff","--no-renames","--name-only","-z",base,...scoped])),
  ...records(git(oldRoot,["ls-files","--others","--exclude-standard","-z",...scoped])).filter(relative => !ownedDependencyRoot(oldRoot, workspace, relative)),
])].sort();
const unmerged=git(oldRoot,["ls-files","--unmerged","-z",...scoped]);
const oldHead=git(oldRoot,["rev-parse","HEAD"]).toString("utf8");
const indexPath=git(oldRoot,["rev-parse","--git-path","index"]).toString("utf8").trim();
const oldIndex=hash(indexPath);
const snapshot=paths.map(path=>{const observed=file(oldRoot,path);return {path,observed:observed===null?null:{mode:observed.mode,digest:hash(observed.path)}};});
const appRoot=join(newRoot,"apps",app);
const pruneEmptyParents = path => {
  const parts=path.split("/");parts.pop();
  let parent=join(newRoot,...parts);
  while(parent!==appRoot){
    try{rmdirSync(parent);}catch(error){if(error.code==="ENOTEMPTY"||error.code==="EEXIST")break;if(error.code!=="ENOENT")throw error;}
    parts.pop();parent=join(newRoot,...parts);
  }
};
const deletions=snapshot.filter(entry=>entry.observed===null).sort((a,b)=>b.path.split("/").length-a.path.split("/").length);
for(const {path} of deletions){
  const existing=file(newRoot,path);
  if(existing!==null){rmSync(existing.path);pruneEmptyParents(path);}
}
for(const {path,observed} of snapshot){
  if(observed===null)continue;
  file(newRoot,path);
  const target=join(newRoot,path);
  if(existsSync(target)&&lstatSync(target).isDirectory())rmdirSync(target);
  let parent=newRoot;
  const parts=path.split("/");parts.pop();
  for(const part of parts){parent=join(parent,part);if(!existsSync(parent))mkdirSync(parent);const stat=lstatSync(parent);if(stat.isSymbolicLink()||!stat.isDirectory())throw Error("Candidate replay parent is not an owned directory");}
  copyFileSync(join(oldRoot,path),target);chmodSync(target,observed.mode);
  if(hash(target)!==observed.digest)throw Error("Candidate app copy could not be verified at " + path);
}
git(newRoot,["add","--all",...scoped]);
const unresolvedPaths=[...new Set(records(unmerged).map(record=>record.slice(record.indexOf("\t")+1)))];
if(unresolvedPaths.length){git(newRoot,["update-index","--force-remove","--",...unresolvedPaths]);git(newRoot,["update-index","-z","--index-info"],unmerged);}
for(const {path,observed} of snapshot){
  const before=file(oldRoot,path);const after=file(newRoot,path);
  if(observed===null){if(before!==null||after!==null)throw Error("Candidate deletion changed during preservation at " + path);}
  else if(before===null||after===null||before.mode!==observed.mode||after.mode!==observed.mode||hash(before.path)!==observed.digest||hash(after.path)!==observed.digest)throw Error("Candidate app changed during preservation at " + path);
}
if(!git(newRoot,["ls-files","--unmerged","-z",...scoped]).equals(unmerged)||!git(oldRoot,["ls-files","--unmerged","-z",...scoped]).equals(unmerged)||git(oldRoot,["rev-parse","HEAD"]).toString("utf8")!==oldHead||hash(indexPath)!==oldIndex)throw Error("Candidate merge state changed during preservation; old candidate retained");
console.log("preserved");
`;

const replayCandidateApp = async (
  input: DraftReconciliationInput,
  oldRoot: string,
  newRoot: string,
) => {
  try {
    await checked(
      input.sandbox,
      "preserve app repairs in a fresh private candidate",
      `node -e ${quote(replayCandidateProgram)} ${[oldRoot, newRoot, input.headSha, input.baseSha, input.appId, input.workspaceRoot ?? DEFAULT_WORKSPACE, input.previousCandidate?.baseSha ?? input.baseSha].map(quote).join(" ")}`,
    );
  } catch (error) {
    throw new Error(
      `Builder could not preserve every app repair in a fresh private candidate. The original candidate at ${oldRoot} remains intact; no candidate was replaced or published. Inspect its app conflicts and retry preparation. Cause: ${redact(error instanceof Error ? error.message : String(error))}`,
      { cause: error },
    );
  }
};

const readCandidateConflicts = async (
  input: DraftReconciliationInput,
  root: string,
): Promise<string[]> => {
  const { sandbox } = input;
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
  return conflicts;
};

const selectCandidateRoot = async (
  input: DraftReconciliationInput,
  workspaceRoot: string,
  canonicalRoot: string,
) => {
  const previous = input.previousCandidate;
  const replayEligible =
    input.forceFreshCandidate !== true &&
    previous !== undefined &&
    input.replayPreviousCandidate === true &&
    [
      previous.appId === input.appId,
      previous.headSha === input.headSha,
      previous.workspaceRoot === workspaceRoot,
      previous.root.startsWith(`${workspaceRoot}/.app-builder/draft-reconcile/`),
      /^[-a-f0-9]+$/u.test(
        previous.root.slice(`${workspaceRoot}/.app-builder/draft-reconcile/`.length),
      ),
    ].every(Boolean);
  const advancedBase = replayEligible && previous.baseSha !== input.baseSha;
  let root = replayEligible && !advancedBase ? previous.root : canonicalRoot;
  let created = await candidateNeedsCreation(input.sandbox, root);
  let preservedCandidateRoot: string | undefined;
  let replayedAppChanges = false;
  const changedLineage = previous !== undefined && !replayEligible;
  const needsFreshRoot = input.forceFreshCandidate === true || advancedBase || changedLineage;
  if (needsFreshRoot || (!created && (await outsideCandidateChanges(input, root)))) {
    preservedCandidateRoot = previous?.root ?? (created ? undefined : root);
    root = `${canonicalRoot}-${randomUUID()}`;
    created = true;
    replayedAppChanges = replayEligible && preservedCandidateRoot === previous.root;
    if (advancedBase && (await candidateNeedsCreation(input.sandbox, previous.root))) {
      preservedCandidateRoot = undefined;
      replayedAppChanges = false;
    }
  }
  return { root, created, preservedCandidateRoot, replayedAppChanges };
};

/** Prepare a private merge candidate. This never updates the GitHub PR branch. */
/* oxlint-disable eslint/complexity, sonarjs/cognitive-complexity -- Ordered native Git preparation preserves existing candidate recovery and publication provenance. */
export const prepareDraftReconciliation = async (
  input: DraftReconciliationInput,
): Promise<
  PreparedDraftReconciliation & {
    created: boolean;
    preservedCandidateRoot?: string;
    replayedAppChanges?: boolean;
  }
> => {
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
  const canonicalRoot = `${workspaceRoot}/.app-builder/draft-reconcile/${key}`;
  const { root, created, preservedCandidateRoot, replayedAppChanges } = await selectCandidateRoot(
    input,
    workspaceRoot,
    canonicalRoot,
  );
  // oxlint-disable-next-line eslint/no-negated-condition, unicorn/no-negated-condition -- creation has the longer branch and recovery is handled after it.
  if (created) {
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
      await stageUnpublished(input, root, workspaceRoot);
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
  // Capture only a newly created native merge, before replay or any app edits.
  let publicationScope: OwnedPublicationReconciliationScope | undefined;
  if (input.ownedPublication !== undefined) {
    publicationScope = created
      ? {
          kind: "owned-publication",
          ...input.ownedPublication,
          automaticMergeNonAppDigest: await nonAppIndexDigest(sandbox, root, input.appId),
        }
      : retainedPublicationScope(input, root);
  }
  if (input.ownedPublication !== undefined && publicationScope === undefined) {
    throw new Error("Reprepare this owned draft to retain its automatic merge provenance.");
  }
  if (replayedAppChanges && preservedCandidateRoot !== undefined) {
    await replayCandidateApp(input, preservedCandidateRoot, root);
  }
  await attachCheckoutDependencyView({
    sandbox,
    checkoutRoot: checkout,
    candidateRoot: root,
    workspaceRoot,
  });
  const conflicts = await readCandidateConflicts(input, root);
  return {
    appId: input.appId,
    baseSha: input.baseSha,
    baseTree: await inspectRevision(sandbox, checkout, input.baseSha),
    conflicts,
    created,
    ...(publicationScope === undefined ? {} : { publicationScope }),
    ...(preservedCandidateRoot === undefined ? {} : { preservedCandidateRoot, replayedAppChanges }),
    headSha: input.headSha,
    headTree: await inspectRevision(sandbox, checkout, input.headSha),
    root,
    workspaceRoot,
  };
};
/* oxlint-enable eslint/complexity, sonarjs/cognitive-complexity */

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
  await assertDraftReconciliationCandidateAvailable(input);
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
  await assertDraftReconciliationCandidateAvailable(input);
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

const candidateFilePageProgram = String.raw`
const { createHash } = require("node:crypto");
const { closeSync, fstatSync, openSync, readSync } = require("node:fs");
const { join } = require("node:path");
const [root, path, cursorText, expectedDigest] = process.argv.slice(1);
const requestedCursor = Number(cursorText);
if (!Number.isSafeInteger(requestedCursor) || requestedCursor < 0) throw Error("Invalid file cursor");
const pageBytes = 32768;
const first = Buffer.alloc(pageBytes);
const requested = Buffer.alloc(pageBytes);
const block = Buffer.alloc(65536);
const hash = createHash("sha256");
// Match SandboxSession.readTextFile: reject invalid UTF-8 and consume an initial BOM.
const decoder = new TextDecoder("utf-8", { fatal: true });
let totalBytes = 0;
const retain = (text) => {
  hash.update(text);
  const bytes = Buffer.from(text, "utf8");
  if (totalBytes < pageBytes) bytes.copy(first, totalBytes, 0, Math.min(bytes.length, pageBytes - totalBytes));
  const start = Math.max(totalBytes, requestedCursor);
  const end = Math.min(totalBytes + bytes.length, requestedCursor + pageBytes);
  if (start < end) bytes.copy(requested, start - requestedCursor, start - totalBytes, end - totalBytes);
  totalBytes += bytes.length;
};
const descriptor = openSync(join(root, path), "r");
try {
  if (!fstatSync(descriptor).isFile()) throw Error("Candidate file is not a regular text file");
  let length;
  while ((length = readSync(descriptor, block, 0, block.length, null)) > 0) {
    retain(decoder.decode(block.subarray(0, length), { stream: true }));
  }
  retain(decoder.decode());
} finally {
  closeSync(descriptor);
}
const digest = hash.digest("hex");
const sourceChanged = expectedDigest !== "" && expectedDigest !== digest;
const cursor = sourceChanged ? 0 : requestedCursor;
if (cursor > totalBytes) throw Error("File cursor is past the end of the current content");
const length = Math.min(pageBytes, totalBytes - cursor);
// Streaming decode withholds only an incomplete final code point. Long lines need no special case.
const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
  (cursor === 0 ? first : requested).subarray(0, length),
  { stream: cursor + length < totalBytes },
);
const next = cursor + Buffer.byteLength(content, "utf8");
console.log(JSON.stringify({ content, cursor, digest, nextCursor: next < totalBytes ? next : null, totalBytes, ...(sourceChanged ? { sourceChanged: true } : {}) }));
`;

/** Model-facing pages use UTF-8 content offsets and never transfer the entire file through the SDK. */
export const readDraftReconciliationCandidateFilePage = async (input: {
  sandbox: SandboxSession;
  prepared: PreparedDraftReconciliation;
  path: string;
  cursor?: number;
  expectedDigest?: string;
}): Promise<{
  content: string;
  cursor: number;
  digest: string;
  nextCursor: number | null;
  totalBytes: number;
  sourceChanged?: true;
}> => {
  const { prepared, path } = input;
  if (!appPath(prepared.appId, path)) {
    throw new Error(`Builder cannot read ${path}: it is outside apps/${prepared.appId}/.`);
  }
  await assertDraftReconciliationCandidateAvailable(input);
  await checked(
    input.sandbox,
    `verify the candidate file path ${path}`,
    `node -e ${quote(safeResolutionProgram)} ${quote(prepared.root)} ${quote(path)}`,
  );
  const raw = await checked(
    input.sandbox,
    `read a page of the current candidate file ${path}`,
    `node -e ${quote(candidateFilePageProgram)} ${quote(prepared.root)} ${quote(path)} ${quote(String(input.cursor ?? 0))} ${quote(input.expectedDigest ?? "")}`,
  );
  return z
    .strictObject({
      content: z.string(),
      cursor: z.number().int().nonnegative(),
      digest: z.string().regex(/^[0-9a-f]{64}$/u),
      nextCursor: z.number().int().nonnegative().nullable(),
      sourceChanged: z.literal(true).optional(),
      totalBytes: z.number().int().nonnegative(),
    })
    .parse(JSON.parse(raw));
};

/** Internal full text for exact preimage comparison and replacement; not a model-facing read. */
export const readDraftReconciliationCandidateFile = async (input: {
  sandbox: SandboxSession;
  prepared: PreparedDraftReconciliation;
  path: string;
}): Promise<{ content: string; digest: string }> => {
  const { prepared, path } = input;
  if (!appPath(prepared.appId, path)) {
    throw new Error(`Builder cannot read ${path}: it is outside apps/${prepared.appId}/.`);
  }
  await assertDraftReconciliationCandidateAvailable(input);
  await checked(
    input.sandbox,
    `verify the candidate file path ${path}`,
    `node -e ${quote(safeResolutionProgram)} ${quote(prepared.root)} ${quote(path)}`,
  );
  const relative = `${prepared.root.slice(prepared.workspaceRoot.length + 1)}/${path}`;
  let content: string;
  try {
    const observed = await input.sandbox.readTextFile({ path: relative });
    if (observed === null) {
      throw new Error("The file is absent or is not a readable text file.");
    }
    content = observed;
  } catch (error) {
    throw new Error(
      `Builder could not read the current candidate file ${path}. Inspect the file path and retry. Cause: ${redact(error instanceof Error ? error.message : String(error)) || "The sandbox returned no detail."}`,
      { cause: error },
    );
  }
  return { content, digest: createHash("sha256").update(content).digest("hex") };
};

/** Restore one app-owned regular file from the server-retained draft head without checkout filters. */
export const restoreDraftReconciliationCandidateFile = async (input: {
  sandbox: SandboxSession;
  prepared: PreparedDraftReconciliation;
  path: string;
}): Promise<{ digest: string; mode: "644" | "755" }> => {
  const { prepared, path, sandbox } = input;
  if (!appPath(prepared.appId, path)) {
    throw new Error(`Builder cannot restore ${path}: it is outside apps/${prepared.appId}/.`);
  }
  await assertDraftReconciliationCandidateAvailable(input);
  await checked(
    sandbox,
    `verify the candidate restore path ${path}`,
    `node -e ${quote(safeResolutionProgram)} ${quote(prepared.root)} ${quote(path)}`,
  );
  const raw = await checked(
    sandbox,
    `restore the retained draft file ${path}`,
    `node -e ${quote(preimageProgram)} ${quote(prepared.root)} ${quote(path)} ${quote(prepared.headSha)} 'restore'`,
  );
  const result = z
    .strictObject({ digest: z.string(), mode: z.enum(["644", "755"]) })
    .nullable()
    .parse(JSON.parse(raw));
  if (result === null) {
    throw new Error(`Builder cannot restore ${path}: it is absent from the retained draft head.`);
  }
  await checked(
    sandbox,
    `stage the retained draft file ${path}`,
    git(prepared.root, [
      "--literal-pathspecs",
      "restore",
      "--source",
      prepared.headSha,
      "--staged",
      "--",
      path,
    ]),
  );
  return result;
};

/** Apply one exact text replacement against the observed candidate bytes. */
export const replaceDraftReconciliationCandidateText = async (input: {
  sandbox: SandboxSession;
  prepared: PreparedDraftReconciliation;
  path: string;
  expectedDigest: string;
  oldText: string;
  newText: string;
}): Promise<{ digest: string }> => {
  const current = await readDraftReconciliationCandidateFile(input);
  if (current.digest !== input.expectedDigest) {
    throw new Error(
      `Builder cannot edit ${input.path}: its content changed since inspection. Read the current file, then retry the exact edit.`,
    );
  }
  if (!input.oldText || input.oldText === input.newText) {
    throw new Error(`Builder cannot edit ${input.path}: supply a nonempty old text and a change.`);
  }
  const first = current.content.indexOf(input.oldText);
  if (first === -1 || current.content.includes(input.oldText, first + input.oldText.length)) {
    throw new Error(
      `Builder cannot edit ${input.path}: the old text must occur exactly once. Read the current file and choose a unique exact passage.`,
    );
  }
  const content =
    current.content.slice(0, first) +
    input.newText +
    current.content.slice(first + input.oldText.length);
  const relative = `${input.prepared.root.slice(input.prepared.workspaceRoot.length + 1)}/${input.path}`;
  await input.sandbox.writeTextFile({ content, path: relative });
  return { digest: createHash("sha256").update(content).digest("hex") };
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
  const result = spawnSync("git", ["--literal-pathspecs", "-C", root, "diff", "--no-ext-diff", "--no-textconv", "--binary", from, to, "--", appPath], { stdio: ["ignore", descriptor, "pipe"], encoding: "utf8" });
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

/** Optionally inspect exact raw diff bytes, with an explicit file target when needed. */
export const readDraftReconciliationDiff = async (input: {
  sandbox: SandboxSession;
  prepared: PreparedDraftReconciliation;
  resolvedTree: string;
  against: "base" | "head";
  cursor?: number;
  path?: string;
}): Promise<{
  cursor: number;
  nextCursor: number | null;
  totalBytes: number;
  chunkBase64: string;
}> => {
  if (!SHA.test(input.resolvedTree)) {
    throw new Error("Builder cannot read the resolution diff: the reviewed tree ID is invalid.");
  }
  if (input.path !== undefined && !safeSourcePath(input.path)) {
    throw new Error("The requested diff path must stay inside the selected repository.");
  }
  await assertDraftReconciliationCandidateAvailable(input);
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
  const pathspec = input.path ?? (input.against === "base" ? `apps/${input.prepared.appId}` : ".");
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
  await assertDraftReconciliationCandidateAvailable(input);
  if (prepared.publicationScope !== undefined) {
    assertOwnedPublicationReconciliationScope(prepared.publicationScope);
    if (
      prepared.publicationScope.automaticMergeNonAppDigest !==
      (await nonAppIndexDigest(sandbox, prepared.root, prepared.appId))
    ) {
      throw new Error(
        "Non-app content changed after Git prepared this owned draft merge. Reprepare the candidate before review.",
      );
    }
  }
  const unstaged = records(
    await checked(
      sandbox,
      "inspect unstaged reconciliation changes",
      git(prepared.root, [DIFF_COMMAND, NAME_ONLY, ZERO_TERMINATED]),
    ),
  );
  const { paths: untracked, dependencyRoots } = await candidateUntracked(
    sandbox,
    prepared.root,
    prepared.workspaceRoot,
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
    git(prepared.root, [
      "add",
      "--all",
      "--",
      `apps/${prepared.appId}`,
      ...dependencyRoots.map((root) => `:(exclude,literal)${root}`),
    ]),
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
  if (nonAppChange !== undefined && prepared.publicationScope === undefined) {
    throw new Error(
      `Builder's resolved PR differs from main at ${nonAppChange.path}, outside apps/${prepared.appId}/. Restore main's content there before review.`,
    );
  }
  return { ...parsed, unresolvedConflicts: [] };
};

/** A second private worktree whose comparison baseline is the owned PR head, never main. */
export const preparePublishedDraftRepairCandidate = async (
  request: Omit<DraftReconciliationInput, "baseSha" | "baseBranch">,
): Promise<PreparedDraftReconciliation> => {
  const input = { ...request, baseSha: request.headSha, baseBranch: request.headBranch };
  verifyInputs(input);
  const { sandbox } = input;
  const workspaceRoot = input.workspaceRoot ?? DEFAULT_WORKSPACE;
  const checkout = `${workspaceRoot}/repository`;
  const remote = await checked(
    sandbox,
    "inspect the owned repair Git remote",
    git(checkout, ["remote", "get-url", "origin"]),
  );
  if (remote !== `https://github.com/${input.repository.owner}/${input.repository.name}.git`) {
    throw new Error(
      "The existing checkout is not this owned publication repository; its files have been preserved.",
    );
  }
  await checked(
    sandbox,
    "fetch the current draft head",
    git(checkout, ["fetch", "--no-tags", "origin", `refs/heads/${input.headBranch}`]),
  );
  const fetchedHead = await checked(
    sandbox,
    "verify the owned repair head",
    git(checkout, ["rev-parse", "FETCH_HEAD"]),
  );
  if (fetchedHead !== input.headSha) {
    throw new Error(
      "The owned draft moved during private repair preparation; inspect its current source again.",
    );
  }
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        "published-draft-repair",
        input.repository,
        input.appId,
        input.headSha,
        input.unpublished?.reviewDigest,
      ]),
    )
    .digest("hex");
  const canonicalRoot = `${workspaceRoot}/.app-builder/draft-reconcile/${key}`;
  const { root, created } = await selectCandidateRoot(input, workspaceRoot, canonicalRoot);
  if (created) {
    await checked(
      sandbox,
      "create the private repair directory",
      `mkdir -p ${quote(root.slice(0, root.lastIndexOf("/")))}`,
    );
    await checked(
      sandbox,
      "create the owned draft repair checkout",
      git(checkout, ["worktree", "add", "--detach", root, input.headSha]),
    );
    await stageUnpublished(input, root, workspaceRoot);
  }
  await attachCheckoutDependencyView({
    sandbox,
    checkoutRoot: checkout,
    candidateRoot: root,
    workspaceRoot,
  });
  const headTree = await inspectRevision(sandbox, checkout, input.headSha);
  return {
    appId: input.appId,
    workspaceRoot,
    root,
    headSha: input.headSha,
    headTree,
    baseSha: input.headSha,
    baseTree: headTree,
    conflicts: await readCandidateConflicts(input, root),
  };
};
