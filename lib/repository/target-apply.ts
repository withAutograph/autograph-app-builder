import { createHash } from "node:crypto";

import { z } from "zod";

import type { SandboxSession } from "eve/sandbox";

import { ensureSandboxDirectories } from "./sandbox-filesystem";
import { safeSourcePath } from "./source-path";
import { planningOverlayRoot } from "./dependency-cache";
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
    path: z.literal("apps/shell/microfrontends.json"),
    oldDigest: digest,
    newDigest: digest,
  }),
  mutations: z.tuple([
    repositoryPath,
    z.literal("apps/shell/microfrontends.json"),
  ]),
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
  eligibilityDigest: string;
  workspaceDigest: string;
  appSpecDigest: string;
  artifactRevision: string;
  dependencyReceiptDigest: string;
  identityDigest: string;
  imageDigest: string;
  dependencyCacheDigest: string;
  proposalDigest: string;
};

type ApplyResultBase = TargetApplyBinding & {
  version: 1;
  applyRoot: string;
  preTree: readonly OverlayFile[];
  postTree: readonly OverlayFile[];
  preTreeDigest: string;
  postTreeDigest: string;
  changes: readonly OverlayChange[];
  changedContentDigest: string;
  command: {
    name: "create-app";
    exitCode: number;
    stdoutDigest: string;
    stderrDigest: string;
  };
  appliedByCallId: string;
};

export type TargetApplyReceipt = ApplyResultBase & {
  status: "applied";
  targetReceipt: TargetApplyCommandReceipt;
  digest: string;
};

export type TargetApplyFailureReceipt = ApplyResultBase & {
  status: "partial-failure";
  reason:
    | "command-failed"
    | "output-limit"
    | "invalid-receipt"
    | "unexpected-path"
    | "missing-required-change";
  recoveryRequired: true;
  digest: string;
};

export type TargetApplyResult =
  | { ok: true; receipt: TargetApplyReceipt }
  | { ok: false; receipt: TargetApplyFailureReceipt };

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
  proposalDigest: string;
  proposal: TargetProposal;
}): Promise<{ applyRoot: string; proposalPath: string }> {
  const relativeRoot = applyOverlayRoot(input.proposalDigest);
  const absoluteRoot = `/workspace/${relativeRoot}`;
  const parent = relativeRoot.slice(0, relativeRoot.lastIndexOf("/"));
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
  const planningRoot = `/workspace/${planningOverlayRoot(input.artifactRevision)}`;
  const copy = await input.sandbox.run({
    command: `cp -R ${planningRoot} ${absoluteRoot}`,
    workingDirectory: "/workspace",
    abortSignal: AbortSignal.timeout(TARGET_APPLY_TIMEOUT_MS),
  });
  boundedOutput(copy);
  if (copy.exitCode !== 0)
    throw new Error(
      "The fresh proposal apply overlay could not be materialized.",
    );
  const proposalPath = `.app-builder/apply/${input.proposalDigest}/proposal.json`;
  await input.sandbox.writeTextFile({
    path: proposalPath,
    content: `${JSON.stringify(input.proposal, null, 2)}\n`,
  });
  return {
    applyRoot: absoluteRoot,
    proposalPath: `/workspace/${proposalPath}`,
  };
}

const snapshotLine = /^([0-7]{3,4})\t([0-9a-f]{64})\t(.+)$/u;

export async function inspectApplyOverlay(
  sandbox: SandboxSession,
  applyRoot: string,
): Promise<OverlaySnapshot> {
  const result = await sandbox.run({
    command:
      "find . \\( -path './node_modules' -o -path './.scratch' \\) -prune -o -type f -print0 | sort -z | while IFS= read -r -d '' path; do mode=$(stat --format='%a' -- \"$path\") || exit 1; sum=$(sha256sum -- \"$path\") || exit 1; printf '%s\\t%s\\t%s\\n' \"$mode\" \"${sum%% *}\" \"${path#./}\"; done",
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
  const normalized = files.toSorted((left, right) =>
    left.path.localeCompare(right.path),
  );
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
  )
    .filter((file): file is OverlayFile => file !== undefined)
    .toSorted((left, right) => left.path.localeCompare(right.path));
  return { files, treeDigest: sha256(JSON.stringify(files)) };
}

export function overlayChanges(
  before: OverlaySnapshot,
  after: OverlaySnapshot,
): OverlayChange[] {
  const beforeFiles = new Map(before.files.map((file) => [file.path, file]));
  const afterFiles = new Map(after.files.map((file) => [file.path, file]));
  return [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])]
    .toSorted()
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

function allowedApplyChange(path: string, appId: string): boolean {
  return (
    path === "apps/shell/microfrontends.json" ||
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
  return async ({ sandbox, applyRoot, proposalPath }) =>
    await sandbox.run({
      command: `mise run create:app -- --proposal ${proposalPath}`,
      workingDirectory: applyRoot,
      abortSignal: AbortSignal.timeout(TARGET_APPLY_TIMEOUT_MS),
    });
}

export function fixtureApplyCommandExecutor(): ApplyCommandExecutor {
  return async ({ sandbox, appId, applyRoot, proposal }) => {
    const relativeRoot = applyRoot.replace(/^\/workspace\//u, "");
    await ensureSandboxDirectories(sandbox, [
      `${relativeRoot}/apps/${appId}`,
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
      path: `${relativeRoot}/apps/shell/microfrontends.json`,
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
        path: "apps/shell/microfrontends.json",
        oldDigest,
        newDigest,
      },
      mutations: [
        proposal.plan.source.workspacePath,
        "apps/shell/microfrontends.json",
      ],
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
  proposal: TargetProposal;
  appliedByCallId: string;
}): Promise<TargetApplyResult> {
  const snapshotter = input.snapshotter ?? inspectApplyOverlay;
  const overlay = await materializeFreshApplyOverlay({
    sandbox: input.sandbox,
    artifactRevision: input.artifactRevision,
    proposalDigest: input.binding.proposalDigest,
    proposal: input.proposal,
  });
  const before = await snapshotter(input.sandbox, overlay.applyRoot);
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
  const after = await snapshotter(input.sandbox, overlay.applyRoot);
  const changes = overlayChanges(before, after);
  const targetReceipt = parseTargetReceipt(command, input.proposal);
  const unexpectedPath = changes.some(
    ({ path }) => !allowedApplyChange(path, input.proposal.contract.appId),
  );
  const missingRequiredChange =
    !changes.some(
      ({ path }) =>
        path === input.proposal.plan.topology.configPath ||
        path.startsWith(`${input.proposal.plan.source.workspacePath}/`),
    ) ||
    !changes.some(
      ({ path }) => path === input.proposal.plan.topology.configPath,
    );
  const base = {
    version: 1 as const,
    ...input.binding,
    applyRoot: overlay.applyRoot,
    preTree: before.files,
    postTree: after.files,
    preTreeDigest: before.treeDigest,
    postTreeDigest: after.treeDigest,
    changes,
    changedContentDigest: sha256(JSON.stringify(changes)),
    command: {
      name: "create-app" as const,
      exitCode: command.exitCode,
      stdoutDigest: sha256(command.stdout),
      stderrDigest: sha256(command.stderr),
    },
    appliedByCallId: input.appliedByCallId,
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
