import { createHash } from "node:crypto";

import { z } from "zod";

import type { SandboxSession } from "eve/sandbox";
import { hasTestCapability } from "../testing/test-capability";

import { ensureSandboxDirectories } from "./sandbox-filesystem";
import { safeSourcePath } from "./source-path";
import {
  materializeExecutionDependencyView,
  planningOverlayRoot,
  type ExecutionDependencyLayout,
} from "./dependency-cache";
import type { TargetProposal } from "./target-planning";

const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const repositoryPath = z
  .string()
  .refine(safeSourcePath, "path must remain inside the apply overlay");

export const TARGET_APPLY_TIMEOUT_MS = 300_000;
export const TARGET_APPLY_OUTPUT_BYTES = 1_048_576;

export const targetApplyCommandReceiptSchema = z.strictObject({
  version: z.literal(1),
  appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  contractPath: repositoryPath,
  workspacePath: repositoryPath,
  topology: z.strictObject({
    path: z.literal("microfrontends.json"),
    oldDigest: digest,
    newDigest: digest,
  }),
  mutations: z.tuple([repositoryPath, z.literal("microfrontends.json")]),
  recovered: z.boolean(),
  omittedAuthorities: z.tuple([
    z.literal("provider-provisioning"),
    z.literal("deployment"),
    z.literal("production-readiness"),
  ]),
});

export type TargetApplyCommandReceipt = z.infer<
  typeof targetApplyCommandReceiptSchema
>;

export type OverlayFile = {
  path: string;
  mode: string;
  digest: string;
};

export type OverlaySnapshot = {
  treeDigest: string;
  files: readonly OverlayFile[];
};

export function compareOverlayPaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function canonicalOverlayFiles(
  files: readonly OverlayFile[],
): OverlayFile[] {
  return files
    .map(({ path, mode, digest }) => ({ path, mode, digest }))
    .toSorted((left, right) => compareOverlayPaths(left.path, right.path));
}

export type OverlayChange = {
  path: string;
  kind: "added" | "modified" | "deleted";
  before?: { mode: string; digest: string };
  after?: { mode: string; digest: string };
};

export type ApplyCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ApplyCommandExecutor = (input: {
  sandbox: SandboxSession;
  appId: string;
  applyRoot: string;
  proposalPath: string;
  proposal: TargetProposal;
}) => Promise<ApplyCommandResult>;

export type TargetApplyBinding = {
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
};

