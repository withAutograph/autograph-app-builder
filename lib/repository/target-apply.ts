import { applyPrivateComputeCheckPolicy } from "./private-compute-check-policy";
import { sourceDeclaredToolchainActivationCommand } from "./source-toolchain";
import { workspaceBinInstallCommand } from "./workspace-bin-install";
import type { FrameworkVersions } from "./framework-upgrade";
import { frameworkUpgradeCommand, frameworkSharedPaths } from "./framework-upgrade";
import { setBuilderSandboxNetworkPolicy } from "../sandbox/builder-sandbox";
import { createHash } from "node:crypto";

import { z } from "zod";
import { validationOutputExcerpt } from "./target-validation";

import type { SandboxSession } from "eve/sandbox";
import { ensureSandboxDirectories } from "./sandbox-filesystem";
import { safeSourcePath } from "./source-path";
import { planningOverlayRoot } from "./dependency-cache";
import type { ExecutionDependencyLayout } from "./dependency-cache";
import type { TargetProposal, TargetIterationChange } from "./target-planning";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const omittedApplyAuthorities = [
  "provider-provisioning",
  "deployment",
  "production-readiness",
] as const;
const invalidManifestMessage = "The prepared workspace manifest is invalid.";
const workspacePrefix = "/workspace/";
const staleProposalKind = "stale-proposal";
const preparedSourceManifestSchema = z.array(
  z.object({
    mode: z.string().optional(),
    path: z.string().refine(safeSourcePath),
  }),
);
const commandFailureKindSchema = z.enum([
  "timeout",
  "permission-denied",
  "missing-command-or-file",
  "dependency",
  "validation",
  "repository-task",
  staleProposalKind,
  "proposal-blocked",
  "app-already-exists",
  "app-lock",
  "partial-state",
  "projected-repository",
  "empty-output",
  "unknown",
]);
const appRootPath = "/workspace/repository";
const packageNamePrefix = "@autograph/";
const iterationReceiptMutation = "microfrontends.json" as const;
const repositoryPath = z
  .string()
  .refine(safeSourcePath, "path must remain inside the apply overlay");

// Applying a generated app can include the repository's own install/build
// steps. Keep a generous provider-side ceiling, but do not turn a normal slow
// command into a synthetic failure at five minutes.

export const targetApplyCommandReceiptSchema = z.strictObject({
  appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  mutations: z.tuple([repositoryPath, z.literal(iterationReceiptMutation)]),
  omittedAuthorities: z.tuple([
    z.literal(omittedApplyAuthorities[0]),
    z.literal(omittedApplyAuthorities[1]),
    z.literal(omittedApplyAuthorities[2]),
  ]),
  recovered: z.boolean(),
  topology: z.strictObject({
    newDigest: digestSchema,
    oldDigest: digestSchema,
    path: z.literal(iterationReceiptMutation),
  }),
  version: z.literal(1),
  workspacePath: repositoryPath,
});

export type TargetApplyCommandReceipt = z.infer<typeof targetApplyCommandReceiptSchema>;

export interface OverlayFile {
  path: string;
  mode: string;
  digest: string;
}

export interface OverlaySnapshot {
  treeDigest: string;
  files: readonly OverlayFile[];
}

export function compareOverlayPaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf-8"), Buffer.from(right, "utf-8"));
}

export function canonicalOverlayFiles(files: readonly OverlayFile[]): OverlayFile[] {
  return files
    .map(({ path, mode, digest }) => ({ digest, mode, path }))
    .toSorted((left, right) => compareOverlayPaths(left.path, right.path));
}

/** Keep the planned preimages when a retry resumes after some writes succeeded. */
export const iterationBaselineSnapshot = (
  snapshot: OverlaySnapshot,
  changes: readonly TargetIterationChange[],
): OverlaySnapshot => {
  const files = new Map(snapshot.files.map((file) => [file.path, file]));
  for (const change of changes) {
    if (change.before === undefined) {
      files.delete(change.path);
    } else {
      files.set(change.path, { path: change.path, ...change.before });
    }
  }
  const normalized = canonicalOverlayFiles([...files.values()]);
  return {
    files: normalized,
    treeDigest: createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
  };
};

/** Import provenance proves this app root was absent in the acquired platform base. */
export const applicationImportBaselineSnapshot = (
  snapshot: OverlaySnapshot,
  appRoot: string,
): OverlaySnapshot => {
  const files = canonicalOverlayFiles(
    snapshot.files.filter((file) => !file.path.startsWith(`${appRoot}/`)),
  );
  return { files, treeDigest: createHash("sha256").update(JSON.stringify(files)).digest("hex") };
};

// Existing-app review follows the selected app. Unrelated repository or
// planning-file edits must not invalidate a reviewed app change set.
export const reviewedOverlayTreeDigest = (
  snapshot: OverlaySnapshot,
  appId: string,
  existingApp: boolean,
  frameworkUpgrade = false,
): string => {
  if (!existingApp) {
    return snapshot.treeDigest;
  }
  const files = snapshot.files.filter(
    ({ path }) =>
      path.startsWith(`apps/${appId}/`) ||
      (frameworkUpgrade && frameworkSharedPaths.some((shared) => path === shared)),
  );
  return createHash("sha256")
    .update(JSON.stringify(canonicalOverlayFiles(files)))
    .digest("hex");
};

export interface OverlayChange {
  path: string;
  kind: "added" | "modified" | "deleted";
  before?: { mode: string; digest: string };
  after?: { mode: string; digest: string };
}

export interface ApplyCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  failedCommand?: string;
}

export type ApplyCommandExecutor = (input: {
  sandbox: SandboxSession;
  appId: string;
  applyRoot: string;
  proposal: TargetProposal;
}) => Promise<ApplyCommandResult>;

