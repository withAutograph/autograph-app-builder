import { retainPreparedLocalSourceBaseline } from "./local-source-baseline-retention";
import { createHash } from "node:crypto";
import path from "node:path";
import type { SandboxSession } from "eve/sandbox";
import type { SourceReceipt } from "./source-receipt";
import type { captureLocalPlanningSource } from "./local-planning-source-capture";

import {
  readPreparedSandboxSourceManifest,
  recordPreparedSandboxWorkspace,
} from "./supported-template";
import type { PreparedSandboxWorkspace } from "./supported-template";
import {
  localPlanningGitPresenceProgram,
  initializeLocalPlanningGitBaseProgram,
  importLocalPlanningCurrentCommitProgram,
} from "./local-planning-git-base";
import { getBuilderSandboxId } from "../sandbox/builder-sandbox";
import { planningSourceReconciliationProgram } from "./planning-source-reconciliation";
import { ensureSandboxDirectories } from "./sandbox-filesystem";
import { sanitizeValidationDiagnosticText } from "./validation-output-sanitize";
import { z } from "zod";

const repositoryWorkspacePath = "/workspace/repository";
const workspacePath = "/workspace";

export { captureLocalPlanningSource } from "./local-planning-source-capture";

const objectId = z.string().regex(/^[a-f0-9]{40}$/u);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const reconciliationOutcome = z.strictObject({
  changed: z.boolean(),
  checkpointRef: z.string(),
  sourceSha: objectId,
  sourceTree: objectId,
});
const retainSourceGeneration = async (
  capture: Awaited<ReturnType<typeof captureLocalPlanningSource>>,
  dependencies?: { retainBaseline?: typeof retainPreparedLocalSourceBaseline },
) => {
  await (dependencies?.retainBaseline ?? retainPreparedLocalSourceBaseline)(capture.generation, {
    captured: capture,
  });
};
const verifyCurrentLocalManifest = async (input: {
  verifyCurrentManifest?: PreparedSandboxWorkspace;
  originalSourceSha: string;
  originalWorkspaceDigest: string;
  workspaceId: string;
  sourceOverlay?: unknown;
  sandbox: SandboxSession;
  assertCurrent: () => void;
}) => {
  if (input.verifyCurrentManifest !== undefined) {
    const current = input.verifyCurrentManifest;
    if (
      current.workspaceId !== input.workspaceId ||
      current.sourceSha !== input.originalSourceSha ||
      current.workspaceDigest !== input.originalWorkspaceDigest ||
      input.sourceOverlay !== undefined
    ) {
      throw new Error("The current reconciliation does not match its saved workspace.");
    }
    await readPreparedSandboxSourceManifest(input.sandbox, current);
    input.assertCurrent();
    return {
      currentManifestDigest: current.workspaceDigest,
      currentManifestPath: "/workspace/.app-builder/source-files.json",
    };
  }
  return {};
};