type ApplyResultBase = TargetApplyBinding & {
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

type ObservedApplyResult = {
  postTree: readonly OverlayFile[];
  postTreeDigest: string;
  changes: readonly OverlayChange[];
  changedContentDigest: string;
};

export type TargetApplyReceipt = ApplyResultBase &
  ObservedApplyResult & {
    status: "applied";
    targetReceipt: TargetApplyCommandReceipt;
    digest: string;
  };

export type TargetApplyFailureReceipt = ApplyResultBase &
  (
    | (ObservedApplyResult & {
        reason:
          | "command-failed"
          | "output-limit"
          | "invalid-receipt"
          | "unexpected-path"
          | "missing-required-change";
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
    digest: string;
  };

export type TargetApplyResult =
  | { ok: true; receipt: TargetApplyReceipt }
  | { ok: false; receipt: TargetApplyFailureReceipt };

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
    !digest.safeParse(input.appSpecDigest).success ||
    !digest.safeParse(input.preparedTreeDigest).success
  )
    throw new Error("A canonical V2 target apply receipt is required.");
}

const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

function boundedOutput(result: ApplyCommandResult): void {
  if (
    Buffer.byteLength(result.stdout) > TARGET_APPLY_OUTPUT_BYTES ||
    Buffer.byteLength(result.stderr) > TARGET_APPLY_OUTPUT_BYTES
  )
    throw new Error("Target apply output exceeded the fixed size limit.");
}

export function applyOverlayRoot(proposalDigest: string): string {
  if (!digest.safeParse(proposalDigest).success)
    throw new Error("The target proposal digest is invalid.");
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
  proposalPath: string;
  appSpecPath: string;
  acceptedAppSpec: Uint8Array;
}> {
  const relativeRoot = applyOverlayRoot(input.proposalDigest);
  const absoluteRoot = `/workspace/${relativeRoot}`;
  const parent = relativeRoot.slice(0, relativeRoot.lastIndexOf("/"));
  const claim = `${parent}/materializing`;
  const absoluteClaim = `/workspace/${claim}`;
  const absent = await input.sandbox.run({
    command: `test ! -e ${absoluteRoot}`,
    workingDirectory: "/workspace",
    abortSignal: AbortSignal.timeout(TARGET_APPLY_TIMEOUT_MS),
  });
  if (absent.exitCode !== 0)
    throw new Error(
      "The proposal apply overlay already exists without a durable receipt.",
    );
  await ensureSandboxDirectories(input.sandbox, [parent]);
  const acquire = await input.sandbox.run({
    command: `mkdir ${absoluteClaim}`,
    workingDirectory: "/workspace",
    abortSignal: AbortSignal.timeout(TARGET_APPLY_TIMEOUT_MS),
  });
  boundedOutput(acquire);
  if (acquire.exitCode !== 0)
    throw new Error(
      "The proposal apply overlay is already being materialized.",
    );
  const planningRoot = `/workspace/${planningOverlayRoot(input.artifactRevision)}`;
  const environment = input.environment ?? process.env;
  const dependencyLayout =
    input.dependencyLayout ??
    (hasTestCapability("simulated-target", environment)
      ? ({
          version: 1,
          kind: "fixture",
          roots: [],
          workspaceLinks: [],
        } as const)
      : undefined);
  if (dependencyLayout === undefined)
    throw new Error("The dependency execution layout receipt is missing.");
  const copyCommand = hasTestCapability("simulated-target", environment)
    ? `cp -R ${planningRoot} ${absoluteRoot}`
    : `cp -R ${planningRoot} ${absoluteRoot}`;
  const copy = await input.sandbox.run({
    command: copyCommand,
    workingDirectory: "/workspace",
    abortSignal: AbortSignal.timeout(TARGET_APPLY_TIMEOUT_MS),
  });
  try {
    boundedOutput(copy);
    if (copy.exitCode !== 0) throw new Error("ApplyOverlayCopyFailed");
  } catch {
    await input.sandbox.removePath({
      path: relativeRoot,
      recursive: true,
      force: true,
    });
    await input.sandbox.removePath({
      path: claim,
      recursive: true,
      force: true,
    });
    throw new Error(
      "The fresh proposal apply overlay could not be materialized.",
    );
  }
  try {
    await materializeExecutionDependencyView({
      sandbox: input.sandbox,
      layout: dependencyLayout,
      overlayRoot: relativeRoot,
      viewKey: input.proposalDigest,
    });
  } catch (error) {
    await input.sandbox.removePath({
      path: relativeRoot,
      recursive: true,
      force: true,
    });
    await input.sandbox.removePath({
      path: claim,
      recursive: true,
      force: true,
    });
    throw error;
  }
  await input.sandbox.removePath({ path: claim, recursive: true, force: true });
  try {
    const proposalPath = `.app-builder/apply/${input.proposalDigest}/proposal.json`;
    await input.sandbox.writeTextFile({
      path: proposalPath,
      content: `${JSON.stringify(input.proposal, null, 2)}\n`,
    });
    const appSpecPath = input.proposal.contract.appSpec.path;
    const acceptedAppSpec = await input.sandbox.readBinaryFile({
      path: `${relativeRoot}/${appSpecPath}`,
    });
    if (
      acceptedAppSpec === null ||
      sha256(acceptedAppSpec) !== input.proposal.contract.appSpec.sha256
    )
      throw new Error(
        "The planning overlay does not contain the exact accepted AppSpec.",
      );
    return {
      applyRoot: absoluteRoot,
      proposalPath: `/workspace/${proposalPath}`,
      appSpecPath,
      acceptedAppSpec,
    };
  } catch (error) {
    await input.sandbox.removePath({
      path: relativeRoot,
      recursive: true,
      force: true,
    });
    throw error;
  }
}

async function restorePreparedAppSpecBaseline(input: {
  sandbox: SandboxSession;
  applyRoot: string;
  appSpecPath: string;
}): Promise<void> {
  const prepared = await input.sandbox.readBinaryFile({
    path: `repository/${input.appSpecPath}`,
  });
  const applyPath = `${input.applyRoot.replace(/^\/workspace\//u, "")}/${input.appSpecPath}`;
  if (prepared === null) {
    await input.sandbox.removePath({ path: applyPath, force: true });
    return;
  }
  await input.sandbox.writeBinaryFile({ path: applyPath, content: prepared });
}

async function stageAcceptedAppSpec(input: {
  sandbox: SandboxSession;
  applyRoot: string;
  appSpecPath: string;
  acceptedAppSpec: Uint8Array;
}): Promise<void> {
  await input.sandbox.writeBinaryFile({
    path: `${input.applyRoot.replace(/^\/workspace\//u, "")}/${input.appSpecPath}`,
    content: input.acceptedAppSpec,
  });
}

const snapshotLine = /^([0-7]{3,4})\t([0-9a-f]{64})\t(.+)$/u;

export const OVERLAY_SNAPSHOT_SCRIPT = String.raw`
const { createHash } = require("node:crypto");
const { lstatSync, readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

const files = [];
const visit = (directory, relativeDirectory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = relativeDirectory
      ? relativeDirectory + "/" + entry.name
      : entry.name;
    if (
      relativeDirectory === "" &&
      (relativePath === "node_modules" || relativePath === ".scratch")
    )
      continue;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(absolutePath, relativePath);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = lstatSync(absolutePath);
    const mode = (stat.mode & 0o7777).toString(8);
    const digest = createHash("sha256")
      .update(readFileSync(absolutePath))
      .digest("hex");
    files.push({ path: relativePath, mode, digest });
  }
};

visit(".", "");
files.sort((left, right) =>
  Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
);
for (const file of files)
  process.stdout.write(file.mode + "\t" + file.digest + "\t" + file.path + "\n");
`;

export function overlaySnapshotCommand(): string {
  if (OVERLAY_SNAPSHOT_SCRIPT.includes("'"))
    throw new Error("The overlay snapshot script is not shell-safe.");
  return `bun -e '${OVERLAY_SNAPSHOT_SCRIPT}'`;
}

export async function inspectApplyOverlay(
  sandbox: SandboxSession,
  applyRoot: string,
): Promise<OverlaySnapshot> {
  const result = await sandbox.run({
    command: overlaySnapshotCommand(),
    workingDirectory: applyRoot,
    abortSignal: AbortSignal.timeout(TARGET_APPLY_TIMEOUT_MS),
  });
  boundedOutput(result);
  if (result.exitCode !== 0)
    throw new Error("The proposal apply overlay could not be inspected.");
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
      )
        throw new Error(
          "The proposal apply overlay returned an invalid path receipt.",
        );
      return {
        path: match[3],
        mode: match[1],
        digest: match[2],
      };
    });
  const normalized = canonicalOverlayFiles(files);
  if (new Set(normalized.map(({ path }) => path)).size !== normalized.length)
    throw new Error("The proposal apply overlay returned duplicate paths.");
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
  if (sourceManifest === null)
    throw new Error("The prepared workspace manifest is missing.");
  const parsed = JSON.parse(sourceManifest) as unknown;
  if (!Array.isArray(parsed))
    throw new Error("The prepared workspace manifest is invalid.");
  const sourceFiles = parsed.map((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !("path" in candidate) ||
      typeof candidate.path !== "string" ||
      !safeSourcePath(candidate.path)
    )
      throw new Error("The prepared workspace manifest is invalid.");
    return {
      path: candidate.path,
      mode: "mode" in candidate && candidate.mode === "100755" ? "755" : "644",
    };
  });
  const candidates = [
    ...sourceFiles,
    { path: `prototype/${appId}/app-spec.md`, mode: "644" },
    { path: `apps/${appId}/app.contract.json`, mode: "644" },
    { path: `apps/${appId}/app/page.tsx`, mode: "644" },
    { path: `apps/${appId}/package.json`, mode: "644" },
  ];
  const relativeRoot = applyRoot.replace(/^\/workspace\//u, "");
  const files = (
    await Promise.all(
      candidates.map(async ({ path, mode }) => {
        const content = await sandbox.readBinaryFile({
          path: `${relativeRoot}/${path}`,
        });
        return content === null
          ? undefined
          : { path, mode, digest: sha256(content) };
      }),
    )
  ).filter((file): file is OverlayFile => file !== undefined);
  const normalized = canonicalOverlayFiles(files);
  return {
    files: normalized,
    treeDigest: sha256(JSON.stringify(normalized)),
  };
}