export interface TargetApplyBinding {
  sourceSha: string;
  sourceTree: string;
  sourceReceiptDigest: string;
  eligibilityDigest: string;
  workspaceDigest: string;
  appSpecDigest: string;
  appSpecPath: string;
  artifactRevision: string;
  dependencyReceiptDigest: string;
  identityDigest: string;
  imageDigest: string;
  dependencyCacheDigest: string;
  dependencyCacheContentDigest: string;
  proposalDigest: string;
}

type ApplyResultBase = TargetApplyBinding & {
  frameworkUpgrade?: FrameworkVersions;
  version: 2;
  applyRoot: string;
  planningTreeDigest: string;
  preparedTreeDigest: string;
  preTree: readonly OverlayFile[];
  preTreeDigest: string;
  command: {
    name: "create-app" | "iterate-existing-app";
    exitCode: number;
    stdoutDigest: string;
    stderrDigest: string;
  };
  appliedByCallId: string;
};

interface ObservedApplyResult {
  postTree: readonly OverlayFile[];
  postTreeDigest: string;
  changes: readonly OverlayChange[];
  changedContentDigest: string;
}

export type TargetApplyReceipt = ApplyResultBase &
  ObservedApplyResult & {
    status: "applied";
    targetReceipt: TargetApplyCommandReceipt;
    digest: string;
  };

export type TargetApplyFailureReceipt = ApplyResultBase &
  (
    | (ObservedApplyResult & {
        reason: ObservedApplyFailureReason;
      })
    | {
        reason: "post-snapshot-failed";
        postTree: null;
        postTreeDigest: null;
        changes: null;
        changedContentDigest: null;
      }
  ) & {
    status: "partial-failure";
    recoveryRequired: true;
    commandFailureKind?: CommandFailureKind;
    failedCommand?: string;
    output?: { stdout: string; stderr: string; truncated: boolean };
    missingDependency?: string;
    digest: string;
  };

type CommandFailureKind = z.infer<typeof commandFailureKindSchema>;
type ObservedApplyFailureReason =
  | "command-failed"
  | "output-limit"
  | "invalid-receipt"
  | "unexpected-path"
  | "missing-required-change";

export type TargetApplyResult =
  | { ok: true; receipt: TargetApplyReceipt }
  | { ok: false; receipt: TargetApplyFailureReceipt };

const areDigestsValid = (...digests: (string | undefined)[]): boolean =>
  digests.every((digest) => digestSchema.safeParse(digest).success);

export function assertCurrentTargetApplyReceipt(input: {
  version: number;
  appSpecPath?: string;
  appSpecDigest: string;
  preparedTreeDigest?: string;
}): asserts input is typeof input & {
  version: 2;
  appSpecPath: string;
  preparedTreeDigest: string;
} {
  if (
    input.version !== 2 ||
    input.appSpecPath === undefined ||
    !safeSourcePath(input.appSpecPath) ||
    !areDigestsValid(input.appSpecDigest, input.preparedTreeDigest)
  ) {
    throw new Error("A canonical V2 target apply receipt is required.");
  }
}

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

function commandFailureKind(stderr: string): TargetApplyFailureReceipt["commandFailureKind"] {
  if (/stale iteration preimage/iu.test(stderr)) {
    return staleProposalKind;
  }
  if (/timeout|timed out|aborted/iu.test(stderr)) {
    return "timeout";
  }
  if (/permission denied|eacces|eperm/iu.test(stderr)) {
    return "permission-denied";
  }
  if (/not found|enoent|command not found/iu.test(stderr)) {
    return "missing-command-or-file";
  }
  if (/dependency|lockfile|module|package|install/iu.test(stderr)) {
    return "dependency";
  }
  if (/validation|typecheck|lint|test failed|build failed/iu.test(stderr)) {
    return "validation";
  }
  if (/proposal is stale or noncanonical/iu.test(stderr)) {
    return staleProposalKind;
  }
  if (/proposal must have no blockers/iu.test(stderr)) {
    return "proposal-blocked";
  }
  if (/already exists/iu.test(stderr)) {
    return "app-already-exists";
  }
  if (/create-app lock|already running/iu.test(stderr)) {
    return "app-lock";
  }
  if (/partial state|recovery/iu.test(stderr)) {
    return "partial-state";
  }
  if (/projected config|projected repository|unsupported entry/iu.test(stderr)) {
    return "projected-repository";
  }
  if (/mise|task|proposal|create:app|already exists|failed|error/iu.test(stderr)) {
    return "repository-task";
  }
  if (stderr.trim() === "") {
    return "empty-output";
  }
  return "unknown";
}

function missingDependency(output: string): string | undefined {
  const match =
    /(?:Cannot find (?:package|module)|Module not found[^:]*:)\s*["']?(?<dependency>@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?)/iu.exec(
      output,
    );
  return match?.[1];
}

export function applyOverlayRoot(proposalDigest: string): string {
  if (!digestSchema.safeParse(proposalDigest).success) {
    throw new Error("The target proposal digest is invalid.");
  }
  return `.app-builder/apply/${proposalDigest}/repository`;
}

