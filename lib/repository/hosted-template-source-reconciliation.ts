import { createHash, createHmac, createPrivateKey, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";
import { createGitHubTokenOctokit } from "../github/octokit";
import { getBuilderSandboxId } from "../sandbox/builder-sandbox";
import {
  deploymentArrustedTemplateReader,
  readDeploymentArrustedTemplateReaderConfig,
} from "./arrusted-template-reader";
import type { ArrustedTemplateReader } from "./arrusted-template-reader";
import { planningSourceReconciliationProgram } from "./planning-source-reconciliation";
import { preparedSourceManifestRecoveryProgram } from "./prepared-source-manifest-recovery";
import {
  ARRUSTED_TEMPLATE_REPOSITORY,
  inspectCanonicalTemplateSnapshotReceipt,
  parseSourceReceipt,
} from "./source-receipt";
import type { SourceReceipt } from "./source-receipt";
import type { PreparedSandboxWorkspace } from "./supported-template";

const root = "/workspace/repository";
const metadataRoot = "/workspace/.app-builder";
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const workspaceSchema = z.strictObject({
  adapter: z.literal("arrusted-development-v0"),
  eligibilityDigest: digest,
  sourcePath: z.string(),
  sourceSha: sha,
  sourceTree: sha,
  workspaceDigest: digest,
  workspaceId: z.string().min(1),
  workspacePath: z.literal(root),
});
const provenanceSchema = z.strictObject({
  previousSourceReceiptDigest: digest,
  previousWorkspaceDigest: digest,
  previousSourceSha: sha,
  sourceSha: sha,
  sourceTree: sha,
  sourceSnapshotTree: sha,
  checkpointRef: z.string().optional(),
});
const resultSchema = z.strictObject({
  changed: z.boolean(),
  sourceReceipt: z.unknown().transform(parseSourceReceipt),
  workspace: workspaceSchema,
  provenance: provenanceSchema,
});
export type HostedTemplateFoundationResult = z.infer<typeof resultSchema>;
export interface HostedTemplateFoundationInput {
  appId: string;
  sessionId: string;
  callId: string;
  sourceReceipt: SourceReceipt;
  workspace: PreparedSandboxWorkspace;
  sandbox: SandboxSession;
  assertCurrent: () => void | Promise<void>;
  signal?: AbortSignal;
  reader?: ArrustedTemplateReader;
  readCanonicalHead?: (token: string) => Promise<{ sourceSha: string; sourceTree: string }>;
  provenance?: HostedTemplateFoundationProvenance;
}

const scopeSchema = z.strictObject({
  appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  sessionId: z.string().min(1),
  sourceReceiptDigest: digest,
  workspace: workspaceSchema,
});
const frozenTransitionSchema = z.strictObject({
  version: z.literal(1),
  scope: scopeSchema,
  callId: z.string().min(1),
  result: resultSchema,
});
const journalSchema = frozenTransitionSchema.extend({
  state: z.enum(["planned", "completed"]),
  authentication: digest,
});
export interface HostedTemplateFoundationProvenance {
  sign: (payload: z.infer<typeof frozenTransitionSchema>) => string;
  verify: (payload: z.infer<typeof frozenTransitionSchema>, signature: string) => boolean;
}
/** The existing reader credential stays server-side; only a purpose-separated seal enters the Sandbox. */
export const createHostedTemplateFoundationProvenance = (
  readerKey: string | Buffer,
): HostedTemplateFoundationProvenance => {
  const key = createHmac("sha256", readerKey)
    .update("autograph/hosted-template-foundation/provenance-key/v1")
    .digest();
  const sign = (payload: z.infer<typeof frozenTransitionSchema>) =>
    createHmac("sha256", key)
      .update("autograph/hosted-template-foundation/transition/v1\n")
      .update(JSON.stringify(frozenTransitionSchema.parse(payload)))
      .digest("hex");
  return {
    sign,
    verify: (payload, signature) => {
      if (!digest.safeParse(signature).success) {
        return false;
      }
      return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(sign(payload), "hex"));
    },
  };
};
const frozenPayload = (journal: z.infer<typeof frozenTransitionSchema>) =>
  frozenTransitionSchema.parse({
    version: journal.version,
    scope: journal.scope,
    callId: journal.callId,
    result: journal.result,
  });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export class HostedTemplateFoundationUnavailableError extends Error {
  constructor() {
    super(
      "The owned template foundation recovery is unavailable. Existing app source and runtime data are preserved.",
    );
    this.name = "HostedTemplateFoundationUnavailableError";
  }
}
const unavailable = () => new HostedTemplateFoundationUnavailableError();
const deploymentProvenance = () => {
  try {
    const { privateKey } = readDeploymentArrustedTemplateReaderConfig(process.env);
    const canonicalKey = createPrivateKey(privateKey).export({ type: "pkcs8", format: "der" });
    return createHostedTemplateFoundationProvenance(canonicalKey);
  } catch {
    throw unavailable();
  }
};
const scopeChanged = () =>
  new Error("The owned template foundation scope or baseline integrity changed.");

