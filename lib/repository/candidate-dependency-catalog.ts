import { randomUUID } from "node:crypto";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";
import { ensureSandboxDirectories } from "./sandbox-filesystem";
import { sanitizeValidationDiagnosticText } from "./validation-output-sanitize";

import {
  assertDraftReconciliationCandidateAvailable,
  nonAppIndexDigest,
} from "./sandbox-draft-reconciliation";
import type { PreparedDraftReconciliation } from "./sandbox-draft-reconciliation";

export const catalogDependencyName = z
  .string()
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u);

const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

// Fixed, repository-neutral operation. Inputs select an existing dependency,
// never source text, a version, a checkout, or an arbitrary command.
export const normalizeCandidateCatalogProgram = String.raw`
const { createHash } = require("node:crypto");
const { cpSync, globSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const { delimiter, join, relative } = require("node:path");
const { tmpdir } = require("node:os");
const { spawnSync } = require("node:child_process");
const [candidate, app, dependency] = process.argv.slice(1);
const root = realpathSync(candidate);
const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const safe = path => {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === ".." || part === ".git")) throw Error("Unsafe dependency metadata path");
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw Error("Symlink in dependency metadata path: " + path); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return current;
};
const read = path => {
  const file = safe(path);
  if (!lstatSync(file).isFile()) throw Error("Dependency metadata is not a regular file: " + path);
  return {path, bytes: readFileSync(file), value: JSON.parse(readFileSync(file, "utf8"))};
};
const rootManifest = read("package.json");
const appManifest = read("apps/" + app + "/package.json");
const patterns = Array.isArray(rootManifest.value.workspaces) ? rootManifest.value.workspaces : rootManifest.value.workspaces?.packages;
if (!Array.isArray(patterns) || patterns.some(pattern => typeof pattern !== "string" || pattern.startsWith("!") || pattern.split("/").some(part => part === ".."))) throw Error("Repository workspace declarations are unavailable for dependency normalization");
const paths = new Set(["package.json"]);
for (const pattern of patterns) {
  for (const path of globSync(pattern + "/package.json", {cwd: root, exclude: ["**/node_modules/**"]})) paths.add(path);
}
if (!paths.has(appManifest.path)) throw Error("Selected app is not a declared repository workspace");
const manifests = [...paths].sort().map(path => path === "package.json" ? rootManifest : path === appManifest.path ? appManifest : read(path));
const appConsumers = sections.filter(section => Object.hasOwn(appManifest.value[section] ?? {}, dependency));
if (!appConsumers.length) throw Error("Selected app does not declare " + dependency);
const catalog = rootManifest.value.catalog ?? {};
const declared = manifests.flatMap(manifest => sections.flatMap(section => Object.hasOwn(manifest.value[section] ?? {}, dependency) ? [{manifest, section, version: manifest.value[section][dependency]}] : []));
const version = catalog[dependency] ?? declared.find(entry => entry.version !== "catalog:")?.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw Error("Dependency normalization requires an existing concrete version; no version was selected or upgraded");
if (declared.some(entry => entry.version !== version && entry.version !== "catalog:")) throw Error("Dependency consumers disagree on the existing version; no metadata was changed");
const proposed = new Map();
rootManifest.value.catalog = Object.fromEntries(Object.entries({...catalog, [dependency]: version}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
for (const entry of declared) entry.manifest.value[entry.section][dependency] = "catalog:";
for (const manifest of manifests) {
  const next = Buffer.from(JSON.stringify(manifest.value, null, 2) + "\n");
  // Preserve untouched manifest bytes, including their formatting.
  const original = JSON.parse(manifest.bytes.toString("utf8"));
  if (JSON.stringify(original) !== JSON.stringify(manifest.value)) proposed.set(manifest.path, next);
}
const lockPath = safe("bun.lock");
let lockBefore;
try { if (!lstatSync(lockPath).isFile()) throw Error("Lock metadata is not a regular file"); lockBefore = readFileSync(lockPath); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const metadataPaths = [...proposed.keys(), "bun.lock"];
// Unregistered shared edits must never be absorbed by this narrow operation.
const prior = spawnSync("git", ["--literal-pathspecs", "-C", root, "diff", "--quiet", "--", ...metadataPaths], {stdio: ["ignore", "ignore", "pipe"]});
if (prior.status !== 0) throw Error("Dependency metadata has unstaged edits; preserve/review those edits before normalization");
// Lock generation happens outside the candidate. A killed planner leaves its source/index untouched.
const index = spawnSync("git", ["-C", root, "ls-files", "--stage", "-z"], {encoding:"utf8"});
if (index.status !== 0) throw Error("Could not bind original candidate index");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "builder-catalog-plan-")));
try {
  cpSync(root, scratch, {recursive:true, verbatimSymlinks:true, filter: source => !relative(root, source).split("/").some(part => part === ".git" || part === "node_modules")});
  for (const [path, bytes] of proposed) writeFileSync(join(scratch,path), bytes);
  const generated = spawnSync("mise", ["exec", "--", "bun", "install", "--lockfile-only", "--ignore-scripts"], {cwd:scratch, env:{...process.env,MISE_TRUSTED_CONFIG_PATHS:[process.env.MISE_TRUSTED_CONFIG_PATHS,scratch].filter(Boolean).join(delimiter)}, stdio:["ignore",2,2]});
  let lockAfter;
  try { lockAfter=readFileSync(join(scratch,"bun.lock")); } catch(error) {if(error.code !== "ENOENT") throw error;}
  if (lockAfter === undefined) throw Error("Lock generation removed lock metadata; candidate was not changed");
  const files = [...proposed].map(([path,after]) => ({path,before:readFileSync(safe(path)).toString("base64"),after:after.toString("base64")}));
  files.push({path:"bun.lock",before:lockBefore?.toString("base64") ?? null,after:lockAfter.toString("base64")});
  for(const file of files){
    const temporary=safe(file.path+".catalog-pending-"+hash(file.after));
    try{lstatSync(temporary);throw Error("Catalog transaction temporary path already exists");}catch(error){if(error.code!=="ENOENT")throw error;}
  }
  console.log(JSON.stringify({root,appId:app,dependency,version,index:index.stdout,files,lockGenerated:generated.status===0,lockExitCode:generated.status}));
} finally { rmSync(scratch,{recursive:true,force:true}); }

`;