/** Reuse the one owned three-way reconciliation engine. No provider/GitHub operation or old approval is replayed. */
export const reconcileLocalPlanningSource = async (
  input: {
    assertCurrent: () => void;
    sandbox: SandboxSession;
    sessionId: string;
    appId: string;
    callId: string;
    originalSourceSha: string;
    originalWorkspaceDigest: string;
    sourceOverlay?: { sourceSha: string; workspaceDigest: string };
    workspaceId: string;
    verifyCurrentManifest?: PreparedSandboxWorkspace;
    receipt: Pick<SourceReceipt, "sourceSha" | "sourceTree" | "eligibilityDigest">;
    capture: Awaited<ReturnType<typeof captureLocalPlanningSource>>;
  },
  dependencies?: { retainBaseline?: typeof retainPreparedLocalSourceBaseline },
) => {
  const { capture, sandbox } = input;
  if (capture.sourceSha !== input.receipt.sourceSha) {
    throw new Error(
      "The selected local source advanced during capture. Prepare again; the candidate is retained.",
    );
  }
  input.assertCurrent();
  if (getBuilderSandboxId(sandbox) !== input.workspaceId) {
    throw new Error("The original local source belongs to another saved workspace.");
  }
  const currentManifest = await verifyCurrentLocalManifest(input);
  // Every newly frozen source generation needs independent custody, even
  // when the candidate already has its older private Git reconciliation base.
  await retainSourceGeneration(capture, dependencies);
  input.assertCurrent();
  const presence = await sandbox.run({
    command: `node -e ${quote(localPlanningGitPresenceProgram)} ${quote(JSON.stringify({ root: repositoryWorkspacePath }))}`,
    workingDirectory: workspacePath,
  });
  input.assertCurrent();
  if (presence.exitCode !== 0) {
    throw new Error(
      `The saved local candidate Git boundary is unavailable; its source is retained. ${sanitizeValidationDiagnosticText(presence.stderr || presence.stdout)}`,
    );
  }
  let restoredOriginalBase:
    | { originalSourceSha: string; sourceSha: string; sourceTree: string }
    | undefined;
  if (!z.strictObject({ present: z.boolean() }).parse(JSON.parse(presence.stdout)).present) {
    const baseline = capture.originalBase(input.originalWorkspaceDigest);
    if (baseline.originalSourceSha !== input.originalSourceSha) {
      throw new Error("The verified original Git base does not match this saved planning source.");
    }
    restoredOriginalBase = {
      originalSourceSha: baseline.originalSourceSha,
      sourceSha: baseline.sourceSha,
      sourceTree: baseline.sourceTree,
    };
    const pack = `.app-builder/local-source/${hash(input.sessionId)}/original-${baseline.sourceSha}.pack`;
    await ensureSandboxDirectories(sandbox, [path.posix.dirname(pack)]);
    input.assertCurrent();
    await sandbox.writeFile({ path: pack, content: baseline.streamPack() });
    input.assertCurrent();
    const initialization = {
      root: repositoryWorkspacePath,
      stateRoot: `/workspace/.app-builder/local-source/${hash(input.sessionId)}`,
      packPath: `/workspace/${pack}`,
      sourceSha: baseline.sourceSha,
      sourceTree: baseline.sourceTree,
      originalSourceSha: baseline.originalSourceSha,
    };
    const initialized = await sandbox.run({
      command: `node -e ${quote(initializeLocalPlanningGitBaseProgram)} ${quote(JSON.stringify(initialization))}`,
      workingDirectory: workspacePath,
    });
    input.assertCurrent();
    if (initialized.exitCode !== 0) {
      throw new Error(
        `The proven original Git baseline could not be installed; candidate bytes are retained. ${sanitizeValidationDiagnosticText(initialized.stderr || initialized.stdout)}`,
      );
    }
  }
  if (capture.sourceSha !== input.originalSourceSha) {
    const current = capture.currentCommit();
    const pack = `.app-builder/local-source/${hash(input.sessionId)}/current-${current.sourceSha}.pack`;
    await ensureSandboxDirectories(sandbox, [path.posix.dirname(pack)]);
    input.assertCurrent();
    await sandbox.writeFile({ path: pack, content: current.streamPack() });
    input.assertCurrent();
    const currentIdentity = {
      root: repositoryWorkspacePath,
      packPath: `/workspace/${pack}`,
      sourceSha: current.sourceSha,
      sourceTree: current.sourceTree,
    };
    const imported = await sandbox.run({
      command: `node -e ${quote(importLocalPlanningCurrentCommitProgram)} ${quote(JSON.stringify(currentIdentity))}`,
      workingDirectory: workspacePath,
    });
    input.assertCurrent();
    if (imported.exitCode !== 0) {
      throw new Error(
        `Current captured source identity could not be retained; candidate files are unchanged. ${sanitizeValidationDiagnosticText(imported.stderr || imported.stdout)}`,
      );
    }
  }
  const bundle = `.app-builder/local-source/${hash(input.sessionId)}/${capture.snapshotSha}.bundle`;
  if (capture.needsBundle) {
    await ensureSandboxDirectories(sandbox, [path.posix.dirname(bundle)]);
    input.assertCurrent();
    await sandbox.writeFile({ path: bundle, content: capture.streamBundle() });
  }
  input.assertCurrent();
  const oldCommit = quote(`${objectId.parse(input.originalSourceSha)}^{commit}`);
  const commands = [
    `git -c core.hooksPath=/dev/null -c protocol.allow=never -c protocol.file.allow=always -c credential.helper= cat-file -e ${oldCommit}`,
  ];
  if (capture.needsBundle) {
    const bundlePath = quote(`/workspace/${bundle}`);
    commands.push(
      `git -c core.hooksPath=/dev/null -c protocol.allow=never -c protocol.file.allow=always -c credential.helper= fetch --quiet --no-tags --no-write-fetch-head --no-recurse-submodules ${bundlePath} ${quote(capture.snapshotSha)}`,
    );
  }
  const imported = await sandbox.run({
    command: commands.join(" && "),
    workingDirectory: repositoryWorkspacePath,
  });
  if (imported.exitCode !== 0) {
    throw new Error(
      `Builder could not read the original private source base or import current local planning objects. The candidate is retained. ${sanitizeValidationDiagnosticText(imported.stderr || imported.stdout)}`,
    );
  }
  const request = {
    appId: input.appId,
    branchRef: "refs/app-builder/local-source",
    fetchRemote: false,
    localSource: true,
    ...currentManifest,
    ...(input.sourceOverlay === undefined
      ? {}
      : {
          managedOverlayWorkspaceDigest: z
            .string()
            .regex(/^[a-f0-9]{64}$/u)
            .parse(input.sourceOverlay.workspaceDigest),
          managedOverlayManifestPath: "/workspace/.app-builder/source-files.json",
        }),
    originalSourceSha: objectId.parse(input.originalSourceSha),
    root: repositoryWorkspacePath,
    sessionId: input.sessionId,
    stateRoot: "/workspace/.app-builder/source-reconciliation",
    targetSha: capture.snapshotSha,
  };
  input.assertCurrent();
  const reconciled = await sandbox.run({
    command: `node -e ${quote(planningSourceReconciliationProgram)} ${quote(JSON.stringify(request))}`,
    workingDirectory: repositoryWorkspacePath,
  });
  if (reconciled.exitCode !== 0) {
    throw new Error(
      `Builder could not reconcile current local source. Original app and platform bytes remain checkpointed; resolve the reported conflict and prepare again. ${sanitizeValidationDiagnosticText(reconciled.stderr || reconciled.stdout)}`,
    );
  }
  const outcome = reconciliationOutcome.parse(JSON.parse(reconciled.stdout));
  const { generation } = capture;
  input.assertCurrent();
  const workspace = await recordPreparedSandboxWorkspace({
    sandbox,
    callId: input.callId,
    sourcePath: generation.sourcePath,
    sourceSha: input.receipt.sourceSha,
    sourceTree: generation.generation,
    eligibilityDigest: generation.eligibilityDigest,
    workspaceDigest: generation.workspaceDigest,
  });
  input.assertCurrent();
  await sandbox.writeTextFile({
    path: ".app-builder/source-files.json",
    content: `${JSON.stringify(generation.sourceFiles)}\n`,
  });
  input.assertCurrent();
  await sandbox.writeTextFile({
    path: ".app-builder/source-checksums.sha256",
    content: `${generation.sourceFiles
      .map((file) => `${file.sha256}  repository/${file.path}`)
      .join("\n")}\n`,
  });
  const result: typeof outcome & {
    workspace: typeof workspace;
    selectedSourceSha: string;
    selectedSourceTree: string;
    sourceSnapshotTree: string;
    restoredOriginalBase?: NonNullable<typeof restoredOriginalBase>;
  } = {
    workspace,
    ...outcome,
    selectedSourceSha: input.receipt.sourceSha,
    selectedSourceTree: input.receipt.sourceTree,
    sourceSnapshotTree: capture.snapshotTree,
  };
  if (restoredOriginalBase !== undefined) {
    result.restoredOriginalBase = restoredOriginalBase;
  }
  return result;
};