/** Fixed read-only repository route; neither the creator nor candidate chooses its foundation. */
export const readCanonicalTemplateFoundation = async (
  token: string,
  fetch?: typeof globalThis.fetch,
) => {
  try {
    const response = await createGitHubTokenOctokit({ token, fetch }).request(
      "GET /repos/{owner}/{repo}/commits/{ref}",
      { owner: "withAutograph", repo: "arrusted-development", ref: "main" },
    );
    const observed = z
      .object({ sha, commit: z.object({ tree: z.object({ sha }) }) })
      .parse(response.data);
    return { sourceSha: observed.sha, sourceTree: observed.commit.tree.sha };
  } catch {
    throw unavailable();
  }
};

/** Private filesystem transition; the existing Git engine owns checkpointing and three-way preservation. */
export const hostedTemplateFoundationProgram = String.raw`
class FoundationIntegrityError extends Error {}
try {
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const input = JSON.parse(process.argv[1]);
const { APP_BUILDER_SOURCE_READ_TOKEN: token, ...environment } = process.env;
const sha256 = value => createHash("sha256").update(value).digest("hex");
const safeDirectory = directory => {
  const parent = path.dirname(directory);
  if (parent !== directory) safeDirectory(parent);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode:448 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new FoundationIntegrityError("Foundation metadata directory is unavailable.");
};
const regular = file => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new FoundationIntegrityError("Foundation metadata file is unavailable.");
};
const read = file => { regular(file); return fs.readFileSync(file, "utf8"); };
const readJson = file => { try { return JSON.parse(read(file)); } catch(error) { if(error instanceof SyntaxError) throw new FoundationIntegrityError("Foundation metadata is invalid."); throw error; } };
const write = (file, bytes) => {
  const temporary = file + ".pending";
  if (fs.existsSync(temporary)) { regular(temporary); fs.unlinkSync(temporary); }
  fs.writeFileSync(temporary, bytes, { mode:384, flag:"wx" });
  if (fs.existsSync(file)) regular(file);
  fs.renameSync(temporary, file);
};
const gitBinary = fs.existsSync("/usr/bin/git") ? "/usr/bin/git" : "/bin/git";
const git = arguments_ => execFileSync(gitBinary, ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "credential.helper=", "-c", "protocol.allow=never", "-C", input.root, ...arguments_], { encoding:"utf8", env:{...environment,GIT_NO_LAZY_FETCH:"1",GIT_TERMINAL_PROMPT:"0",GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null"},stdio:["ignore","pipe","pipe"] }).trim();
const child = (program, request, env=environment, proof=false) => {
  const result = spawnSync(process.execPath, ["-e", program, JSON.stringify(request)], {cwd:input.root,env,encoding:"utf8",maxBuffer:Infinity,stdio:["ignore","pipe","pipe"]});
  if (result.error || result.status !== 0) throw proof ? new FoundationIntegrityError("Foundation proof did not complete.") : Error("Foundation transition did not complete; its retained checkpoint can resume.");
  return result.stdout;
};
if (fs.realpathSync(input.root) !== input.root) throw new FoundationIntegrityError("Foundation workspace is unavailable.");
safeDirectory(input.metadataRoot);
safeDirectory(input.transitionRoot);
const journalPath = path.join(input.transitionRoot,"transition.json");
let journal = fs.existsSync(journalPath) ? readJson(journalPath) : input.journal;
const {state:journalState,...journalFrozen} = journal;
const {state:expectedState,...expectedFrozen} = input.journal;
if (!["planned","completed"].includes(journalState) || !isDeepStrictEqual(journalFrozen,expectedFrozen)) throw new FoundationIntegrityError("Foundation transition belongs to another source.");
const next = journal.result;
if (git(["rev-parse",input.journal.scope.workspace.sourceSha+"^{tree}"]) !== input.journal.scope.workspace.sourceTree) throw new FoundationIntegrityError("Original foundation objects are unavailable.");
const recordPath = path.join(input.metadataRoot,"prepared-workspace.json");
const observed = readJson(recordPath);
if (!isDeepStrictEqual(observed,input.journal.scope.workspace) && !isDeepStrictEqual(observed,next.workspace)) throw new FoundationIntegrityError("Foundation workspace ownership changed.");
if (!fs.existsSync(journalPath)) write(journalPath,JSON.stringify(journal)+"\n");
if (journal.state !== "completed") {
  const result = JSON.parse(child(input.reconciliationProgram,{
    appId:journal.scope.appId,root:input.root,stateRoot:path.join(input.transitionRoot,"git"),sessionId:journal.scope.sessionId,
    targetSha:next.provenance.sourceSha,branchRef:"refs/heads/main",repository:input.repository,fetchRemote:input.fetchRemote,
    checkpointRef:next.provenance.checkpointRef,
  },{...environment,APP_BUILDER_SOURCE_READ_TOKEN:token}));
  if (result.sourceSha !== next.workspace.sourceSha || result.sourceTree !== next.workspace.sourceTree) throw new FoundationIntegrityError("Fetched foundation identity changed.");
  const staged = path.join(input.transitionRoot,"baseline");
  safeDirectory(staged);
  const stagedManifest = path.join(staged,"source-files.json");
  const manifestDigest = fs.existsSync(stagedManifest) ? sha256(JSON.stringify(readJson(stagedManifest))) : undefined;
  child(input.manifestProgram,{...next.workspace,manifestDirectory:staged,manifestDigest},environment,true);
  const previous = path.join(input.transitionRoot,"previous");
  safeDirectory(previous);
  const metadata = {
    "source-files.json":read(stagedManifest),
    "source-checksums.sha256":read(path.join(staged,"source-checksums.sha256")),
    "prepared-workspace.json":JSON.stringify(next.workspace,null,2)+"\n",
    "prepare-intent.json":JSON.stringify({callId:journal.callId,eligibilityDigest:next.workspace.eligibilityDigest,sourcePath:next.workspace.sourcePath,sourceSha:next.workspace.sourceSha,sourceTree:next.workspace.sourceTree})+"\n",
    "canonical-clone-inspection.json":JSON.stringify({sourcePath:input.root,sourceSha:next.workspace.sourceSha,sourceTree:next.workspace.sourceTree,contents:{},contract:[],dirtyPaths:git(["status","--porcelain=v1"]).split("\n").filter(Boolean).map(line=>line.slice(3))})+"\n",
  };
  for (const name of Object.keys(metadata)) {
    const current = path.join(input.metadataRoot,name);
    const backup = path.join(previous,name);
    if (fs.existsSync(current)) {
      regular(current);
      if (!fs.existsSync(backup)) fs.copyFileSync(current,backup,fs.constants.COPYFILE_EXCL);
      else regular(backup);
    }
  }
  for (const [name,bytes] of Object.entries(metadata)) write(path.join(input.metadataRoot,name),bytes);
  journal = {...journal,state:"completed"};
  write(journalPath,JSON.stringify(journal)+"\n");
}
if (git(["rev-parse","HEAD"]) !== next.workspace.sourceSha || git(["rev-parse","HEAD^{tree}"]) !== next.workspace.sourceTree || !isDeepStrictEqual(readJson(recordPath),next.workspace)) throw new FoundationIntegrityError("Completed foundation changed.");
const manifest = readJson(path.join(input.metadataRoot,"source-files.json"));
child(input.manifestProgram,{...next.workspace,manifestDigest:sha256(JSON.stringify(manifest))},environment,true);
process.stdout.write(JSON.stringify(next));
} catch(error) {
  process.stdout.write(JSON.stringify({failure:error instanceof FoundationIntegrityError ? "integrity" : "unavailable"}));
  process.exitCode=1;
}
`;