export const candidateDependencyCatalogIntentSchema = z.strictObject({
  root: z.string(),
  appId: z.string(),
  dependency: catalogDependencyName,
  version: z.string(),
  index: z.string(),
  files: z.array(
    z.strictObject({ path: z.string(), before: z.string().nullable(), after: z.string() }),
  ),
  lockGenerated: z.boolean(),
  lockExitCode: z.number().nullable(),
  diagnostic: z.string(),
});

export type CandidateDependencyCatalogIntent = z.infer<
  typeof candidateDependencyCatalogIntentSchema
>;

// Only a server-retained plan enters this fixed apply program; public input never supplies bytes.
export const applyCandidateCatalogProgram = String.raw`
const {createHash}=require("node:crypto");
const {chmodSync,lstatSync,readFileSync,realpathSync,renameSync,writeFileSync}=require("node:fs");
const {join}=require("node:path");
const {spawnSync}=require("node:child_process");
const [candidate,intentPath]=process.argv.slice(1);
const intent=JSON.parse(readFileSync(intentPath,"utf8"));
const root=realpathSync(candidate);
if(root !== intent.root) throw Error("Catalog intent belongs to another candidate");
const git=args=>{
  const result=spawnSync("git",["--literal-pathspecs","-C",root,...args],{encoding:"utf8"});
  if(result.status!==0)throw Error(result.stderr||"Catalog Git operation failed");
  return result.stdout;
};
const safe=path=>{
  if(!path || path.startsWith("/") || path.includes("\\") || path.split("/").some(part=>!part || part==="." || part===".." || part===".git"))throw Error("Unsafe catalog intent path");
  let current=root;
  for(const part of path.split("/")){
    current=join(current,part);
    try{if(lstatSync(current).isSymbolicLink())throw Error("Symlink in catalog intent path");}catch(error){if(error.code!=="ENOENT")throw error;}
  }
  return current;
};
const selected=new Set(intent.files.map(file=>file.path));
const entries=text=>text.split("\0").filter(Boolean);
const entryPath=entry=>entry.slice(entry.indexOf("\t")+1);
const outside=text=>entries(text).filter(entry=>!selected.has(entryPath(entry))).join("\0");
const current=git(["ls-files","--stage","-z"]);
for(const entry of entries(intent.index).filter(entry=>selected.has(entryPath(entry))))if(!entries(current).some(now=>entryPath(now)===entryPath(entry)))throw Error("Candidate metadata was removed from the pending index");
if(outside(current)!==outside(intent.index))throw Error("Candidate index changed outside pending catalog intent");
for(const entry of entries(current).filter(entry=>selected.has(entryPath(entry)))){
  if(entries(intent.index).includes(entry))continue;
  const file=intent.files.find(file=>file.path===entryPath(entry));
  const [mode,oid,stage]=entry.slice(0,entry.indexOf("\t")).split(" ");
  const original=entries(intent.index).find(entry=>entryPath(entry)===file.path);
  const expectedMode=original?.split(" ")[0] ?? "100644";
  if(mode!==expectedMode || stage!=="0" || Buffer.from(git(["cat-file","blob",oid])).toString("base64")!==file.after)throw Error("Candidate staged metadata differs from pending catalog intent");
}
for(const path of git(["diff","--name-only","-z"]).split("\0").filter(Boolean))if(!selected.has(path))throw Error("Unstaged content changed outside pending catalog intent");
for(const file of intent.files){
  let bytes=null;
  try{if(!lstatSync(safe(file.path)).isFile())throw Error("Catalog metadata is not regular");bytes=readFileSync(safe(file.path)).toString("base64");}catch(error){if(error.code!=="ENOENT")throw error;}
  if(bytes!==file.before && bytes!==file.after)throw Error("Candidate metadata differs from exact pending catalog bytes: "+file.path);
}
// Rename atomically, so even a kill during a large write leaves exact before/after bytes.
for(const file of intent.files){
  const destination=safe(file.path);
  const temporary=safe(file.path+".catalog-pending-"+createHash("sha256").update(file.after).digest("hex"));
  let mode=0o644;try{mode=lstatSync(destination).mode & 0o777;}catch(error){if(error.code!=="ENOENT")throw error;}
  writeFileSync(temporary,Buffer.from(file.after,"base64"));
  chmodSync(temporary,mode);
  renameSync(temporary,destination);
}
git(["add","--",...selected]);
const files=intent.files.filter(file=>file.before!==file.after).map(file=>({path:file.path,digest:createHash("sha256").update(readFileSync(safe(file.path))).digest("hex")}));
console.log(JSON.stringify({files}));
`;