export async function materializeFreshApplyOverlay(input: {
  sandbox: SandboxSession;
  artifactRevision: string;
  dependencyLayout?: ExecutionDependencyLayout;
  proposalDigest: string;
  proposal: TargetProposal;
  environment?: Readonly<Record<string, string | undefined>>;
}): Promise<{
  applyRoot: string;
  appSpecPath: string;
  acceptedAppSpec: Uint8Array;
}> {
  const relativeRoot = applyOverlayRoot(input.proposalDigest);
  const parent = relativeRoot.slice(0, relativeRoot.lastIndexOf("/"));
  await ensureSandboxDirectories(input.sandbox, [parent]);
  const planningRoot = `/workspace/${planningOverlayRoot(input.artifactRevision)}`;
  try {
    const appSpecPath = input.proposal.contract.appSpec.path;
    const acceptedAppSpec = await input.sandbox.readBinaryFile({
      path: `${planningRoot.replace(workspacePrefix, "")}/${appSpecPath}`,
    });
    if (
      acceptedAppSpec === null ||
      sha256(acceptedAppSpec) !== input.proposal.contract.appSpec.sha256
    ) {
      throw new Error("The planning overlay does not contain the exact accepted AppSpec.");
    }
    return {
      acceptedAppSpec,
      appSpecPath,
      applyRoot: appRootPath,
    };
  } catch (error) {
    await input.sandbox.removePath({
      force: true,
      path: relativeRoot,
      recursive: true,
    });
    throw error;
  }
}

type FreshApplyOverlay = Awaited<ReturnType<typeof materializeFreshApplyOverlay>>;

const snapshotLine = /^(?<mode>[0-7]{3,4})\t(?<digest>[0-9a-f]{64})\t(?<path>.+)$/u;

export const OVERLAY_SNAPSHOT_SCRIPT = String.raw`
const { createHash } = require("node:crypto");
const { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } = require("node:fs");
const { join } = require("node:path");

const strict = typeof expectedOverlayRoot !== "undefined";
if (strict && realpathSync(".") !== expectedOverlayRoot) throw Error("Applied overlay root changed.");
const files = [];
const visit = (directory, relativeDirectory) => {
  if (strict && realpathSync(directory) !== join(expectedOverlayRoot, relativeDirectory)) throw Error("Applied overlay directory changed.");
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = relativeDirectory
      ? relativeDirectory + "/" + entry.name
      : entry.name;
    // Tooling state can appear anywhere in a prepared repository. None of it
    // belongs in a source review or a published change set.
    if (
      (entry.isDirectory() || (strict && entry.isSymbolicLink())) &&
      [".git", ".scratch", ".next", ".turbo", "node_modules", "dist", "coverage", "storybook-static", "target", "test-results", "playwright-report", "blob-report"].includes(entry.name)
    ) continue;
    if (entry.isFile() && entry.name === "next-env.d.ts") continue;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(absolutePath, relativePath);
      continue;
    }
    if (!entry.isFile()) {
      if (strict) throw Error("Applied overlay contains an unsupported source entry.");
      continue;
    }
    const descriptor = strict
      ? openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      : undefined;
    try {
      const stat = strict ? fstatSync(descriptor) : lstatSync(absolutePath);
      if (strict && (!stat.isFile() || realpathSync(absolutePath) !== join(expectedOverlayRoot, relativePath))) throw Error("Applied overlay source changed.");
      // The exact-root private preview reads paths and bytes. Keep the wire shape
      // shared with the apply snapshot without making permissions part of that read.
      const mode = strict ? "000" : (stat.mode & 0o7777).toString(8);
      const fileDigest = createHash("sha256")
        .update(readFileSync(descriptor ?? absolutePath))
        .digest("hex");
      if (strict) {
        const current = lstatSync(absolutePath);
        if (current.dev !== stat.dev || current.ino !== stat.ino) throw Error("Applied overlay source changed.");
      }
      files.push({ path: relativePath, mode, digest: fileDigest });
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
};

visit(".", "");
files.sort((left, right) =>
  Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
);
for (const file of files)
  process.stdout.write(file.mode + "\t" + file.digest + "\t" + file.path + "\n");
`;

export function overlaySnapshotCommand(exactRoot?: "/workspace/repository"): string {
  const script =
    exactRoot === undefined
      ? OVERLAY_SNAPSHOT_SCRIPT
      : `const expectedOverlayRoot = ${JSON.stringify(exactRoot)};\n${OVERLAY_SNAPSHOT_SCRIPT}`;
  if (script.includes("'")) {
    throw new Error("The overlay snapshot script is not shell-safe.");
  }
  return `bun -e '${script}'`;
}

const snapshotFailureDetail = (value: string): string =>
  value
    .replaceAll(/\p{Cc}/gu, (character) =>
      character === "\n" || character === "\t" ? character : "",
    )
    .replaceAll(/Bearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replaceAll(
      /\b(?<key>authorization|cookie|password|passwd|secret|token|api[-_]?key)\s*[:=]\s*[^\s,;]+/giu,
      "$<key>=[REDACTED]",
    )
    .replaceAll(
      /\b(?:gh[oprsu]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/gu,
      "[REDACTED]",
    )
    .trim();

export async function inspectApplyOverlay(
  sandbox: {
    run: (input: { command: string; workingDirectory: string }) => PromiseLike<ApplyCommandResult>;
  },
  applyRoot: string,
  exactRoot?: "/workspace/repository",
): Promise<OverlaySnapshot> {
  let result: ApplyCommandResult;
  try {
    result = await sandbox.run({
      command: overlaySnapshotCommand(exactRoot),
      workingDirectory: applyRoot,
    });
  } catch (error) {
    const cause = snapshotFailureDetail(error instanceof Error ? error.message : String(error));
    throw new Error(
      `Builder could not run the source snapshot in ${applyRoot}. Cause: ${cause || "The sandbox returned no cause"}. Check that the checkout and Bun runtime are available, then retry.`,
      { cause: error },
    );
  }
  if (result.exitCode !== 0) {
    const cause = snapshotFailureDetail(`${result.stderr}\n${result.stdout}`);
    throw new Error(
      `Builder's source snapshot failed in ${applyRoot} with exit ${result.exitCode}. Cause: ${cause || "The command returned no output"}. Check the checkout, file permissions, and Bun runtime, then retry.`,
    );
  }
  const files = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = snapshotLine.exec(line);
      if (
        match?.[1] === undefined ||
        match[2] === undefined ||
        match[3] === undefined ||
        !safeSourcePath(match[3])
      ) {
        throw new Error("The proposal apply overlay returned an invalid path receipt.");
      }
      return {
        digest: match[2],
        mode: match[1],
        path: match[3],
      };
    });
  const normalized = canonicalOverlayFiles(files);
  if (new Set(normalized.map(({ path }) => path)).size !== normalized.length) {
    throw new Error("The proposal apply overlay returned duplicate paths.");
  }
  return { files: normalized, treeDigest: sha256(JSON.stringify(normalized)) };
}

