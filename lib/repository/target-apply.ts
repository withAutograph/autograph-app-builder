import { createHash } from "node:crypto";

import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";

import { planningOverlayRoot } from "./dependency-cache";
import type { ExecutionDependencyLayout } from "./dependency-cache";
import { ensureSandboxDirectories } from "./sandbox-filesystem";
import { safeSourcePath } from "./source-path";
import type { TargetProposal } from "./target-planning";

const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const repositoryPath = z
  .string()
  .refine(safeSourcePath, "path must remain inside the apply overlay");

// Applying a generated app can include the repository's own install/build
// steps. Keep a generous provider-side ceiling, but do not turn a normal slow
// command into a synthetic failure at five minutes.

export const targetApplyCommandReceiptSchema = z.strictObject({
  appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  contractPath: repositoryPath,
  mutations: z.tuple([repositoryPath, z.literal("microfrontends.json")]),
  omittedAuthorities: z.tuple([
    z.literal("provider-provisioning"),
    z.literal("deployment"),
    z.literal("production-readiness"),
  ]),
  recovered: z.boolean(),
  topology: z.strictObject({
    path: z.literal("microfrontends.json"),
    oldDigest: digest,
    newDigest: digest,
  }),
  version: z.literal(1),
  workspacePath: repositoryPath,
});

export type TargetApplyCommandReceipt = z.infer<
  typeof targetApplyCommandReceiptSchema
>;

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
  return Buffer.compare(
    Buffer.from(left, "utf-8"),
    Buffer.from(right, "utf-8")
  );
}

export function canonicalOverlayFiles(
  files: readonly OverlayFile[]
): OverlayFile[] {
  return files
    .map(({ path, mode, digest }) => ({ digest, mode, path }))
    .toSorted((left, right) => compareOverlayPaths(left.path, right.path));
}

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
}

export type ApplyCommandExecutor = (input: {
  sandbox: SandboxSession;
  appId: string;
  applyRoot: string;
  proposalPath: string;
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
    commandFailureKind?:
      | "timeout"
      | "permission-denied"
      | "missing-command-or-file"
      | "dependency"
      | "validation"
      | "repository-task"
      | "stale-proposal"
      | "proposal-blocked"
      | "app-already-exists"
      | "app-lock"
      | "partial-state"
      | "projected-repository"
      | "empty-output"
      | "unknown";
    missingDependency?: string;
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
  ) {
    throw new Error("A canonical V2 target apply receipt is required.");
  }
}

const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

function commandFailureKind(
  stderr: string
): TargetApplyFailureReceipt["commandFailureKind"] {
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
    return "stale-proposal";
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
  if (
    /projected config|projected repository|unsupported entry/iu.test(stderr)
  ) {
    return "projected-repository";
  }
  if (
    /mise|task|proposal|create:app|already exists|failed|error/iu.test(stderr)
  ) {
    return "repository-task";
  }
  if (stderr.trim() === "") {
    return "empty-output";
  }
  return "unknown";
}

function missingDependency(output: string): string | undefined {
  const match =
    /(?:Cannot find (?:package|module)|Module not found[^:]*:)\s*["']?(@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?)/iu.exec(
      output
    );
  return match?.[1];
}

