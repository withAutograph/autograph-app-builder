import { z } from "zod";
import type { SandboxSession } from "eve/sandbox";
import { appBaselineMarkerPath } from "./app-baseline";
import type { AppBaselineSelection } from "./app-baseline";
import { sanitizeValidationDiagnosticText } from "./validation-output-sanitize";

const objectId = z.string().regex(/^[a-f0-9]{40,64}$/u);
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
const input = JSON.parse(process.argv[1]);
const root = input.root;
const privateRoot = join(input.stateRoot, createHash("sha256").update(root + input.sessionId).digest("hex"));
mkdirSync(privateRoot, { recursive: true, mode: 448 });
const key = createHash("sha256").update(input.sessionId).digest("hex");
const planPath = join(privateRoot, key + ".json");
const checkpointRef = "refs/app-builder/source-checkpoints/" + key;
const temporary = mkdtempSync(join(privateRoot, "index-"));
const { APP_BUILDER_SOURCE_READ_TOKEN: sourceReadToken, ...childEnvironment } = process.env;
const baseEnv = { ...childEnvironment, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false", SSH_ASKPASS: "/usr/bin/false", GIT_AUTHOR_NAME: "Autograph Builder", GIT_AUTHOR_EMAIL: "builder@autograph.so", GIT_COMMITTER_NAME: "Autograph Builder", GIT_COMMITTER_EMAIL: "builder@autograph.so" };
const args = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesfile=/dev/null", "-c", "credential.helper=", "-c", "commit.gpgsign=false", "-C", root];
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
const product = file => ownedApp(file) && !file.startsWith("apps/" + input.appId + "/.config/mise/");
const releasePrefix = "apps/" + input.appId + "/schema/release/";
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
    if (existing?.isSymbolicLink() || entry.mode === "120000") rmSync(destination, { force: true });
    const bytes = git(["cat-file", "blob", entry.objectId], { buffer: true });
    if (entry.mode === "120000") symlinkSync(bytes.toString("utf8"), destination);
    else { writeFileSync(destination, bytes); chmodSync(destination, entry.mode === "100755" ? 493 : 420); }
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
  const sourceSha = git(["rev-parse", input.targetSha + "^{commit}"]).trim();
  const sourceTree = git(["rev-parse", sourceSha + "^{tree}"]).trim();
  const oldHead = git(["rev-parse", "HEAD"]).trim();
  if (oldHead === sourceSha) { rmSync(temporary, { force: true, recursive: true }); console.log(JSON.stringify({ changed: false, checkpointRef, sourceSha, sourceTree })); process.exit(0); }
  const oldEntries = entries(oldHead);
  const targetEntries = entries(sourceSha);
  git(["read-tree", oldHead], { env: indexEnv });
  const paths = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(file => file && !file.startsWith(".app-builder/"));
  const records = [];
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
    records.push(setEntry(file, { mode: stat.isSymbolicLink() ? "120000" : stat.mode & 64 ? "100755" : "100644", objectId }));
  }
  updateIndex(records);
  const snapshotTree = git(["write-tree"], { env: indexEnv }).trim();
  const snapshotCommit = git(["commit-tree", snapshotTree, "-p", oldHead], { input: "Checkpoint source before current-platform reconciliation\n" }).trim();
  git(["update-ref", checkpointRef, snapshotCommit]);
  const snapshotEntries = entries(snapshotTree);
  // Historical product bytes are an explicit baseline, not a merge conflict with
  // the newer app implementation. Repository-owned app tooling merges normally.
  updateIndex([...new Set([...oldEntries.keys(), ...snapshotEntries.keys()])].filter(product).map(file => setEntry(file, oldEntries.get(file))));
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
    let preserved = snapshotEntries.get(file);
    if (releasePrefix && file.startsWith(releasePrefix)) {
      const current = snapshotEntries.get(file);
      const added = targetEntries.get(file);
      if (current && added && (current.objectId !== added.objectId || current.mode !== added.mode)) throw Error("An immutable app release has conflicting source bytes: " + file);
      preserved = current ?? added;
    }
    protectedRecords.push(setEntry(file, preserved));
  }
  updateIndex(protectedRecords);
  const workingTree = git(["write-tree"], { env: indexEnv }).trim();
  // A tracked update must not replace ignored private environment/dependency files.
  const ignored = git(["ls-files", "-z", "--others", "--ignored", "--exclude-standard"]).split("\0").filter(Boolean);
  const finalPaths = entries(workingTree);
  const collisions = ignored.filter(file => [...finalPaths.keys()].some(target => target === file || target.startsWith(file + "/")));
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
    const unexposedReleasePrefixes = [...oldUnexposed].sort();
    const { digest: priorDigest, ...unsigned } = marker.receipt;
    unsigned.platform = { commitSha: sourceSha, ref: input.branchRef, treeSha: sourceTree };
    unsigned.platformSourceDigest = createHash("sha256").update(JSON.stringify(platformFiles)).digest("hex");
    unsigned.unexposedReleaseDigest = createHash("sha256").update(JSON.stringify(unexposedReleasePrefixes)).digest("hex");
    marker = { platformFiles, receipt: { ...unsigned, digest: createHash("sha256").update(JSON.stringify(unsigned)).digest("hex") }, unexposedReleasePrefixes };
  }
  const plan = { baseline: input.baseline ?? null, marker, sessionId: input.sessionId, sourceSha, workingTree };
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
  sandbox: SandboxSession;
  sessionId: string;
  targetSha: string;
  token: string;
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
    const diagnostic = sanitizeValidationDiagnosticText(result.stderr || result.stdout);
    throw new Error(
      `Builder could not reconcile current repository source. Original authored source is checkpointed before replacement. Cause: ${diagnostic || "The repository command returned no diagnostic."}`,
    );
  }
  return outcomeSchema.parse(JSON.parse(result.stdout));
};