export async function inspectFixtureApplyOverlay(
  sandbox: SandboxSession,
  applyRoot: string,
  appId: string,
): Promise<OverlaySnapshot> {
  const sourceManifest = await sandbox.readTextFile({
    path: ".app-builder/source-files.json",
  });
  if (sourceManifest === null) {
    throw new Error("The prepared workspace manifest is missing.");
  }
  // SAFETY: JSON.parse returns unknown; the schema validates every path and optional mode before use.
  const sourceManifestValue: unknown = JSON.parse(sourceManifest);
  const sourceFilesResult = preparedSourceManifestSchema.safeParse(sourceManifestValue);
  if (!sourceFilesResult.success) {
    throw new Error(invalidManifestMessage);
  }
  const sourceFiles = sourceFilesResult.data.map(({ path, mode }) => ({
    mode: mode === "100755" ? "755" : "644",
    path,
  }));
  const candidates = [
    ...sourceFiles,
    { mode: "644", path: `prototype/${appId}/app-spec.md` },
    { mode: "644", path: `.config/app-specs/${appId}.md` },
    { mode: "644", path: `.config/app-specs/${appId}.cue` },
    { mode: "644", path: `apps/${appId}/.config/app-spec.md` },
    { mode: "644", path: `apps/${appId}/schema/${appId}.cue` },
    { mode: "644", path: `apps/${appId}/app/page.tsx` },
    { mode: "644", path: `apps/${appId}/package.json` },
  ];
  const relativeRoot = applyRoot.replace(workspacePrefix, "");
  const candidateFiles = await Promise.all(
    candidates.map(async ({ path, mode }) => {
      const content = await sandbox.readBinaryFile({
        path: `${relativeRoot}/${path}`,
      });
      return { content, mode, path };
    }),
  );
  const files = candidateFiles
    .filter(({ content }) => content !== null)
    .map(({ content, mode, path }) => ({ digest: sha256(content), mode, path }));
  const normalized = canonicalOverlayFiles(files);
  return {
    files: normalized,
    treeDigest: sha256(JSON.stringify(normalized)),
  };
}

export function overlayChanges(before: OverlaySnapshot, after: OverlaySnapshot): OverlayChange[] {
  const beforeFiles = new Map(before.files.map((file) => [file.path, file]));
  const afterFiles = new Map(after.files.map((file) => [file.path, file]));
  return [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])]
    .toSorted(compareOverlayPaths)
    .flatMap((path): OverlayChange[] => {
      const previous = beforeFiles.get(path);
      const current = afterFiles.get(path);
      if (previous === undefined && current !== undefined) {
        return [
          {
            after: { digest: current.digest, mode: current.mode },
            kind: "added",
            path,
          },
        ];
      }
      if (previous !== undefined && current === undefined) {
        return [
          {
            before: { digest: previous.digest, mode: previous.mode },
            kind: "deleted",
            path,
          },
        ];
      }
      if (
        previous !== undefined &&
        current !== undefined &&
        (previous.mode !== current.mode || previous.digest !== current.digest)
      ) {
        return [
          {
            after: { digest: current.digest, mode: current.mode },
            before: { digest: previous.digest, mode: previous.mode },
            kind: "modified",
            path,
          },
        ];
      }
      return [];
    });
}

const digestMatches = (expected: string | undefined, actual: string): boolean =>
  expected === undefined || expected === actual;

const receiptMatchesProposal = (
  receipt: TargetApplyCommandReceipt,
  proposal: TargetProposal,
): boolean => {
  const { topology } = proposal.plan;
  const identityMatches =
    receipt.appId === proposal.contract.appId &&
    receipt.workspacePath === proposal.plan.source.workspacePath &&
    receipt.mutations[0] === proposal.plan.source.workspacePath;
  const topologyMatches =
    receipt.topology.path === topology.configPath &&
    digestMatches(topology.currentDigest, receipt.topology.oldDigest) &&
    digestMatches(topology.proposedDigest, receipt.topology.newDigest);
  return identityMatches && topologyMatches;
};