/** Reconcile an actual local failure or an explicit same-app source refresh, without a freshness admission policy. */
export const reconcileHostedTemplateFoundation = async (
  input: HostedTemplateFoundationInput,
): Promise<HostedTemplateFoundationResult> => {
  const assertCurrent = async () => {
    input.signal?.throwIfAborted();
    await input.assertCurrent();
    input.signal?.throwIfAborted();
  };
  await assertCurrent();
  const receipt = parseSourceReceipt(input.sourceReceipt);
  const workspace = workspaceSchema.parse(input.workspace);
  if (
    [
      receipt.sourceKind !== "fresh-template",
      receipt.sourcePath !== root,
      workspace.workspacePath !== root,
      workspace.sourcePath !== root,
      workspace.workspaceId !== getBuilderSandboxId(input.sandbox),
      receipt.sourceSha !== workspace.sourceSha,
      receipt.sourceTree !== workspace.sourceTree,
    ].some(Boolean)
  ) {
    throw scopeChanged();
  }
  const scope = scopeSchema.parse({
    appId: input.appId,
    sessionId: input.sessionId,
    sourceReceiptDigest: receipt.digest,
    workspace,
  });
  const transitionId = hash(JSON.stringify(scope));
  const relativeRoot = `.app-builder/hosted-template-foundations/${transitionId}`;
  let stored: string | null;
  try {
    stored = await input.sandbox.readTextFile({ path: `${relativeRoot}/transition.json` });
  } catch {
    await assertCurrent();
    throw unavailable();
  }
  await assertCurrent();
  const acquire = async () => {
    try {
      return await (input.reader ?? deploymentArrustedTemplateReader()).acquire();
    } catch {
      await assertCurrent();
      throw unavailable();
    }
  };
  let journal: z.infer<typeof journalSchema>;
  let token: string | undefined;
  if (stored === null) {
    ({ token } = await acquire());
    await assertCurrent();
    let head: { sourceSha: string; sourceTree: string };
    try {
      head = await (input.readCanonicalHead ?? readCanonicalTemplateFoundation)(token);
    } catch {
      await assertCurrent();
      throw unavailable();
    }
    await assertCurrent();
    sha.parse(head.sourceSha);
    sha.parse(head.sourceTree);
    if (head.sourceSha === workspace.sourceSha && head.sourceTree === workspace.sourceTree) {
      return {
        changed: false,
        sourceReceipt: receipt,
        workspace,
        provenance: {
          previousSourceReceiptDigest: receipt.digest,
          previousWorkspaceDigest: workspace.workspaceDigest,
          previousSourceSha: workspace.sourceSha,
          ...head,
          sourceSnapshotTree: head.sourceTree,
        },
      };
    }
    const identity = hash(
      JSON.stringify({ sourceSha: head.sourceSha, sourceTree: head.sourceTree }),
    );
    const sourceReceipt = inspectCanonicalTemplateSnapshotReceipt({
      readinessDigest: identity,
      snapshot: { ...head, sourcePath: root, contents: {}, contract: [], dirtyPaths: [] },
    });
    const nextWorkspace = {
      ...workspace,
      ...head,
      eligibilityDigest: sourceReceipt.eligibilityDigest,
      workspaceDigest: identity,
    };
    const frozen = {
      version: 1 as const,
      scope,
      callId: input.callId,
      result: {
        changed: true,
        sourceReceipt,
        workspace: nextWorkspace,
        provenance: {
          previousSourceReceiptDigest: receipt.digest,
          previousWorkspaceDigest: workspace.workspaceDigest,
          previousSourceSha: workspace.sourceSha,
          ...head,
          sourceSnapshotTree: head.sourceTree,
          checkpointRef: `refs/app-builder/source-checkpoints/${hash(input.sessionId)}/${transitionId}`,
        },
      },
    };
    const provenance = input.provenance ?? deploymentProvenance();
    journal = {
      ...frozen,
      state: "planned",
      authentication: provenance.sign(frozenPayload(frozen)),
    };
  } else {
    let decoded: unknown;
    try {
      decoded = JSON.parse(stored);
    } catch {
      throw scopeChanged();
    }
    const parsed = journalSchema.safeParse(decoded);
    if (!parsed.success) {
      throw scopeChanged();
    }
    journal = parsed.data;
    const provenance = input.provenance ?? deploymentProvenance();
    if (
      !isDeepStrictEqual(journal.scope, scope) ||
      !provenance.verify(frozenPayload(journal), journal.authentication)
    ) {
      throw scopeChanged();
    }
  }
  if (journal.state !== "completed" && token === undefined) {
    ({ token } = await acquire());
    await assertCurrent();
  }
  const request = {
    root,
    metadataRoot,
    transitionRoot: `/workspace/${relativeRoot}`,
    repository: ARRUSTED_TEMPLATE_REPOSITORY,
    fetchRemote: true,
    journal,
    reconciliationProgram: planningSourceReconciliationProgram,
    manifestProgram: preparedSourceManifestRecoveryProgram,
  };
  let result: Awaited<ReturnType<SandboxSession["run"]>>;
  try {
    result = await input.sandbox.run({
      command: `node -e ${quote(hostedTemplateFoundationProgram)} ${quote(JSON.stringify(request))}`,
      workingDirectory: root,
      env: token === undefined ? {} : { APP_BUILDER_SOURCE_READ_TOKEN: token },
      abortSignal: input.signal,
    });
  } catch {
    await assertCurrent();
    throw unavailable();
  }
  await assertCurrent();
  if (result.exitCode !== 0) {
    let failure: unknown;
    try {
      failure = JSON.parse(result.stdout);
    } catch {
      /* An unavailable command need not return a result. */
    }
    if (z.object({ failure: z.literal("integrity") }).safeParse(failure).success) {
      throw scopeChanged();
    }
    throw unavailable();
  }
  let completed: HostedTemplateFoundationResult;
  try {
    completed = resultSchema.parse(JSON.parse(result.stdout));
  } catch {
    throw scopeChanged();
  }
  if (!isDeepStrictEqual(completed, journal.result)) {
    throw scopeChanged();
  }
  return completed;
};