export function applyOverlayRoot(proposalDigest: string): string {
  if (!digest.safeParse(proposalDigest).success) {
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
  proposalPath: string;
  appSpecPath: string;
  acceptedAppSpec: Uint8Array;
}> {
  const relativeRoot = applyOverlayRoot(input.proposalDigest);
  const parent = relativeRoot.slice(0, relativeRoot.lastIndexOf("/"));
  await ensureSandboxDirectories(input.sandbox, [parent]);
  const planningRoot = `/workspace/${planningOverlayRoot(input.artifactRevision)}`;
  try {
    const proposalPath = `.app-builder/apply/${input.proposalDigest}/proposal.json`;
    await input.sandbox.writeTextFile({
      content: `${JSON.stringify(input.proposal, null, 2)}\n`,
      path: proposalPath,
    });
    const appSpecPath = input.proposal.contract.appSpec.path;
    const acceptedAppSpec = await input.sandbox.readBinaryFile({
      path: `${planningRoot.replace(/^\/workspace\//u, "")}/${appSpecPath}`,
    });
    if (
      acceptedAppSpec === null ||
      sha256(acceptedAppSpec) !== input.proposal.contract.appSpec.sha256
    ) {
      throw new Error(
        "The planning overlay does not contain the exact accepted AppSpec."
      );
    }
    return {
      acceptedAppSpec,
      appSpecPath,
      applyRoot: "/workspace/repository",
      proposalPath: `/workspace/${proposalPath}`,
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
    await input.sandbox.removePath({ force: true, path: applyPath });
    return;
  }
  await input.sandbox.writeBinaryFile({ content: prepared, path: applyPath });
}

async function stageAcceptedAppSpec(input: {
  sandbox: SandboxSession;
  applyRoot: string;
  appSpecPath: string;
  acceptedAppSpec: Uint8Array;
}): Promise<void> {
  await input.sandbox.writeBinaryFile({
    content: input.acceptedAppSpec,
    path: `${input.applyRoot.replace(/^\/workspace\//u, "")}/${input.appSpecPath}`,
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
  if (OVERLAY_SNAPSHOT_SCRIPT.includes("'")) {
    throw new Error("The overlay snapshot script is not shell-safe.");
  }
  return `bun -e '${OVERLAY_SNAPSHOT_SCRIPT}'`;
}

export async function inspectApplyOverlay(
  sandbox: SandboxSession,
  applyRoot: string
): Promise<OverlaySnapshot> {
  const result = await sandbox.run({
    command: overlaySnapshotCommand(),
    workingDirectory: applyRoot,
  });
  if (result.exitCode !== 0) {
    throw new Error("The proposal apply overlay could not be inspected.");
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
        throw new Error(
          "The proposal apply overlay returned an invalid path receipt."
        );
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
  appId: string
): Promise<OverlaySnapshot> {
  const sourceManifest = await sandbox.readTextFile({
    path: ".app-builder/source-files.json",
  });
  if (sourceManifest === null) {
    throw new Error("The prepared workspace manifest is missing.");
  }
  const parsed = JSON.parse(sourceManifest) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("The prepared workspace manifest is invalid.");
  }
  const sourceFiles = parsed.map((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !("path" in candidate) ||
      typeof candidate.path !== "string" ||
      !safeSourcePath(candidate.path)
    ) {
      throw new Error("The prepared workspace manifest is invalid.");
    }
    return {
      mode: "mode" in candidate && candidate.mode === "100755" ? "755" : "644",
      path: candidate.path,
    };
  });
  const candidates = [
    ...sourceFiles,
    { mode: "644", path: `prototype/${appId}/app-spec.md` },
    { mode: "644", path: `apps/${appId}/app.contract.json` },
    { mode: "644", path: `apps/${appId}/app/page.tsx` },
    { mode: "644", path: `apps/${appId}/package.json` },
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
          : { digest: sha256(content), mode, path };
      })
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
  after: OverlaySnapshot
): OverlayChange[] {
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
            path,
            kind: "added",
            after: { mode: current.mode, digest: current.digest },
          },
        ];
      }
      if (previous !== undefined && current === undefined) {
        return [
          {
            path,
            kind: "deleted",
            before: { mode: previous.mode, digest: previous.digest },
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
            path,
            kind: "modified",
            before: { mode: previous.mode, digest: previous.digest },
            after: { mode: current.mode, digest: current.digest },
          },
        ];
      }
      return [];
    });
}

function parseTargetReceipt(
  result: ApplyCommandResult,
  proposal: TargetProposal
): TargetApplyCommandReceipt | undefined {
  if (result.exitCode !== 0) {
    return undefined;
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(result.stdout) as unknown;
  } catch {
    return undefined;
  }
  const parsed = targetApplyCommandReceiptSchema.safeParse(candidate);
  if (!parsed.success) {
    return undefined;
  }
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
  ) {
    return undefined;
  }
  return receipt;
}

