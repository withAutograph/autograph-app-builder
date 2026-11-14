import { z } from "zod";
import type { SandboxSession } from "eve/sandbox";
import { appBaselineMarkerPath } from "./app-baseline";
import type { AppBaselineSelection } from "./app-baseline";
import { GENERATED_RELEASE_MEMBERS } from "../provisioning/hosted-operator-sandbox-launcher";
import { sanitizeValidationDiagnosticText } from "./validation-output-sanitize";

const objectId = z.string().regex(/^[a-f0-9]{40,64}$/u);
const releaseIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const publishedReleaseSchema = z.strictObject({
  mergeSha: objectId,
  releaseId: z.string().regex(releaseIdPattern),
  files: z.record(z.enum(GENERATED_RELEASE_MEMBERS), z.string().regex(/^[a-f0-9]{64}$/u)),
});
export interface PublishedPlanningRelease {
  mergeSha: string;
  releaseId: string;
  files: Record<string, string>;
}

export class PlanningReleaseConflictError extends Error {
  readonly releaseId: string;

  constructor(releaseId: string) {
    super(
      "A saved app release conflicts with the current repository source. Its original bytes are preserved.",
    );
    this.name = "PlanningReleaseConflictError";
    this.releaseId = releaseId;
  }
}

const outcomeSchema = z.strictObject({
  changed: z.boolean(),
  checkpointRef: z.string(),
  sourceSha: objectId,
  sourceTree: objectId,
});