export function overlayChanges(
  before: OverlaySnapshot,
  after: OverlaySnapshot,
): OverlayChange[] {
  const beforeFiles = new Map(before.files.map((file) => [file.path, file]));
  const afterFiles = new Map(after.files.map((file) => [file.path, file]));
  return [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])]
    .toSorted(compareOverlayPaths)
    .flatMap((path): OverlayChange[] => {
      const previous = beforeFiles.get(path);
      const current = afterFiles.get(path);
      if (previous === undefined && current !== undefined)
        return [
          {
            path,
            kind: "added",
            after: { mode: current.mode, digest: current.digest },
          },
        ];
      if (previous !== undefined && current === undefined)
        return [
          {
            path,
            kind: "deleted",
            before: { mode: previous.mode, digest: previous.digest },
          },
        ];
      if (
        previous !== undefined &&
        current !== undefined &&
        (previous.mode !== current.mode || previous.digest !== current.digest)
      )
        return [
          {
            path,
            kind: "modified",
            before: { mode: previous.mode, digest: previous.digest },
            after: { mode: current.mode, digest: current.digest },
          },
        ];
      return [];
    });
}

function allowedApplyChange(
  path: string,
  appId: string,
  appSpecPath: string,
): boolean {
  return (
    path === appSpecPath ||
    path === "microfrontends.json" ||
    path.startsWith(`apps/${appId}/`)
  );
}