function observedTargetReceipt(
  proposal: TargetProposal
): TargetApplyCommandReceipt {
  const oldDigest = proposal.plan.topology.currentDigest ?? "0".repeat(64);
  return {
    appId: proposal.contract.appId,
    contractPath: proposal.futurePath,
    mutations: [proposal.plan.source.workspacePath, "microfrontends.json"],
    omittedAuthorities: [
      "provider-provisioning",
      "deployment",
      "production-readiness",
    ],
    recovered: false,
    topology: {
      newDigest: proposal.plan.topology.proposedDigest ?? oldDigest,
      oldDigest,
      path: "microfrontends.json",
    },
    version: 1,
    workspacePath: proposal.plan.source.workspacePath,
  };
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
        ) {
          return {
            exitCode: 2,
            stdout: "",
            stderr: "stale iteration preimage",
          };
        }
      }
      for (const change of proposal.iteration.changes) {
        await sandbox.writeTextFile({
          path: `${relativeRoot}/${change.path}`,
          content: change.after.content,
        });
      }
      const oldDigest = proposal.plan.topology.currentDigest ?? "0".repeat(64);
      const receipt: TargetApplyCommandReceipt = {
        appId: proposal.contract.appId,
        contractPath: proposal.futurePath,
        mutations: [proposal.plan.source.workspacePath, "microfrontends.json"],
        omittedAuthorities: [
          "provider-provisioning",
          "deployment",
          "production-readiness",
        ],
        recovered: false,
        topology: {
          newDigest: proposal.plan.topology.proposedDigest ?? oldDigest,
          oldDigest,
          path: "microfrontends.json",
        },
        version: 1,
        workspacePath: proposal.plan.source.workspacePath,
      };
      return { exitCode: 0, stderr: "", stdout: JSON.stringify(receipt) };
    }
    // The writable checkout is the execution environment. Prepared dependency
    // roots are only a cache optimization; a checkout-backed flow can have no
    // roots at all. Let Bun establish the repository's actual dependency state
    // before invoking its generator, and treat Bun's real result as authority.
    await sandbox.setNetworkPolicy("allow-all");
    const install = await sandbox.run({
      command: "bun install",
      workingDirectory: applyRoot,
    });
    if (install.exitCode !== 0) {
      const output = `${install.stderr}\n${install.stdout}`;
      const reason = /lockfile had changes|frozen lockfile/iu.test(output)
        ? "frozen-lockfile"
        : /ENOSPC|no space left/iu.test(output)
          ? "disk-space"
          : /EACCES|permission denied/iu.test(output)
            ? "permissions"
            : /timed? out|timeout/iu.test(output)
              ? "network-timeout"
              : /failed to resolve|package not found|module not found/iu.test(
                    output
                  )
                ? "package-resolution"
                : /fetch|connection|certificate|network/iu.test(output)
                  ? "network"
                  : "unclassified";
      console.error("[app-builder apply] repository install failed", {
        exitCode: install.exitCode,
        reason,
      });
      return install;
    }
    const generated = await sandbox.run({
      command: `bun .config/turbo/generators/create-app.ts --proposal ${proposalPath}`,
      workingDirectory: applyRoot,
    });
    if (generated.exitCode !== 0) {
      const output = `${generated.stderr}\n${generated.stdout}`;
      const reason = /EACCES|permission denied/iu.test(output)
        ? "permissions"
        : /cannot find module|module_not_found|failed to resolve/iu.test(output)
          ? "module-resolution"
          : /timed? out|timeout/iu.test(output)
            ? "timeout"
            : /network|fetch|connection|certificate/iu.test(output)
              ? "network"
              : /format/iu.test(output)
                ? "formatting"
                : /lifecycle|validation|test|build/iu.test(output)
                  ? "generated-app-validation"
                  : "unclassified";
      console.error("[app-builder apply] repository generator failed", {
        exitCode: generated.exitCode,
        reason,
      });
    }
    return generated;
  };
}

