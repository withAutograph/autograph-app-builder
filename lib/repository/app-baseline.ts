import { createHash } from "node:crypto";
import path from "node:path";
import { canonicalOverlayFiles } from "./target-apply";
import type { OverlayFile } from "./target-apply";
import { z } from "zod";
import type { SandboxSession } from "eve/sandbox";

import {
  historicalAppSourceObservationSchema,
  historicalAppSourceSelectorSchema,
} from "./historical-app-source";

const appIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
const objectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const appBaselineInputSchema = z.strictObject({
  appId: appIdSchema,
  source: historicalAppSourceSelectorSchema,
});
export type AppBaselineInput = z.infer<typeof appBaselineInputSchema>;

export const appBaselineSelectionSchema = z.strictObject({
  appId: appIdSchema,
  historical: historicalAppSourceObservationSchema,
  selectedByCallId: z.string().min(1),
  sessionId: z.string().min(1),
  source: historicalAppSourceSelectorSchema,
});
export type AppBaselineSelection = z.infer<typeof appBaselineSelectionSchema>;
export const assertAppBaselineAuthority = (input: {
  selection: AppBaselineSelection;
  repository: { repositoryId: string; owner: string; name: string };
  sessionId: string;
}): void => {
  const selection = appBaselineSelectionSchema.parse(input.selection);
  if (
    selection.sessionId !== input.sessionId ||
    selection.historical.repositoryId !== input.repository.repositoryId ||
    selection.historical.owner !== input.repository.owner ||
    selection.historical.name !== input.repository.name
  ) {
    throw new Error("The app baseline belongs to a different Builder session or repository.");
  }
};
const platformSchema = z.strictObject({
  commitSha: objectId,
  ref: z.string().startsWith("refs/heads/"),
  treeSha: objectId,
});
const receiptUnsignedSchema = appBaselineSelectionSchema.extend({
  platform: platformSchema,
  platformSourceDigest: digest,
  projectedByCallId: z.string().min(1),
  removedFiles: z.number().int().nonnegative(),
  restoredFiles: z.number().int().nonnegative(),
  retainedReleaseFiles: z.number().int().nonnegative(),
  sourceDigest: digest,
  unexposedReleaseDigest: digest,
  version: z.literal(1),
});
const recordDigest = (value: z.infer<typeof receiptUnsignedSchema>): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const appBaselineReceiptSchema = receiptUnsignedSchema
  .extend({ digest })
  .superRefine((record, ctx) => {
    const { digest: actual, ...unsigned } = record;
    if (actual !== recordDigest(unsigned)) {
      ctx.addIssue({ code: "custom", message: "App baseline receipt digest is invalid." });
    }
  });
export type AppBaselineReceipt = z.infer<typeof appBaselineReceiptSchema>;
export const appBaselineMarkerPath = (appId: string): string =>
  `.app-builder/app-baselines/${appIdSchema.parse(appId)}.json`;
const overlayFileSchema = z.strictObject({
  digest,
  mode: z.enum(["644", "755"]),
  path: z.string(),
});
const markerSchema = z.strictObject({
  platformFiles: z.array(overlayFileSchema),
  receipt: appBaselineReceiptSchema,
  unexposedReleasePrefixes: z.array(z.string()),
});

/** This is private source provenance, never a product-readiness assertion. */
export const readAppBaselineMarker = async (
  sandbox: Pick<SandboxSession, "readTextFile">,
  selection: AppBaselineSelection,
): Promise<z.infer<typeof markerSchema> | undefined> => {
  const contents = await sandbox.readTextFile({ path: appBaselineMarkerPath(selection.appId) });
  if (contents === null) {
    return undefined;
  }
  const marker = markerSchema.parse(JSON.parse(contents));
  const { platformFiles, receipt, unexposedReleasePrefixes } = marker;
  const saved = appBaselineSelectionSchema.parse({
    appId: receipt.appId,
    historical: receipt.historical,
    selectedByCallId: receipt.selectedByCallId,
    sessionId: receipt.sessionId,
    source: receipt.source,
  });
  if (
    JSON.stringify(saved) !== JSON.stringify(appBaselineSelectionSchema.parse(selection)) ||
    createHash("sha256").update(JSON.stringify(unexposedReleasePrefixes)).digest("hex") !==
      receipt.unexposedReleaseDigest ||
    createHash("sha256").update(JSON.stringify(platformFiles)).digest("hex") !==
      receipt.platformSourceDigest
  ) {
    throw new Error(
      "This workspace already owns a different app baseline. Continue its saved selection or start a new Builder session.",
    );
  }
  return marker;
};