const executeCatalogProgram = async (input: {
  sandbox: SandboxSession;
  root: string;
  program: string;
  args: string[];
  signal?: AbortSignal;
}) => {
  const process = await input.sandbox.spawn({
    abortSignal: input.signal,
    command: `node -e ${quote(input.program)} ${input.args.map(quote).join(" ")}`,
    workingDirectory: input.root,
  });
  const [stdout, stderr, completed] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.wait(),
  ]);
  const diagnostic = sanitizeValidationDiagnosticText(stderr).slice(-8192);
  if (completed.exitCode !== 0) {
    throw new Error(`Builder could not normalize candidate dependency metadata: ${diagnostic}`);
  }
  return { stdout, diagnostic };
};

export const planCandidateDependencyCatalog = async (input: {
  sandbox: SandboxSession;
  prepared: PreparedDraftReconciliation;
  dependency: string;
  signal?: AbortSignal;
}): Promise<CandidateDependencyCatalogIntent> => {
  const dependency = catalogDependencyName.parse(input.dependency);
  await assertDraftReconciliationCandidateAvailable(input);
  const result = await executeCatalogProgram({
    ...input,
    root: input.prepared.root,
    program: normalizeCandidateCatalogProgram,
    args: [input.prepared.root, input.prepared.appId, dependency],
  });
  return candidateDependencyCatalogIntentSchema.parse({
    ...JSON.parse(result.stdout),
    diagnostic: result.diagnostic,
  });
};

export const normalizeCandidateDependencyCatalog = async (input: {
  sandbox: SandboxSession;
  prepared: PreparedDraftReconciliation;
  intent: CandidateDependencyCatalogIntent;
  signal?: AbortSignal;
}) => {
  await assertDraftReconciliationCandidateAvailable(input);
  const intent = candidateDependencyCatalogIntentSchema.parse(input.intent);
  if (intent.root !== input.prepared.root || intent.appId !== input.prepared.appId) {
    throw new Error("Catalog intent belongs to another candidate.");
  }
  const relativeIntentPath = `.app-builder/catalog-intents/${randomUUID()}.json`;
  const intentPath = `${input.prepared.workspaceRoot}/${relativeIntentPath}`;
  await ensureSandboxDirectories(input.sandbox, [
    `${input.prepared.workspaceRoot}/.app-builder/catalog-intents`,
  ]);
  let result: Awaited<ReturnType<typeof executeCatalogProgram>>;
  try {
    await input.sandbox.writeTextFile({
      path: relativeIntentPath,
      content: JSON.stringify(intent),
    });
    result = await executeCatalogProgram({
      ...input,
      root: input.prepared.root,
      program: applyCandidateCatalogProgram,
      args: [input.prepared.root, intentPath],
    });
  } finally {
    try {
      await input.sandbox.removePath({ path: relativeIntentPath, force: true });
    } catch {
      // The retained server intent remains retryable when sandbox cleanup is unavailable.
    }
  }
  const applied = z
    .strictObject({
      files: z.array(
        z.strictObject({ path: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/u) }),
      ),
    })
    .parse(JSON.parse(result.stdout));
  return {
    dependency: intent.dependency,
    version: intent.version,
    lockGenerated: intent.lockGenerated,
    lockExitCode: intent.lockExitCode,
    diagnostic: intent.diagnostic,
    files: applied.files,
    receipt: {
      files: applied.files,
      nonAppIndexDigest: await nonAppIndexDigest(
        input.sandbox,
        input.prepared.root,
        input.prepared.appId,
      ),
    },
  };
};