/** Git objects checkpoint source bytes before replacing the owned planning checkout. */
export const planningSourceReconciliationProgram = String.raw`
const { createHash } = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const { existsSync, lstatSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const input = JSON.parse(process.argv[1]);
const root = input.root;
const privateRoot = join(input.stateRoot, createHash("sha256").update(root + input.sessionId).digest("hex"));
mkdirSync(privateRoot, { recursive: true, mode: 448 });
const key = createHash("sha256").update(input.sessionId).digest("hex");
const planPath = join(privateRoot, key + ".json");
let checkpointRef = input.checkpointRef ?? "refs/app-builder/source-checkpoints/" + key;
if (!/^refs\/app-builder\/source-checkpoints\/[a-f0-9]+(?:\/[a-f0-9]+)?$/.test(checkpointRef)) throw Error("Source checkpoint identity is invalid.");
const temporary = mkdtempSync(join(privateRoot, "index-"));
const { APP_BUILDER_SOURCE_READ_TOKEN: sourceReadToken, ...childEnvironment } = process.env;
const baseEnv = { ...childEnvironment, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false", SSH_ASKPASS: "/usr/bin/false", GIT_AUTHOR_NAME: "Autograph Builder", GIT_AUTHOR_EMAIL: "builder@autograph.so", GIT_COMMITTER_NAME: "Autograph Builder", GIT_COMMITTER_EMAIL: "builder@autograph.so" };
const args = ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesfile=/dev/null", "-c", "credential.helper=", "-c", "commit.gpgsign=false", "-C", root];
const gitExecutable = existsSync("/usr/bin/git") ? "/usr/bin/git" : "/bin/git";
const git = (command, options = {}) => execFileSync(gitExecutable, [...args, ...command], { env: { ...baseEnv, ...options.env }, input: options.input, encoding: options.buffer ? undefined : "utf8", maxBuffer: Infinity, stdio: ["pipe", "pipe", "pipe"] });
const safe = value => value && !value.startsWith("/") && !value.includes("\\") && !/[\0\r\n]/.test(value) && !value.split("/").some(part => part === "." || part === ".." || part === ".git");
const entries = tree => new Map(git(["ls-tree", "-rz", "--full-tree", tree]).split("\0").filter(Boolean).map(line => {
  const match = /^(100644|100755|120000) blob ([a-f0-9]{40,64})\t(.+)$/.exec(line);
  if (!match || !safe(match[3])) throw Error("Repository source contains an unsupported Git entry.");
  return [match[3], { mode: match[1], objectId: match[2] }];
}));
const indexEnv = { GIT_INDEX_FILE: join(temporary, "index") };
const updateIndex = records => { if (records.length) git(["update-index", "-z", "--index-info"], { env: indexEnv, input: records.join("\0") + "\0" }); };
const setEntry = (file, entry) => entry ? entry.mode + " " + entry.objectId + "\t" + file : "0 " + "0".repeat(40) + "\t" + file;
const writePlan = plan => { writeFileSync(planPath + ".pending", JSON.stringify(plan), { mode: 384 }); renameSync(planPath + ".pending", planPath); };
const ownedApp = file => file.startsWith("apps/" + input.appId + "/") || [".config/app-specs/" + input.appId + ".cue", ".config/app-specs/" + input.appId + ".md"].includes(file);
const product = file => ownedApp(file) && (input.localSource || !file.startsWith("apps/" + input.appId + "/.config/mise/"));
const releasePrefix = "apps/" + input.appId + "/schema/release/";
const releaseMembers = ${JSON.stringify(GENERATED_RELEASE_MEMBERS)};
const publishedRelease = input.publishedRelease;
const validReleaseId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
const releaseConflict = (releaseId, file) => {
  if (validReleaseId(releaseId)) process.stderr.write("APP_BUILDER_RELEASE_CONFLICT " + releaseId + "\n");
  throw Error("An immutable app release has conflicting source bytes: " + file);
};
const verifyPublishedRelease = (sourceSha, oldEntries, targetEntries) => {
  if (!publishedRelease) return;
  const { mergeSha, releaseId, files } = publishedRelease;
  const invalid = () => Error("The selected merged release does not match the current checked source.");
  if (input.localSource || !validReleaseId(releaseId) || !/^[a-f0-9]{40,64}$/.test(mergeSha) ||
      !files || Object.keys(files).length !== releaseMembers.length ||
      !releaseMembers.every(member => /^[a-f0-9]{64}$/.test(files[member] ?? ""))) throw invalid();
  const directory = releasePrefix + releaseId;
  const prefix = directory + "/";
  const inRelease = file => file === directory || file.startsWith(prefix);
  const verifyFiles = (tree, emptyAllowed = false) => {
    const members = [...tree].filter(([file]) => inRelease(file));
    if (emptyAllowed && members.length === 0) return;
    if (members.length !== releaseMembers.length ||
        members.some(([file, entry]) => entry.mode !== "100644" || !Object.hasOwn(files, file.slice(prefix.length)) ||
          createHash("sha256").update(git(["cat-file", "blob", entry.objectId], { buffer: true })).digest("hex") !== files[file.slice(prefix.length)])) throw invalid();
  };
  try { git(["merge-base", "--is-ancestor", mergeSha, sourceSha]); } catch { throw invalid(); }
  verifyFiles(entries(mergeSha));
  verifyFiles(entries(mergeSha + "^1"), true);
  verifyFiles(targetEntries);
  verifyFiles(oldEntries, true);
  return inRelease;
};
// Only an owner-retained completed source transport may identify managed overlay
// bytes. The candidate or manifest alone never selects a new merge base.
let managedOverlay;
if (input.localSource && input.managedOverlayWorkspaceDigest !== undefined) {
  if (!/^[a-f0-9]{64}$/.test(input.managedOverlayWorkspaceDigest)) throw Error("Recorded source overlay identity is invalid.");
  const files = JSON.parse(readFileSync(input.managedOverlayManifestPath, "utf8"));
  if (!Array.isArray(files) || createHash("sha256").update(JSON.stringify(files)).digest("hex") !== input.managedOverlayWorkspaceDigest) throw Error("Recorded source overlay does not match the retained transport manifest; authored bytes are retained.");
  managedOverlay = new Map();
  for (const file of files) {
    if (!file || !safe(file.path) || !["100644", "100755"].includes(file.mode) || !/^[a-f0-9]{64}$/.test(file.sha256) || file.objectId !== file.sha256.slice(0, 40) || managedOverlay.has(file.path)) throw Error("Recorded source overlay manifest is invalid.");
    managedOverlay.set(file.path, file);
  }
}

if (input.localSource && input.currentManifestDigest !== undefined) {
  const files = JSON.parse(readFileSync(input.currentManifestPath, "utf8"));
  if (!Array.isArray(files) || createHash("sha256").update(JSON.stringify(files)).digest("hex") !== input.currentManifestDigest) throw Error("Current workspace manifest changed before local source reconciliation.");
}

const complete = plan => {
  // The original bytes are already reachable through checkpointRef. Replaying this
  // transition repairs an interrupted checkout before another planning command runs.
  const finalEntries = entries(plan.workingTree);
  const currentPaths = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(file => file && !file.startsWith(".app-builder/"));
  for (const file of currentPaths) {
    if (!safe(file)) throw Error("Source transition encountered an unsafe source path.");
    if (!finalEntries.has(file)) rmSync(resolve(root, file), { force: true });
  }
  for (const [file, entry] of finalEntries) {
    const parts = file.split("/");
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      if (existsSync(parent)) {
        const stat = lstatSync(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Source transition has a filesystem parent collision: " + file);
      } else mkdirSync(parent);
    }
    const destination = resolve(root, file);
    let existing;
    try { existing = lstatSync(destination); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const bytes = git(["cat-file", "blob", entry.objectId], { buffer: true });
    if (entry.mode === "120000") {
      const target = bytes.toString("utf8");
      if (existing?.isSymbolicLink() && readlinkSync(destination) === target) continue;
      rmSync(destination, { force: true });
      symlinkSync(target, destination);
      continue;
    }
    // Writing identical files consumes storage on the Sandbox's snapshot-backed filesystem.
    const mode = entry.mode === "100755" ? 493 : 420;
    if (existing?.isFile() && readFileSync(destination).equals(bytes)) {
      if ((existing.mode & 511) !== mode) chmodSync(destination, mode);
      continue;
    }
    if (existing?.isSymbolicLink()) rmSync(destination, { force: true });
    writeFileSync(destination, bytes);
    chmodSync(destination, mode);
  }
  git(["update-ref", "HEAD", plan.sourceSha]);
  git(["read-tree", plan.sourceSha]);
  if (plan.marker) {
    const markerPath = input.baselineMarkerPath;
    writeFileSync(markerPath + ".pending", JSON.stringify(plan.marker) + "\n", { mode: 384 });
    renameSync(markerPath + ".pending", markerPath);
  }
  rmSync(planPath);
};
try {
  if (existsSync(planPath)) {
    const pending = JSON.parse(readFileSync(planPath, "utf8"));
    if (pending.sessionId !== input.sessionId || JSON.stringify(pending.baseline) !== JSON.stringify(input.baseline ?? null)) throw Error("Source reconciliation belongs to another session or app baseline.");
    if (pending.publishedRelease !== undefined && !isDeepStrictEqual(pending.publishedRelease, publishedRelease)) {
      if (publishedRelease === undefined) releaseConflict(pending.publishedRelease.releaseId, releasePrefix);
      throw Error("The pending source reconciliation belongs to another merged app release.");
    }
    complete(pending);
  }
  if (input.fetchRemote) {
    const remote = new URL(input.repository);
    if (remote.protocol !== "https:" || remote.hostname !== "github.com" || remote.username || remote.password || remote.search || remote.hash) throw Error("Source reconciliation requires its selected GitHub repository.");
    const token = sourceReadToken;
    if (!token) throw Error("Source reconciliation needs owner-bound repository read access.");
    // Repository-local transport/filter configuration never receives the read token.
    const fetchRoot = join(temporary, "fetch.git");
    git(["init", "--bare", "--template=", "--quiet", fetchRoot]);
    const fetchArgs = ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "http.followRedirects=false", "-C", fetchRoot, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", input.repository, input.targetSha];
    execFileSync(gitExecutable, fetchArgs, { env: { ...baseEnv, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: "Authorization: Basic " + Buffer.from("x-access-token:" + token).toString("base64") }, stdio: ["ignore", "pipe", "pipe"] });
    git(["-c", "protocol.allow=never", "-c", "protocol.file.allow=always", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", fetchRoot, input.targetSha]);
  }
  let sourceSha = git(["rev-parse", input.targetSha + "^{commit}"]).trim();
  const sourceTree = git(["rev-parse", sourceSha + "^{tree}"]).trim();
  const oldHead = git(["rev-parse", "HEAD"]).trim();
  if (input.localSource) checkpointRef = "refs/app-builder/local-source-checkpoints/" + key + "/" + oldHead + "/" + input.targetSha;
  if (input.localSource) {
    // The incoming local working tree is a new private planning base. Its
    // sibling parent must be the actual previous base, including prior local
    // edits, so ordinary dirty-source iteration has an honest three-way base.
    git(["cat-file", "-e", input.originalSourceSha + "^{commit}"]);
    if (git(["rev-parse", oldHead + "^{tree}"]).trim() !== sourceTree) {
      sourceSha = git(["commit-tree", sourceTree, "-p", oldHead], { input: "Current trusted local planning source\n", env: { GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" } }).trim();
    } else sourceSha = oldHead;
  }
  if (oldHead === sourceSha && !input.localSource) { rmSync(temporary, { force: true, recursive: true }); console.log(JSON.stringify({ changed: false, checkpointRef, sourceSha, sourceTree })); process.exit(0); }
  const oldEntries = entries(oldHead);
  const targetEntries = entries(sourceSha);
  const inPublishedRelease = verifyPublishedRelease(sourceSha, oldEntries, targetEntries);
  git(["read-tree", oldHead], { env: indexEnv });
  const paths = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(file => file && !file.startsWith(".app-builder/"));
  const records = [];
  const currentFileHashes = new Map();
  for (const file of new Set(paths)) {
    if (!safe(file)) throw Error("Source reconciliation encountered an unsafe source path.");
    const absolute = resolve(root, file);
    let stat;
    try { stat = lstatSync(absolute); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      records.push(setEntry(file, undefined)); continue;
    }
    const parent = realpathSync(dirname(absolute));
    const canonicalRoot = realpathSync(root);
    if (parent !== canonicalRoot && !parent.startsWith(canonicalRoot + "/")) throw Error("Source reconciliation cannot follow a source path outside its owned checkout: " + file);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw Error("Source reconciliation encountered a non-file source entry.");
    const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute);
    const objectId = git(["hash-object", "-w", "--stdin", "--no-filters"], { input: bytes }).trim();
    if (stat.isFile() && !stat.isSymbolicLink()) currentFileHashes.set(file, createHash("sha256").update(bytes).digest("hex"));
    records.push(setEntry(file, { mode: stat.isSymbolicLink() ? "120000" : stat.mode & 64 ? "100755" : "100644", objectId }));
  }
  updateIndex(records);
  const snapshotTree = git(["write-tree"], { env: indexEnv }).trim();
  const snapshotCommit = git(["commit-tree", snapshotTree, "-p", oldHead], { input: "Checkpoint source before current-platform reconciliation\n" }).trim();
  git(["update-ref", checkpointRef, snapshotCommit]);
  const snapshotEntries = entries(snapshotTree);
  if (inPublishedRelease && [...snapshotEntries].some(([file, entry]) => inPublishedRelease(file) && entry.mode !== "100644"))
    throw Error("The saved app release contains a non-regular source entry and was preserved.");
  // Historical product bytes are an explicit baseline, not a merge conflict with
  // the newer app implementation. Repository-owned app tooling merges normally.
  updateIndex([...new Set([...oldEntries.keys(), ...snapshotEntries.keys()])].filter(product).map(file => setEntry(file, oldEntries.get(file))));
  if (managedOverlay) {
    const recognized = [...snapshotEntries].filter(([file, entry]) => {
      const transported = managedOverlay.get(file);
      return !ownedApp(file) && transported && entry.mode === transported.mode && currentFileHashes.get(file) === transported.sha256;
    });
    // Neutralize only byte-identical, non-app managed input in the private
    // three-way tree. The actual working tree/checkpoint is untouched here;
    // authored shared deltas continue through ordinary conflict detection.
    updateIndex(recognized.map(([file]) => setEntry(file, oldEntries.get(file))));
  }
  const mergeInputTree = git(["write-tree"], { env: indexEnv }).trim();
  const mergeInputCommit = git(["commit-tree", mergeInputTree, "-p", oldHead], { input: "Reconcile authored platform changes\n" }).trim();
  const merge = spawnSync(gitExecutable, [...args, "merge-tree", "--write-tree", "--name-only", sourceSha, mergeInputCommit], { env: baseEnv, encoding: "utf8", maxBuffer: Infinity, stdio: ["ignore", "pipe", "pipe"] });
  if (merge.status !== 0) {
    if (merge.status !== 1) throw Error("Git merge-tree failed with exit " + merge.status + "; original source remains in " + checkpointRef + ".");
    const conflictLines = merge.stdout.split("\n").slice(1);
    const separator = conflictLines.indexOf("");
    const conflicts = (separator === -1 ? conflictLines : conflictLines.slice(0, separator)).filter(Boolean).filter(safe).slice(0, 20);
    throw Error("Current repository source conflicts with authored changes: " + conflicts.join(", ") + ". Original bytes remain in " + checkpointRef + ".");
  }
  const mergedTree = merge.stdout.split("\n")[0];
  git(["read-tree", mergedTree], { env: indexEnv });
  const mergedEntries = entries(mergedTree);
  const protectedRecords = [];
  for (const file of new Set([...mergedEntries.keys(), ...snapshotEntries.keys()])) {
    if (!product(file)) continue;
    if (inPublishedRelease?.(file)) {
      protectedRecords.push(setEntry(file, targetEntries.get(file)));
      continue;
    }
    let preserved = snapshotEntries.get(file);
    if (!input.localSource && releasePrefix && file.startsWith(releasePrefix)) {
      const current = snapshotEntries.get(file);
      const added = targetEntries.get(file);
      if (current && added && (current.objectId !== added.objectId || current.mode !== added.mode)) releaseConflict(file.slice(releasePrefix.length).split("/")[0], file);
      preserved = current ?? added;
    }
    protectedRecords.push(setEntry(file, preserved));
  }
  updateIndex(protectedRecords);
  const workingTree = git(["write-tree"], { env: indexEnv }).trim();
  // A tracked update must not replace ignored private environment/dependency files.
  const ignored = git(["ls-files", "-z", "--others", "--ignored", "--exclude-standard"]).split("\0").filter(Boolean);
  const finalPaths = entries(workingTree);
  const collisions = ignored.filter(file => inPublishedRelease?.(file) || [...finalPaths.keys()].some(target => target === file || target.startsWith(file + "/")));
  if (collisions.length) throw Error("Current repository source would overwrite ignored local files: " + collisions.slice(0, 20).join(", "));
  let marker;
  if (input.baseline) {
    const markerPath = input.baselineMarkerPath;
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
    if (JSON.stringify(marker.receipt.sessionId) !== JSON.stringify(input.sessionId) || marker.receipt.appId !== input.baseline.appId) throw Error("Source reconciliation cannot adopt another app baseline.");
    const platformFiles = [...targetEntries].filter(([file]) => ownedApp(file)).map(([file, entry]) => ({ digest: createHash("sha256").update(git(["cat-file", "blob", entry.objectId], { buffer: true })).digest("hex"), mode: entry.mode.slice(3), path: file })).sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    const oldUnexposed = new Set(marker.unexposedReleasePrefixes);
    const exposed = new Set([...snapshotEntries.keys()].filter(file => file.startsWith(releasePrefix)).map(file => releasePrefix + file.slice(releasePrefix.length).split("/")[0] + "/").filter(prefix => !oldUnexposed.has(prefix)));
    for (const file of targetEntries.keys()) if (file.startsWith(releasePrefix)) { const prefix = releasePrefix + file.slice(releasePrefix.length).split("/")[0] + "/"; if (!exposed.has(prefix)) oldUnexposed.add(prefix); }
    if (inPublishedRelease) oldUnexposed.delete(releasePrefix + publishedRelease.releaseId + "/");
    const unexposedReleasePrefixes = [...oldUnexposed].sort();
    const { digest: priorDigest, ...unsigned } = marker.receipt;
    unsigned.platform = { commitSha: sourceSha, ref: input.branchRef, treeSha: sourceTree };
    unsigned.platformSourceDigest = createHash("sha256").update(JSON.stringify(platformFiles)).digest("hex");
    unsigned.unexposedReleaseDigest = createHash("sha256").update(JSON.stringify(unexposedReleasePrefixes)).digest("hex");
    marker = { platformFiles, receipt: { ...unsigned, digest: createHash("sha256").update(JSON.stringify(unsigned)).digest("hex") }, unexposedReleasePrefixes };
  }
  const plan = { baseline: input.baseline ?? null, marker, sessionId: input.sessionId, sourceSha, workingTree, publishedRelease };
  writePlan(plan);
  complete(plan);
  console.log(JSON.stringify({ changed: true, checkpointRef, sourceSha, sourceTree }));
} finally { rmSync(temporary, { force: true, recursive: true }); }
`;

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export const reconcilePlanningSource = async (input: {
  appId: string;
  baseline?: AppBaselineSelection;
  branchRef: string;
  repository: string;
  sandbox: Pick<SandboxSession, "run">;
  sessionId: string;
  targetSha: string;
  token: string;
  publishedRelease?: PublishedPlanningRelease;
}) => {
  const request = {
    appId: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u)
      .parse(input.appId),
    baseline: input.baseline,
    baselineMarkerPath:
      input.baseline === undefined
        ? undefined
        : `/workspace/${appBaselineMarkerPath(input.baseline.appId)}`,
    branchRef: input.branchRef,
    fetchRemote: true,
    publishedRelease:
      input.publishedRelease === undefined
        ? undefined
        : publishedReleaseSchema.parse(input.publishedRelease),
    repository: input.repository,
    root: "/workspace/repository",
    sessionId: input.sessionId,
    stateRoot: "/workspace/.app-builder/source-reconciliation",
    targetSha: objectId.parse(input.targetSha),
  };
  const result = await input.sandbox.run({
    command: `node -e ${shellQuote(planningSourceReconciliationProgram)} ${shellQuote(JSON.stringify(request))}`,
    env: { APP_BUILDER_SOURCE_READ_TOKEN: input.token },
    workingDirectory: "/workspace/repository",
  });
  if (result.exitCode !== 0) {
    const conflict = /^APP_BUILDER_RELEASE_CONFLICT (?<id>[A-Za-z0-9][A-Za-z0-9._-]*)$/mu.exec(
      result.stderr,
    )?.groups?.id;
    if (conflict !== undefined) {
      throw new PlanningReleaseConflictError(conflict);
    }
    const diagnostic = sanitizeValidationDiagnosticText(result.stderr || result.stdout);
    throw new Error(
      `Builder could not reconcile current repository source. Original authored source is checkpointed before replacement. Cause: ${diagnostic || "The repository command returned no diagnostic."}`,
    );
  }
  return outcomeSchema.parse(JSON.parse(result.stdout));
};