/** Review final app output against the platform base, including the private baseline projection. */
export const appBaselineReviewPreTree = async (
  sandbox: Pick<SandboxSession, "readTextFile">,
  selection: AppBaselineSelection,
  currentPreTree: readonly OverlayFile[],
): Promise<OverlayFile[]> => {
  const marker = await readAppBaselineMarker(sandbox, selection);
  if (marker === undefined) {
    throw new Error(
      "The app baseline publication preimages are unavailable. Restore the saved Builder source and retry review.",
    );
  }
  const appPrefix = `apps/${selection.appId}/`;
  const specs = new Set([
    `.config/app-specs/${selection.appId}.cue`,
    `.config/app-specs/${selection.appId}.md`,
  ]);
  return canonicalOverlayFiles([
    ...currentPreTree.filter((file) => !file.path.startsWith(appPrefix) && !specs.has(file.path)),
    ...marker.platformFiles,
  ]);
};

/** Later immutable release archives are retained on disk but are not baseline model input. */
export const readableAppBaselinePaths = async (
  sandbox: Pick<SandboxSession, "readTextFile">,
  selection: AppBaselineSelection | undefined,
  paths: string[],
): Promise<string[]> => {
  if (selection === undefined) {
    return paths;
  }
  const marker = await readAppBaselineMarker(sandbox, selection);
  if (marker === undefined) {
    throw new Error(
      "The selected app baseline is not prepared. Retry resolve_github_source before app inspection.",
    );
  }
  return paths.filter((candidate) => {
    const relative = path.posix.normalize(candidate.replace(/^\/workspace\/repository\//u, ""));
    return !marker.unexposedReleasePrefixes.some(
      (prefix) => relative === prefix.slice(0, -1) || relative.startsWith(prefix),
    );
  });
};

/** Builder-owned private Git projection. Git output is spooled to disk, without a total file/byte cap. */
export const appBaselineProjectionProgram = (input: {
  root: string;
  markerPath: string;
  selection: AppBaselineSelection;
  platform: z.infer<typeof platformSchema>;
  callId: string;
}): string => String.raw`
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, isAbsolute, join, resolve } = require("node:path");
const root = ${JSON.stringify(input.root)};
const markerPath = ${JSON.stringify(input.markerPath)};
const selection = ${JSON.stringify(appBaselineSelectionSchema.parse(input.selection))};
const platform = ${JSON.stringify(platformSchema.parse(input.platform))};
let projectedByCallId = ${JSON.stringify(input.callId)};
const sha256 = value => createHash("sha256").update(value).digest("hex");
const sha256File = file => {
  const handle = openSync(file, "r");
  const chunk = Buffer.alloc(64 * 1024);
  const hash = createHash("sha256");
  try {
    for (;;) { const length = readSync(handle, chunk, 0, chunk.length, null); if (!length) break; hash.update(chunk.subarray(0, length)); }
    return hash.digest("hex");
  } finally { closeSync(handle); }
};
const gitArgs = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "credential.helper=", "-C", root];
const gitEnv = { ...process.env, GIT_TRACE: "0", GIT_TRACE_CURL: "0", GIT_CURL_VERBOSE: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" };
const records = file => {
  const handle = openSync(file, "r");
  const chunk = Buffer.alloc(64 * 1024);
  const values = [];
  let pending = Buffer.alloc(0);
  try {
    for (;;) {
      const length = readSync(handle, chunk, 0, chunk.length, null);
      if (!length) break;
      const bytes = Buffer.concat([pending, chunk.subarray(0, length)]);
      let start = 0;
      for (let next = bytes.indexOf(0); next !== -1; next = bytes.indexOf(0, start)) {
        values.push(bytes.subarray(start, next).toString("utf8"));
        start = next + 1;
      }
      pending = Buffer.from(bytes.subarray(start));
    }
    if (pending.length) throw new Error("Incomplete Git path listing");
    return values;
  } finally { closeSync(handle); }
};
const git = (args, asRecords = false, destination) => {
  const temporary = mkdtempSync(join(tmpdir(), "builder-app-baseline-git-"));
  const output = destination || join(temporary, "stdout");
  const handle = openSync(output, "w");
  try {
    execFileSync("git", [...gitArgs, "-c", "protocol.allow=never", ...args], { env: gitEnv, stdio: ["ignore", handle, "inherit"] });
    return destination ? undefined : asRecords ? records(output) : readFileSync(output, "utf8").trim();
  } finally { closeSync(handle); rmSync(temporary, { force: true, recursive: true }); }
};
const safe = value => value && !isAbsolute(value) && !value.includes("\\") && !/[\r\n]/.test(value) && !value.split("/").some(part => part === "." || part === "..");
const prefix = "apps/" + selection.appId + "/";
const releasePrefix = prefix + "schema/release/";
const specPaths = [".config/app-specs/" + selection.appId + ".cue", ".config/app-specs/" + selection.appId + ".md"];
const owned = value => value.startsWith(prefix) || specPaths.includes(value);
const safeDestination = value => {
  if (!safe(value) || !owned(value)) throw new Error("App baseline path escaped its ownership scope");
  const destination = resolve(root, value);
  let ancestor = root;
  for (const part of value.split("/").slice(0, -1)) {
    ancestor = join(ancestor, part);
    if (existsSync(ancestor) && lstatSync(ancestor).isSymbolicLink()) throw new Error("App baseline cannot follow a symlink within its ownership scope");
  }
  let parent = dirname(destination);
  while (!existsSync(parent)) parent = dirname(parent);
  if (!realpathSync(parent).startsWith(realpathSync(root) + "/") && realpathSync(parent) !== realpathSync(root)) throw new Error("App baseline path follows a symlink outside its workspace");
  if (existsSync(destination) && !lstatSync(destination).isFile()) throw new Error("App baseline cannot replace a symlink or non-file");
  return destination;
};
const parseTree = sha => git(["ls-tree", "-r", "-z", "--full-tree", sha, "--", prefix, ...specPaths], true).map(entry => {
  const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t([^\r\n]+)$/.exec(entry);
  if (!match || !safe(match[3]) || !owned(match[3])) throw new Error("App baseline contains an unsupported file or unsafe path");
  return { mode: match[1], objectId: match[2], path: match[3] };
});
if (git(["rev-parse", "HEAD"]) !== platform.commitSha || git(["rev-parse", "HEAD^{tree}"]) !== platform.treeSha) throw new Error("App baseline platform source is not the selected repository snapshot");
if (existsSync(markerPath)) {
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  const keys = ["appId", "historical", "selectedByCallId", "sessionId", "source"];
  if (keys.some(key => JSON.stringify(marker.receipt[key]) !== JSON.stringify(selection[key]))) throw new Error("This workspace already owns a different app baseline");
  console.log(JSON.stringify(marker.receipt));
  process.exit(0);
}
try { git(["cat-file", "-e", selection.historical.commitSha + "^{commit}"]); }
catch {
  const token = process.env.APP_BUILDER_BASELINE_READ_TOKEN;
  if (!token) throw new Error("The app baseline Git object is unavailable; reconnect repository read access and retry");
  const remote = "https://github.com/" + selection.historical.owner + "/" + selection.historical.name + ".git";
  const fetchEnv = { ...gitEnv, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: "Authorization: Basic " + Buffer.from("x-access-token:" + token).toString("base64") };
  execFileSync("git", [...gitArgs, "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", remote, selection.historical.commitSha], { env: fetchEnv, stdio: ["ignore", "ignore", "inherit"] });
}
if (git(["rev-parse", selection.historical.commitSha + "^{tree}"]) !== selection.historical.treeSha) throw new Error("The historical app Git tree does not match its verified source");
const baseline = parseTree(selection.historical.commitSha);
if (!baseline.some(entry => entry.path.startsWith(prefix))) throw new Error("The selected historical version does not contain this app");
const platformTree = parseTree(platform.commitSha);
const platformFiles = platformTree.map(entry => {
  const temporary = mkdtempSync(join(tmpdir(), "builder-baseline-preimage-"));
  const output = join(temporary, "content");
  try {
    git(["cat-file", "blob", entry.objectId], false, output);
    return { digest: sha256File(output), mode: entry.mode.slice(3), path: entry.path };
  } finally { rmSync(temporary, { force: true, recursive: true }); }
}).sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
const baselinePaths = new Set(baseline.map(entry => entry.path));
const originalReleases = platformTree.filter(entry => entry.path.startsWith(releasePrefix));
const unexposedReleasePrefixes = [...new Set(originalReleases.filter(entry => !baselinePaths.has(entry.path)).map(entry => releasePrefix + entry.path.slice(releasePrefix.length).split("/")[0] + "/"))].sort();
const current = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", prefix, ...specPaths], true);
const planPath = markerPath + ".plan";
const changes = git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", prefix, ...specPaths], true);
let plan;
if (existsSync(planPath)) {
  plan = JSON.parse(readFileSync(planPath, "utf8"));
  if (JSON.stringify(plan.selection) !== JSON.stringify(selection) || JSON.stringify(plan.platform) !== JSON.stringify(platform)) throw new Error("This workspace already owns a different app baseline preparation");
  projectedByCallId = plan.projectedByCallId;
  const originals = new Map(platformTree.map(entry => [entry.path, entry.objectId]));
  const targets = new Map(baseline.map(entry => [entry.path, entry.objectId]));
  for (const value of current) {
    const destination = safeDestination(value);
    if (!existsSync(destination)) continue;
    const actual = git(["hash-object", "--no-filters", "--", destination]);
    if (actual !== originals.get(value) && actual !== targets.get(value)) throw new Error("App edits conflict with an unfinished baseline preparation; use a new Builder session");
  }
} else {
  if (changes.length) throw new Error("The app workspace already contains edits. Select the app baseline in a new Builder session before editing or inspecting app source");
  plan = { selection, platform, projectedByCallId, restorePaths: baseline.filter(entry => !entry.path.startsWith(releasePrefix) || !existsSync(safeDestination(entry.path))).map(entry => entry.path), removedPaths: current.filter(value => !baselinePaths.has(value) && !value.startsWith(releasePrefix)) };
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath + ".pending", JSON.stringify(plan), { mode: 0o600 });
  renameSync(planPath + ".pending", planPath);
}
for (const entry of baseline) {
  const destination = safeDestination(entry.path);
  if (entry.path.startsWith(releasePrefix) && existsSync(destination) && git(["hash-object", "--no-filters", "--", destination]) !== entry.objectId) throw new Error("A checked historical release has different bytes; it cannot be rewritten by baseline selection");
}
const removedFiles = plan.removedPaths.length;
for (const item of current) {
  if (!safe(item) || !owned(item)) throw new Error("App baseline current path escaped its ownership scope");
  if (baselinePaths.has(item) || item.startsWith(releasePrefix)) continue;
  rmSync(safeDestination(item), { force: true });
}
const restoredFiles = plan.restorePaths.length;
for (const entry of baseline) {
  const destination = safeDestination(entry.path);
  if (entry.path.startsWith(releasePrefix) && existsSync(destination)) continue;
  mkdirSync(dirname(destination), { recursive: true });
  const stageDirectory = markerPath + ".files";
  mkdirSync(stageDirectory, { recursive: true });
  const staged = join(stageDirectory, sha256(entry.path));
  git(["cat-file", "blob", entry.objectId], false, staged);
  chmodSync(staged, entry.mode === "100755" ? 0o755 : 0o644);
  renameSync(staged, destination);
}
const unsigned = { ...selection, platform, platformSourceDigest: sha256(JSON.stringify(platformFiles)), projectedByCallId, removedFiles, restoredFiles, retainedReleaseFiles: originalReleases.length, sourceDigest: sha256(JSON.stringify(baseline)), unexposedReleaseDigest: sha256(JSON.stringify(unexposedReleasePrefixes)), version: 1 };
const receipt = { ...unsigned, digest: sha256(JSON.stringify(unsigned)) };
mkdirSync(dirname(markerPath), { recursive: true });
const temporaryMarker = markerPath + ".pending";
writeFileSync(temporaryMarker, JSON.stringify({ platformFiles, receipt, unexposedReleasePrefixes }) + "\n", { mode: 0o600 });
renameSync(temporaryMarker, markerPath);
rmSync(planPath, { force: true });
rmSync(markerPath + ".files", { force: true, recursive: true });
console.log(JSON.stringify(receipt));
`;

export const projectAppBaseline = async (input: {
  sandbox: SandboxSession;
  selection: AppBaselineSelection;
  platform: z.infer<typeof platformSchema>;
  callId: string;
  token: string;
}): Promise<AppBaselineReceipt> => {
  const selection = appBaselineSelectionSchema.parse(input.selection);
  const existing = await readAppBaselineMarker(input.sandbox, selection);
  if (existing !== undefined) {
    return existing.receipt;
  }
  const scriptPath = ".app-builder/app-baseline-project.cjs";
  await input.sandbox.writeTextFile({
    content: appBaselineProjectionProgram({
      callId: input.callId,
      markerPath: `/workspace/${appBaselineMarkerPath(selection.appId)}`,
      platform: platformSchema.parse(input.platform),
      root: "/workspace/repository",
      selection,
    }),
    path: scriptPath,
  });
  const result = await input.sandbox.run({
    command: `node /workspace/${scriptPath}`,
    env: { APP_BUILDER_BASELINE_READ_TOKEN: input.token },
    workingDirectory: "/workspace",
  });
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout)
      .replaceAll(input.token, "[REDACTED]")
      .replaceAll(/https?:\/\/[^\s]+/gu, "[URL REDACTED]")
      .trim();
    throw new Error(
      `Builder could not prepare the selected app baseline. Retry its saved source selection after resolving the Git or app-file failure. ${detail}`,
    );
  }
  return appBaselineReceiptSchema.parse(JSON.parse(result.stdout));
};