export function fixtureApplyCommandExecutor(): ApplyCommandExecutor {
  return async ({ sandbox, appId, applyRoot, proposal }) => {
    const relativeRoot = applyRoot.replace(/^\/workspace\//u, "");
    if ("operation" in proposal) {
      for (const change of proposal.iteration.changes) {
        await sandbox.writeTextFile({
          path: `${relativeRoot}/${change.path}`,
          content: change.after.content,
        });
      }
      const oldDigest = proposal.plan.topology.currentDigest ?? "0".repeat(64);
      const receipt: TargetApplyCommandReceipt = {
        appId,
        contractPath: proposal.futurePath,
        mutations: [proposal.plan.source.workspacePath, "microfrontends.json"],
        omittedAuthorities: [
          "provider-provisioning",
          "deployment",
          "production-readiness",
        ],
        recovered: false,
        topology: {
          newDigest: proposal.plan.topology.proposedDigest ?? oldDigest,
          oldDigest,
          path: "microfrontends.json",
        },
        version: 1,
        workspacePath: proposal.plan.source.workspacePath,
      };
      return { exitCode: 0, stderr: "", stdout: JSON.stringify(receipt) };
    }
    await ensureSandboxDirectories(sandbox, [
      `${relativeRoot}/apps/${appId}`,
      `${relativeRoot}/apps/${appId}/app`,
      `${relativeRoot}/apps/shell`,
    ]);
    await sandbox.writeTextFile({
      content: `${JSON.stringify(proposal.contract, null, 2)}\n`,
      path: `${relativeRoot}/apps/${appId}/app.contract.json`,
    });
    await sandbox.writeTextFile({
      content: `${JSON.stringify({ name: `@autograph/${appId}` }, null, 2)}\n`,
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
      return { exitCode: 1, stdout: "", stderr: "fixture apply failure" };
    }
    const oldDigest = proposal.plan.topology.currentDigest ?? "0".repeat(64);
    const newDigest = proposal.plan.topology.proposedDigest ?? "1".repeat(64);
    const receipt: TargetApplyCommandReceipt = {
      appId,
      contractPath: proposal.futurePath,
      mutations: [proposal.plan.source.workspacePath, "microfrontends.json"],
      omittedAuthorities: [
        "provider-provisioning",
        "deployment",
        "production-readiness",
      ],
      recovered: false,
      topology: {
        newDigest,
        oldDigest,
        path: "microfrontends.json",
      },
      version: 1,
      workspacePath: proposal.plan.source.workspacePath,
    };
    return { exitCode: 0, stderr: "", stdout: JSON.stringify(receipt) };
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
  ) {
    throw new Error(
      "The accepted AppSpec binding or path differs from the target proposal."
    );
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
    try {
      for (const root of input.dependencyLayout.roots) {
        const target = `repository/${root.path}`;
        await input.sandbox.removePath({
          path: target,
          recursive: true,
          force: true,
        });
        const linked = await input.sandbox.run({
          command: `ln -s ${root.cachePath} ${root.path}`,
          workingDirectory: "/workspace/repository",
        });
        if (linked.exitCode !== 0) throw new Error("dependency cache miss");
      }
    } catch {
      // The repository install below remains authoritative. A missing or stale
      // cache is an optimization miss, not a reason to block the build.
    }
  }
  let planning: OverlaySnapshot;
  let prepared: OverlaySnapshot;
  let before: OverlaySnapshot;
  try {
    planning = await snapshotter(input.sandbox, overlay.applyRoot);
    prepared = await snapshotter(input.sandbox, "/workspace/repository");
    await restorePreparedAppSpecBaseline({
      appSpecPath: overlay.appSpecPath,
      applyRoot: overlay.applyRoot,
      sandbox: input.sandbox,
    });
    before = await snapshotter(input.sandbox, overlay.applyRoot);
    await stageAcceptedAppSpec({
      acceptedAppSpec: overlay.acceptedAppSpec,
      appSpecPath: overlay.appSpecPath,
      applyRoot: overlay.applyRoot,
      sandbox: input.sandbox,
    });
  } catch (error) {
    await input.sandbox.removePath({
      force: true,
      path: applyOverlayRoot(input.binding.proposalDigest),
      recursive: true,
    });
    throw error;
  }
  let command: ApplyCommandResult;
  try {
    command = await input.executor({
      appId: input.proposal.contract.appId,
      applyRoot: overlay.applyRoot,
      proposal: input.proposal,
      proposalPath: overlay.proposalPath,
      sandbox: input.sandbox,
    });
  } catch (error) {
    command = {
      exitCode: -1,
      stderr:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : "TargetApplyError",
      stdout: "",
    };
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
      exitCode: command.exitCode,
      name: ("operation" in input.proposal
        ? "iterate-existing-app"
        : "create-app") as "create-app" | "iterate-existing-app",
      stderrDigest: sha256(command.stderr),
      stdoutDigest: sha256(command.stdout),
    },
    appliedByCallId: input.appliedByCallId,
  };
  let after: OverlaySnapshot;
  try {
    after = await snapshotter(input.sandbox, overlay.applyRoot);
  } catch {
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
  const changes = overlayChanges(before, after);
  const targetReceipt =
    parseTargetReceipt(command, input.proposal) ??
    observedTargetReceipt(input.proposal);
  const base = {
    ...attemptBase,
    changedContentDigest: sha256(JSON.stringify(changes)),
    changes,
    postTree: after.files,
    postTreeDigest: after.treeDigest,
  };
  if (command.exitCode !== 0) {
    const commandOutput = `${command.stderr}\n${command.stdout}`;
    const unsigned = {
      ...base,
      commandFailureKind: commandFailureKind(commandOutput),
      reason: "command-failed" as const,
      recoveryRequired: true as const,
      status: "partial-failure" as const,
      ...(missingDependency(commandOutput) === undefined
        ? {}
        : { missingDependency: missingDependency(commandOutput) }),
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