function parseTargetReceipt(
  result: ApplyCommandResult,
  proposal: TargetProposal,
): TargetApplyCommandReceipt | undefined {
  if (result.exitCode !== 0) {
    return undefined;
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
  const parsed = targetApplyCommandReceiptSchema.safeParse(candidate);
  if (!parsed.success) {
    return undefined;
  }
  const receipt = parsed.data;
  if (!receiptMatchesProposal(receipt, proposal)) {
    return undefined;
  }
  return receipt;
}

/** Persist the accepted product snapshot only as an output of successful new-app creation. */
const stageCreatedAppSpec = async (input: {
  sandbox: SandboxSession;
  applyRoot: string;
  proposal: TargetProposal;
  acceptedAppSpec: Uint8Array;
  command: ApplyCommandResult;
}): Promise<void> => {
  if (
    "operation" in input.proposal ||
    input.command.exitCode !== 0 ||
    parseTargetReceipt(input.command, input.proposal) === undefined
  ) {
    return;
  }
  const relativeRoot = input.applyRoot.replace(workspacePrefix, "");
  const directory = `${relativeRoot}/apps/${input.proposal.contract.appId}/.config`;
  await ensureSandboxDirectories(input.sandbox, [directory]);
  await input.sandbox.writeBinaryFile({
    content: input.acceptedAppSpec,
    path: `${directory}/app-spec.md`,
  });
};

const isStaleIterationChange = (
  change: TargetIterationChange,
  current: Uint8Array | null,
): boolean => {
  const currentDigest = current === null ? null : sha256(current);
  const beforeMatches =
    change.before === undefined ? current === null : currentDigest === change.before.digest;
  const afterMatches = change.after !== undefined && currentDigest === change.after.digest;
  const contentMatches =
    change.after === undefined || change.after.digest === sha256(change.after.content);
  return !(beforeMatches || afterMatches) || !contentMatches;
};

const applyIterationChange = async (
  sandbox: SandboxSession,
  relativeRoot: string,
  change: TargetIterationChange,
): Promise<void> => {
  const path = `${relativeRoot}/${change.path}`;
  if (change.after === undefined) {
    await sandbox.removePath({ force: true, path });
    return;
  }
  await sandbox.writeTextFile({ content: change.after.content, path });
};

const applyIterationProposal = async (
  sandbox: SandboxSession,
  applyRoot: string,
  proposal: TargetProposal,
): Promise<ApplyCommandResult | undefined> => {
  if (!("operation" in proposal)) {
    return undefined;
  }
  const relativeRoot = applyRoot.replace(workspacePrefix, "");
  const currentFiles = await Promise.all(
    proposal.iteration.changes.map(async (change) => ({
      change,
      content: await sandbox.readBinaryFile({ path: `${relativeRoot}/${change.path}` }),
    })),
  );
  if (currentFiles.some(({ change, content }) => isStaleIterationChange(change, content))) {
    return {
      exitCode: 2,
      failedCommand: "verify current app file preimage",
      stderr: "stale iteration preimage",
      stdout: "",
    };
  }
  await Promise.all(
    proposal.iteration.changes.map(async (change) => {
      await applyIterationChange(sandbox, relativeRoot, change);
    }),
  );
  return undefined;
};

const applyImportedRegistration = async (
  sandbox: SandboxSession,
  appId: string,
  applyRoot: string,
  proposal: TargetProposal,
): Promise<ApplyCommandResult | undefined> => {
  if (!("operation" in proposal) || proposal.applicationSourceImport === undefined) {
    return undefined;
  }
  const { registration } = proposal.applicationSourceImport;
  if (
    registration === undefined ||
    registration.projectName !== appId ||
    sha256(registration.proposedBytes) !== registration.newDigest
  ) {
    return {
      exitCode: 2,
      failedCommand: "verify approved application registration",
      stderr: "Imported app registration is missing from the approved proposal.",
      stdout: "",
    };
  }
  const topologyPath = `${applyRoot.replace(workspacePrefix, "")}/microfrontends.json`;
  const currentTopology = await sandbox.readTextFile({ path: topologyPath });
  if (
    currentTopology === null ||
    ![registration.oldDigest, registration.newDigest].includes(sha256(currentTopology))
  ) {
    return {
      exitCode: 2,
      failedCommand: "verify approved application registration",
      stderr: "Imported app registration preimage changed.",
      stdout: "",
    };
  }
  await sandbox.writeTextFile({ content: registration.proposedBytes, path: topologyPath });
  return undefined;
};

const repositoryInstallFailureReason = (output: string): string => {
  if (/lockfile had changes|frozen lockfile/iu.test(output)) {
    return "frozen-lockfile";
  }
  if (/ENOSPC|no space left/iu.test(output)) {
    return "disk-space";
  }
  if (/EACCES|permission denied/iu.test(output)) {
    return "permissions";
  }
  if (/timed? out|timeout/iu.test(output)) {
    return "network-timeout";
  }
  if (/failed to resolve|package not found|module not found/iu.test(output)) {
    return "package-resolution";
  }
  if (/fetch|connection|certificate|network/iu.test(output)) {
    return "network";
  }
  return "unclassified";
};

const installRepositoryDependencies = async (
  sandbox: SandboxSession,
  applyRoot: string,
  appId: string,
  proposal: TargetProposal,
): Promise<ApplyCommandResult | undefined> => {
  await setBuilderSandboxNetworkPolicy(sandbox, "allow-all");
  if (proposal.frameworkUpgrade !== undefined) {
    const upgradeCommand = frameworkUpgradeCommand(proposal.frameworkUpgrade, appId);
    const upgraded = await sandbox.run({ command: upgradeCommand, workingDirectory: applyRoot });
    if (upgraded.exitCode !== 0) {
      return { ...upgraded, failedCommand: upgradeCommand };
    }
  }

  const installCommand =
    proposal.frameworkUpgrade === undefined ? "bun install" : "bun install --frozen-lockfile";
  const install = await sandbox.run({
    command: workspaceBinInstallCommand(applyRoot, proposal.frameworkUpgrade !== undefined),
    workingDirectory: applyRoot,
  });
  if (install.exitCode !== 0) {
    const output = `${install.stderr}\n${install.stdout}`;
    const reason = repositoryInstallFailureReason(output);
    console.error("[app-builder apply] repository install failed", {
      exitCode: install.exitCode,
      reason,
    });
    return { ...install, failedCommand: installCommand };
  }

  const cueCommand = sourceDeclaredToolchainActivationCommand();
  const cue = await sandbox.run({ command: cueCommand, workingDirectory: applyRoot });
  return cue.exitCode === 0 ? undefined : { ...cue, failedCommand: cueCommand };
};

const logRepositoryGeneratorFailure = (generated: ApplyCommandResult): void => {
  const output = `${generated.stderr}\n${generated.stdout}`;
  let reason = "unclassified";
  if (/EACCES|permission denied/iu.test(output)) {
    reason = "permissions";
  } else if (/cannot find module|module_not_found|failed to resolve/iu.test(output)) {
    reason = "module-resolution";
  } else if (/timed? out|timeout/iu.test(output)) {
    reason = "timeout";
  } else if (/network|fetch|connection|certificate/iu.test(output)) {
    reason = "network";
  } else if (/format/iu.test(output)) {
    reason = "formatting";
  } else if (/lifecycle|validation|test|build/iu.test(output)) {
    reason = "generated-app-validation";
  }
  console.error("[app-builder apply] repository generator failed", {
    exitCode: generated.exitCode,
    reason,
  });
};

export const sandboxApplyCommandExecutor =
  (): ApplyCommandExecutor =>
  async ({ sandbox, appId, applyRoot, proposal }) => {
    const iterationResult = await applyIterationProposal(sandbox, applyRoot, proposal);
    if (iterationResult !== undefined) {
      return iterationResult;
    }
    const registrationResult = await applyImportedRegistration(sandbox, appId, applyRoot, proposal);
    if (registrationResult !== undefined) {
      return registrationResult;
    }
    // The writable checkout is the execution environment. Prepared dependency
    // roots are only a cache optimization; a checkout-backed flow can have no
    // roots at all. Let Bun establish the repository's actual dependency state
    // after iteration writes or before invoking its generator, and treat Bun's
    // real result as authority. Failed installs retain partial-apply evidence.
    const installResult = await installRepositoryDependencies(sandbox, applyRoot, appId, proposal);
    if (installResult !== undefined) {
      return installResult;
    }
    if ("operation" in proposal) {
      const oldDigest =
        proposal.applicationSourceImport?.registration?.oldDigest ??
        proposal.plan.topology.currentDigest ??
        "0".repeat(64);
      const receipt: TargetApplyCommandReceipt = {
        appId: proposal.contract.appId,
        mutations: [proposal.plan.source.workspacePath, iterationReceiptMutation],
        omittedAuthorities: omittedApplyAuthorities,
        recovered: false,
        topology: {
          newDigest:
            proposal.applicationSourceImport?.registration?.newDigest ??
            proposal.plan.topology.proposedDigest ??
            oldDigest,
          oldDigest,
          path: iterationReceiptMutation,
        },
        version: 1,
        workspacePath: proposal.plan.source.workspacePath,
      };
      return { exitCode: 0, stderr: "", stdout: JSON.stringify(receipt) };
    }
    const generated = await sandbox.run({
      command: `mise run create:app ${appId}`,
      workingDirectory: applyRoot,
    });
    if (generated.exitCode !== 0) {
      logRepositoryGeneratorFailure(generated);
    }
    return generated.exitCode === 0
      ? generated
      : { ...generated, failedCommand: `mise run create:app ${appId}` };
  };

export const fixtureApplyCommandExecutor =
  (): ApplyCommandExecutor =>
  async ({ sandbox, appId, applyRoot, proposal }) => {
    const relativeRoot = applyRoot.replace(workspacePrefix, "");
    if ("operation" in proposal) {
      await Promise.all(
        proposal.iteration.changes.map(async (change) => {
          await applyIterationChange(sandbox, relativeRoot, change);
        }),
      );
      const oldDigest = proposal.plan.topology.currentDigest ?? "0".repeat(64);
      const receipt: TargetApplyCommandReceipt = {
        appId,
        mutations: [proposal.plan.source.workspacePath, iterationReceiptMutation],
        omittedAuthorities: omittedApplyAuthorities,
        recovered: false,
        topology: {
          newDigest: proposal.plan.topology.proposedDigest ?? oldDigest,
          oldDigest,
          path: iterationReceiptMutation,
        },
        version: 1,
        workspacePath: proposal.plan.source.workspacePath,
      };
      return { exitCode: 0, stderr: "", stdout: JSON.stringify(receipt) };
    }
    await ensureSandboxDirectories(sandbox, [
      `${relativeRoot}/apps/${appId}`,
      `${relativeRoot}/apps/${appId}/app`,
      `${relativeRoot}/apps/${appId}/.config`,
      `${relativeRoot}/apps/shell`,
    ]);
    await sandbox.writeTextFile({
      content:
        (await sandbox.readTextFile({ path: `${relativeRoot}/.config/app-specs/${appId}.md` })) ??
        "",
      path: `${relativeRoot}/apps/${appId}/.config/app-spec.md`,
    });
    await sandbox.writeTextFile({
      content: `${JSON.stringify({ name: packageNamePrefix + appId }, null, 2)}\n`,
      path: `${relativeRoot}/apps/${appId}/package.json`,
    });
    await sandbox.writeTextFile({
      content:
        'import { Button, KpiCard, PageHeader } from "@autograph/components";\nimport { Check } from "@autograph/icons";\nimport "@autograph/design-system/tokens.css";\n\nexport default function Page() {\n  return <><PageHeader title="Vendor Review" /><KpiCard icon={Check} title="Ready" value={3} /><Button>Start Guided Review</Button></>;\n}\n',
      path: `${relativeRoot}/apps/${appId}/app/page.tsx`,
    });
    await sandbox.writeTextFile({
      content: `${JSON.stringify({ applications: [appId] }, null, 2)}\n`,
      path: `${relativeRoot}/microfrontends.json`,
    });
    if (appId === "apply-failure") {
      return { exitCode: 1, stderr: "fixture apply failure", stdout: "" };
    }
    const oldDigest = proposal.plan.topology.currentDigest ?? "0".repeat(64);
    const newDigest = proposal.plan.topology.proposedDigest ?? "1".repeat(64);
    const receipt: TargetApplyCommandReceipt = {
      appId,
      mutations: [proposal.plan.source.workspacePath, iterationReceiptMutation],
      omittedAuthorities: omittedApplyAuthorities,
      recovered: false,
      topology: {
        newDigest,
        oldDigest,
        path: iterationReceiptMutation,
      },
      version: 1,
      workspacePath: proposal.plan.source.workspacePath,
    };
    return { exitCode: 0, stderr: "", stdout: JSON.stringify(receipt) };
  };

const appSpecBindingMatches = (binding: TargetApplyBinding, proposal: TargetProposal): boolean =>
  binding.appSpecDigest === proposal.contract.appSpec.sha256 &&
  binding.appSpecPath === proposal.contract.appSpec.path &&
  safeSourcePath(binding.appSpecPath);

const installDependencyCache = async (
  sandbox: SandboxSession,
  dependencyLayout: ExecutionDependencyLayout,
): Promise<void> => {
  try {
    await Promise.all(
      dependencyLayout.roots.map(async (root) => {
        const target = `repository/${root.path}`;
        await sandbox.removePath({ force: true, path: target, recursive: true });
        const linked = await sandbox.run({
          command: `ln -s ${root.cachePath} ${root.path}`,
          workingDirectory: appRootPath,
        });
        if (linked.exitCode !== 0) {
          throw new Error("dependency cache miss");
        }
      }),
    );
  } catch {
    // The repository install below remains authoritative. A missing or stale
    // cache is an optimization miss, not a reason to block the build.
  }
};

interface ApplySnapshots {
  planning: OverlaySnapshot;
  prepared: OverlaySnapshot;
  before: OverlaySnapshot;
}

const captureApplySnapshots = async (
  sandbox: SandboxSession,
  proposalDigest: string,
  proposal: TargetProposal,
  overlay: FreshApplyOverlay,
  snapshotter: (sandbox: SandboxSession, applyRoot: string) => Promise<OverlaySnapshot>,
): Promise<ApplySnapshots> => {
  try {
    const [planning, prepared, initialBefore] = await Promise.all([
      snapshotter(sandbox, overlay.applyRoot),
      snapshotter(sandbox, "/workspace/repository"),
      snapshotter(sandbox, overlay.applyRoot),
    ]);
    let before = initialBefore;
    if ("operation" in proposal) {
      before = iterationBaselineSnapshot(before, proposal.iteration.changes);
      if (proposal.applicationSourceImport !== undefined) {
        before = applicationImportBaselineSnapshot(
          before,
          `apps/${proposal.applicationSourceImport.appId}`,
        );
      }
    }
    if (proposal.frameworkUpgrade !== undefined) {
      before = iterationBaselineSnapshot(before, proposal.frameworkUpgrade.baseline);
    }
    return { before, planning, prepared };
  } catch (error) {
    await sandbox.removePath({
      force: true,
      path: applyOverlayRoot(proposalDigest),
      recursive: true,
    });
    throw error;
  }
};

const executeApplyCommand = async (
  input: {
    sandbox: SandboxSession;
    executor: ApplyCommandExecutor;
    proposal: TargetProposal;
    binding: TargetApplyBinding;
    appliedByCallId: string;
  },
  overlay: FreshApplyOverlay,
): Promise<ApplyCommandResult> => {
  try {
    const command = await input.executor({
      appId: input.proposal.contract.appId,
      applyRoot: overlay.applyRoot,
      proposal: input.proposal,
      sandbox: input.sandbox,
    });
    if (command.exitCode === 0 && input.proposal.privateCompute !== undefined) {
      await applyPrivateComputeCheckPolicy({
        applyRoot: overlay.applyRoot,
        profile: input.proposal.privateCompute,
        sandbox: input.sandbox,
      });
    }
    await stageCreatedAppSpec({
      acceptedAppSpec: overlay.acceptedAppSpec,
      applyRoot: overlay.applyRoot,
      command,
      proposal: input.proposal,
      sandbox: input.sandbox,
    });
    return command;
  } catch (error) {
    return {
      exitCode: -1,
      failedCommand: "target apply executor",
      stderr: error instanceof Error ? `${error.name}: ${error.message}` : "TargetApplyError",
      stdout: "",
    };
  }
};

const executeAndCaptureAfter = async (
  input: {
    sandbox: SandboxSession;
    executor: ApplyCommandExecutor;
    proposal: TargetProposal;
    binding: TargetApplyBinding;
    appliedByCallId: string;
  },
  overlay: FreshApplyOverlay,
  snapshotter: (sandbox: SandboxSession, applyRoot: string) => Promise<OverlaySnapshot>,
): Promise<{ command: ApplyCommandResult; after: OverlaySnapshot | null }> => {
  const command = await executeApplyCommand(input, overlay);
  return await snapshotter(input.sandbox, overlay.applyRoot)
    .then((after) => ({ after, command }))
    .catch(() => ({ after: null, command }));
};

const postSnapshotFailure = (
  input: {
    binding: TargetApplyBinding;
    proposal: TargetProposal;
    appliedByCallId: string;
  },
  overlay: FreshApplyOverlay,
  snapshots: ApplySnapshots,
  command: ApplyCommandResult,
): TargetApplyResult => {
  const { before, planning, prepared } = snapshots;
  const unsigned = {
    ...input.binding,
    appliedByCallId: input.appliedByCallId,
    applyRoot: overlay.applyRoot,
    command: {
      exitCode: command.exitCode,
      name: "operation" in input.proposal ? "iterate-existing-app" : "create-app",
      stderrDigest: sha256(command.stderr),
      stdoutDigest: sha256(command.stdout),
    },
    planningTreeDigest: planning.treeDigest,
    preTree: before.files,
    preTreeDigest: before.treeDigest,
    preparedTreeDigest: prepared.treeDigest,
    ...(input.proposal.frameworkUpgrade === undefined
      ? {}
      : { frameworkUpgrade: input.proposal.frameworkUpgrade.versions }),
    version: 2 as const,
    changedContentDigest: null,
    changes: null,
    postTree: null,
    postTreeDigest: null,
    reason: "post-snapshot-failed" as const,
    recoveryRequired: true as const,
    status: "partial-failure" as const,
  };
  return { ok: false, receipt: { ...unsigned, digest: sha256(JSON.stringify(unsigned)) } };
};

const createApplyResult = (
  input: {
    binding: TargetApplyBinding;
    proposal: TargetProposal;
    appliedByCallId: string;
  },
  overlay: FreshApplyOverlay,
  snapshots: ApplySnapshots,
  command: ApplyCommandResult,
  after: OverlaySnapshot,
): TargetApplyResult => {
  const { before, planning, prepared } = snapshots;
  const attemptBase: ApplyResultBase = {
    ...input.binding,
    appliedByCallId: input.appliedByCallId,
    applyRoot: overlay.applyRoot,
    command: {
      exitCode: command.exitCode,
      name: "operation" in input.proposal ? "iterate-existing-app" : "create-app",
      stderrDigest: sha256(command.stderr),
      stdoutDigest: sha256(command.stdout),
    },
    planningTreeDigest: planning.treeDigest,
    preTree: before.files,
    preTreeDigest: before.treeDigest,
    preparedTreeDigest: prepared.treeDigest,
    version: 2,
  };
  if (input.proposal.frameworkUpgrade !== undefined) {
    attemptBase.frameworkUpgrade = input.proposal.frameworkUpgrade.versions;
  }
  const changes = overlayChanges(before, after);
  const targetReceipt = parseTargetReceipt(command, input.proposal);
  const base = {
    ...attemptBase,
    changedContentDigest: sha256(JSON.stringify(changes)),
    changes,
    postTree: after.files,
    postTreeDigest: after.treeDigest,
  };
  if (command.exitCode !== 0 || targetReceipt === undefined) {
    const commandOutput = `${command.stderr}\n${command.stdout}`;
    const output = validationOutputExcerpt(command.stdout, command.stderr);
    const unsigned: ApplyResultBase &
      ObservedApplyResult & {
        commandFailureKind: CommandFailureKind;
        reason: "invalid-receipt" | "command-failed";
        recoveryRequired: true;
        status: "partial-failure";
        failedCommand?: string;
        output?: { stdout: string; stderr: string; truncated: boolean };
        missingDependency?: string;
      } = {
      ...base,
      commandFailureKind: commandFailureKind(commandOutput),
      reason: command.exitCode === 0 ? "invalid-receipt" : "command-failed",
      recoveryRequired: true,
      status: "partial-failure",
    };
    if (command.failedCommand !== undefined) {
      unsigned.failedCommand = command.failedCommand;
    }
    if (output.stderr !== "" || output.stdout !== "") {
      unsigned.output = output;
    }
    const dependency = missingDependency(commandOutput);
    if (dependency !== undefined) {
      unsigned.missingDependency = dependency;
    }
    return {
      ok: false,
      receipt: { ...unsigned, digest: sha256(JSON.stringify(unsigned)) },
    };
  }
  const unsigned = { ...base, status: "applied" as const, targetReceipt };
  return { ok: true, receipt: { ...unsigned, digest: sha256(JSON.stringify(unsigned)) } };
};

export const executeProposalBoundApply = async (input: {
  sandbox: SandboxSession;
  executor: ApplyCommandExecutor;
  snapshotter?: (sandbox: SandboxSession, applyRoot: string) => Promise<OverlaySnapshot>;
  binding: TargetApplyBinding;
  artifactRevision: string;
  dependencyLayout?: ExecutionDependencyLayout;
  proposal: TargetProposal;
  appliedByCallId: string;
  environment?: Readonly<Record<string, string | undefined>>;
}): Promise<TargetApplyResult> => {
  if (!appSpecBindingMatches(input.binding, input.proposal)) {
    throw new Error("The accepted AppSpec binding or path differs from the target proposal.");
  }
  const snapshotter = input.snapshotter ?? inspectApplyOverlay;
  const overlay = await materializeFreshApplyOverlay({
    artifactRevision: input.artifactRevision,
    dependencyLayout: input.dependencyLayout,
    environment: input.environment,
    proposal: input.proposal,
    proposalDigest: input.binding.proposalDigest,
    sandbox: input.sandbox,
  });
  if (input.dependencyLayout !== undefined) {
    await installDependencyCache(input.sandbox, input.dependencyLayout);
  }
  const snapshots = await captureApplySnapshots(
    input.sandbox,
    input.binding.proposalDigest,
    input.proposal,
    overlay,
    snapshotter,
  );
  const command = await executeApplyCommand(input, overlay);
  let after: OverlaySnapshot;
  try {
    after = await snapshotter(input.sandbox, overlay.applyRoot);
  } catch {
    const { before, planning, prepared } = snapshots;
    const attemptBase: ApplyResultBase = {
      ...input.binding,
      appliedByCallId: input.appliedByCallId,
      applyRoot: overlay.applyRoot,
      command: {
        exitCode: command.exitCode,
        name: "operation" in input.proposal ? "iterate-existing-app" : "create-app",
        stderrDigest: sha256(command.stderr),
        stdoutDigest: sha256(command.stdout),
      },
      planningTreeDigest: planning.treeDigest,
      preTree: before.files,
      preTreeDigest: before.treeDigest,
      preparedTreeDigest: prepared.treeDigest,
      version: 2,
    };
    const unsigned = {
      ...attemptBase,
      changedContentDigest: null,
      changes: null,
      postTree: null,
      postTreeDigest: null,
      reason: "post-snapshot-failed" as const,
      recoveryRequired: true as const,
      status: "partial-failure" as const,
    };
    return {
      ok: false,
      receipt: { ...unsigned, digest: sha256(JSON.stringify(unsigned)) },
    };
  }
  return createApplyResult(input, overlay, snapshots, command, after);
};