function parseTargetReceipt(
  result: ApplyCommandResult,
  proposal: TargetProposal,
): TargetApplyCommandReceipt | undefined {
  if (result.exitCode !== 0) return undefined;
  let candidate: unknown;
  try {
    candidate = JSON.parse(result.stdout) as unknown;
  } catch {
    return undefined;
  }
  const parsed = targetApplyCommandReceiptSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  const receipt = parsed.data;
  if (
    receipt.appId !== proposal.contract.appId ||
    receipt.recovered ||
    receipt.contractPath !== proposal.futurePath ||
    receipt.workspacePath !== proposal.plan.source.workspacePath ||
    receipt.topology.path !== proposal.plan.topology.configPath ||
    (proposal.plan.topology.currentDigest !== undefined &&
      receipt.topology.oldDigest !== proposal.plan.topology.currentDigest) ||
    (proposal.plan.topology.proposedDigest !== undefined &&
      receipt.topology.newDigest !== proposal.plan.topology.proposedDigest) ||
    receipt.mutations[0] !== proposal.plan.source.workspacePath
  )
    return undefined;
  return receipt;
}

export function sandboxApplyCommandExecutor(): ApplyCommandExecutor {
  return async ({ sandbox, applyRoot, proposalPath, proposal }) => {
    if ("operation" in proposal) {
      const relativeRoot = applyRoot.replace(/^\/workspace\//u, "");
      for (const change of proposal.iteration.changes) {
        const current = await sandbox.readBinaryFile({
          path: `${relativeRoot}/${change.path}`,
        });
        if (
          (change.before === undefined
            ? current !== null
            : current === null || sha256(current) !== change.before.digest) ||
          change.after.digest !== sha256(change.after.content)
        )
          return {
            exitCode: 2,
            stdout: "",
            stderr: "stale iteration preimage",
          };
      }
      for (const change of proposal.iteration.changes)
        await sandbox.writeTextFile({
          path: `${relativeRoot}/${change.path}`,
          content: change.after.content,
        });
      const oldDigest = proposal.plan.topology.currentDigest ?? "0".repeat(64);
      const receipt: TargetApplyCommandReceipt = {
        version: 1,
        appId: proposal.contract.appId,
        contractPath: proposal.futurePath,
        workspacePath: proposal.plan.source.workspacePath,
        topology: {
          path: "microfrontends.json",
          oldDigest,
          newDigest: proposal.plan.topology.proposedDigest ?? oldDigest,
        },
        mutations: [proposal.plan.source.workspacePath, "microfrontends.json"],
        recovered: false,
        omittedAuthorities: [
          "provider-provisioning",
          "deployment",
          "production-readiness",
        ],
      };
      return { exitCode: 0, stdout: JSON.stringify(receipt), stderr: "" };
    }
    return await sandbox.run({
      command: `MISE_AUTO_INSTALL=false MISE_EXEC_AUTO_INSTALL=false MISE_TASK_RUN_AUTO_INSTALL=false mise --env app-builder run --no-deps --skip-tools create:app -- --proposal ${proposalPath}`,
      workingDirectory: applyRoot,
      abortSignal: AbortSignal.timeout(TARGET_APPLY_TIMEOUT_MS),
    });
  };
}

export function fixtureApplyCommandExecutor(): ApplyCommandExecutor {
  return async ({ sandbox, appId, applyRoot, proposal }) => {
    const relativeRoot = applyRoot.replace(/^\/workspace\//u, "");
    if ("operation" in proposal) {
      for (const change of proposal.iteration.changes)
        await sandbox.writeTextFile({
          path: `${relativeRoot}/${change.path}`,
          content: change.after.content,
        });
      const oldDigest = proposal.plan.topology.currentDigest ?? "0".repeat(64);
      const receipt: TargetApplyCommandReceipt = {
        version: 1,
        appId,
        contractPath: proposal.futurePath,
        workspacePath: proposal.plan.source.workspacePath,
        topology: {
          path: "microfrontends.json",
          oldDigest,
          newDigest: proposal.plan.topology.proposedDigest ?? oldDigest,
        },
        mutations: [proposal.plan.source.workspacePath, "microfrontends.json"],
        recovered: false,
        omittedAuthorities: [
          "provider-provisioning",
          "deployment",
          "production-readiness",
        ],
      };
      return { exitCode: 0, stdout: JSON.stringify(receipt), stderr: "" };
    }
    await ensureSandboxDirectories(sandbox, [
      `${relativeRoot}/apps/${appId}`,
      `${relativeRoot}/apps/${appId}/app`,
      `${relativeRoot}/apps/shell`,
    ]);
    await sandbox.writeTextFile({
      path: `${relativeRoot}/apps/${appId}/app.contract.json`,
      content: `${JSON.stringify(proposal.contract, null, 2)}\n`,
    });
    await sandbox.writeTextFile({
      path: `${relativeRoot}/apps/${appId}/package.json`,
      content: `${JSON.stringify({ name: `@autograph/${appId}` }, null, 2)}\n`,
    });
    await sandbox.writeTextFile({
      path: `${relativeRoot}/apps/${appId}/app/page.tsx`,
      content:
        'import { ReviewQueue } from "@arrusted/ui/review-queue";\nimport "@arrusted/design-system/tokens.css";\n\nexport default function Page() {\n  return <ReviewQueue />;\n}\n',
    });
    await sandbox.writeTextFile({
      path: `${relativeRoot}/microfrontends.json`,
      content: `${JSON.stringify({ applications: [appId] }, null, 2)}\n`,
    });
    if (appId === "apply-failure")
      return { exitCode: 1, stdout: "", stderr: "fixture apply failure" };
    const oldDigest = proposal.plan.topology.currentDigest ?? "0".repeat(64);
    const newDigest = proposal.plan.topology.proposedDigest ?? "1".repeat(64);
    const receipt: TargetApplyCommandReceipt = {
      version: 1,
      appId,
      contractPath: proposal.futurePath,
      workspacePath: proposal.plan.source.workspacePath,
      topology: {
        path: "microfrontends.json",
        oldDigest,
        newDigest,
      },
      mutations: [proposal.plan.source.workspacePath, "microfrontends.json"],
      recovered: false,
      omittedAuthorities: [
        "provider-provisioning",
        "deployment",
        "production-readiness",
      ],
    };
    return { exitCode: 0, stdout: JSON.stringify(receipt), stderr: "" };
  };
}

export async function executeProposalBoundApply(input: {
  sandbox: SandboxSession;
  executor: ApplyCommandExecutor;
  snapshotter?: typeof inspectApplyOverlay;
  binding: TargetApplyBinding;
  artifactRevision: string;
  dependencyLayout?: ExecutionDependencyLayout;
  proposal: TargetProposal;
  appliedByCallId: string;
  environment?: Readonly<Record<string, string | undefined>>;
}): Promise<TargetApplyResult> {
  if (
    input.binding.appSpecDigest !== input.proposal.contract.appSpec.sha256 ||
    input.binding.appSpecPath !== input.proposal.contract.appSpec.path ||
    !safeSourcePath(input.binding.appSpecPath)
  )
    throw new Error(
      "The accepted AppSpec binding or path differs from the target proposal.",
    );
  const snapshotter = input.snapshotter ?? inspectApplyOverlay;
  const overlay = await materializeFreshApplyOverlay({
    sandbox: input.sandbox,
    artifactRevision: input.artifactRevision,
    dependencyLayout: input.dependencyLayout,
    proposalDigest: input.binding.proposalDigest,
    proposal: input.proposal,
    environment: input.environment,
  });
  let planning: OverlaySnapshot;
  let prepared: OverlaySnapshot;
  let before: OverlaySnapshot;
  try {
    planning = await snapshotter(input.sandbox, overlay.applyRoot);
    prepared = await snapshotter(input.sandbox, "/workspace/repository");
    await restorePreparedAppSpecBaseline({
      sandbox: input.sandbox,
      applyRoot: overlay.applyRoot,
      appSpecPath: overlay.appSpecPath,
    });
    before = await snapshotter(input.sandbox, overlay.applyRoot);
    await stageAcceptedAppSpec({
      sandbox: input.sandbox,
      applyRoot: overlay.applyRoot,
      appSpecPath: overlay.appSpecPath,
      acceptedAppSpec: overlay.acceptedAppSpec,
    });
  } catch (error) {
    await input.sandbox.removePath({
      path: applyOverlayRoot(input.binding.proposalDigest),
      recursive: true,
      force: true,
    });
    throw error;
  }
  let command: ApplyCommandResult;
  try {
    command = await input.executor({
      sandbox: input.sandbox,
      appId: input.proposal.contract.appId,
      applyRoot: overlay.applyRoot,
      proposalPath: overlay.proposalPath,
      proposal: input.proposal,
    });
  } catch (error) {
    command = {
      exitCode: -1,
      stdout: "",
      stderr: error instanceof Error ? error.name : "TargetApplyError",
    };
  }
  let outputExceeded = false;
  try {
    boundedOutput(command);
  } catch {
    outputExceeded = true;
  }
  const attemptBase = {
    version: 2 as const,
    ...input.binding,
    applyRoot: overlay.applyRoot,
    planningTreeDigest: planning.treeDigest,
    preparedTreeDigest: prepared.treeDigest,
    preTree: before.files,
    preTreeDigest: before.treeDigest,
    command: {
      name: ("operation" in input.proposal
        ? "iterate-existing-app"
        : "create-app") as "create-app" | "iterate-existing-app",
      exitCode: command.exitCode,
      stdoutDigest: sha256(command.stdout),
      stderrDigest: sha256(command.stderr),
    },
    appliedByCallId: input.appliedByCallId,
  };
  let after: OverlaySnapshot;
  try {
    after = await snapshotter(input.sandbox, overlay.applyRoot);
  } catch {
    const unsigned = {
      ...attemptBase,
      postTree: null,
      postTreeDigest: null,
      changes: null,
      changedContentDigest: null,
      status: "partial-failure" as const,
      reason: "post-snapshot-failed" as const,
      recoveryRequired: true as const,
    };
    return {
      ok: false,
      receipt: { ...unsigned, digest: sha256(JSON.stringify(unsigned)) },
    };
  }
  const changes = overlayChanges(before, after);
  const targetReceipt = parseTargetReceipt(command, input.proposal);
  const unexpectedPath = changes.some(
    ({ path }) =>
      !allowedApplyChange(
        path,
        input.proposal.contract.appId,
        input.proposal.contract.appSpec.path,
      ),
  );
  const acceptedAppSpec = after.files.find(
    ({ path }) => path === input.proposal.contract.appSpec.path,
  );
  const iterationProposal =
    "operation" in input.proposal ? input.proposal : undefined;
  const requiredIterationPaths = iterationProposal
    ? new Set(iterationProposal.iteration.changes.map(({ path }) => path))
    : undefined;
  const missingRequiredChange =
    acceptedAppSpec?.digest !== input.proposal.contract.appSpec.sha256 ||
    (iterationProposal !== undefined
      ? iterationProposal.iteration.changes.some(
          ({ path, after }) =>
            (iterationProposal.iteration.changes.find(
              (candidate) => candidate.path === path,
            )?.before?.digest !== undefined &&
              after.digest ===
                iterationProposal.iteration.changes.find(
                  (candidate) => candidate.path === path,
                )?.before?.digest) ||
            !changes.some(
              (change) =>
                change.path === path && change.after?.digest === after.digest,
            ),
        ) ||
        changes.some(
          ({ path }) =>
            path !== input.proposal.contract.appSpec.path &&
            !requiredIterationPaths?.has(path),
        )
      : !changes.some(
          ({ path }) =>
            path === input.proposal.plan.topology.configPath ||
            path.startsWith(`${input.proposal.plan.source.workspacePath}/`),
        ) ||
        !changes.some(
          ({ path }) => path === input.proposal.plan.topology.configPath,
        ));
  const base = {
    ...attemptBase,
    postTree: after.files,
    postTreeDigest: after.treeDigest,
    changes,
    changedContentDigest: sha256(JSON.stringify(changes)),
  };
  if (
    command.exitCode !== 0 ||
    outputExceeded ||
    targetReceipt === undefined ||
    unexpectedPath ||
    missingRequiredChange
  ) {
    const unsigned = {
      ...base,
      status: "partial-failure" as const,
      reason:
        command.exitCode !== 0
          ? ("command-failed" as const)
          : outputExceeded
            ? ("output-limit" as const)
            : targetReceipt === undefined
              ? ("invalid-receipt" as const)
              : unexpectedPath
                ? ("unexpected-path" as const)
                : ("missing-required-change" as const),
      recoveryRequired: true as const,
    };
    return {
      ok: false,
      receipt: { ...unsigned, digest: sha256(JSON.stringify(unsigned)) },
    };
  }
  const unsigned = {
    ...base,
    status: "applied" as const,
    targetReceipt,
  };
  return {
    ok: true,
    receipt: { ...unsigned, digest: sha256(JSON.stringify(unsigned)) },
  };
}
