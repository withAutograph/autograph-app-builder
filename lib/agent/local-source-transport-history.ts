/* oxlint-disable eslint/complexity, sonarjs/expression-complexity -- Current private owner, complete Native cursor and recovered lineage must agree before accepting a completed transport receipt. */
import path from "node:path";
import { z } from "zod";
import { readLocalEveCycleBinding } from "../eve/local-cycle-binding";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { Client } from "eve/client";
import type { MessageStreamEvent, SessionSnapshot } from "eve/client";
import {
  createLocalNativeRecovery,
  withLocalRecoveredSessions,
} from "../eve/local-native-recovery";
import { readLocalOperatorArtifactAuthority } from "../provisioning/local-operator-artifact-store";
import { parsePreparedWorkspace } from "../repository/supported-template";
import type { PreparedSandboxWorkspace } from "../repository/supported-template";

import {
  LEGACY_SOURCE_RECEIPT_VERSION,
  parseSourceReceipt,
  sourceIdentityDigest,
} from "../repository/source-receipt";
import type { SourceReceipt } from "../repository/source-receipt";
import type { LocalPlanningSourceReceipt } from "./local-planning-source-state";

const ACTION_RESULT_EVENT = "action.result";
const TOOL_RESULT_KIND = "tool-result";

interface ReconciledTransportProvenance {
  appId: string;
  currentWorkspace: PreparedSandboxWorkspace;
  sourceReceipt: SourceReceipt;
  history: readonly LocalPlanningSourceReceipt[];
}
interface TransportOwner {
  workspaceId: string;
  workspacePath: string;
  sourcePath: string;
  reconciliation?: ReconciledTransportProvenance;
}
/** Compatibility for an already frozen local reconciliation, never a new digest convention. */
const matchesFrozenReconciliation = (
  receipt: PreparedSandboxWorkspace,
  expected: TransportOwner,
  events: readonly MessageStreamEvent[],
): boolean => {
  const proof = expected.reconciliation;
  if (proof === undefined || !isDeepStrictEqual(receipt, proof.currentWorkspace)) {
    return false;
  }
  try {
    const source = parseSourceReceipt(proof.sourceReceipt);
    const identity = sourceIdentityDigest(source.sourceSha, source.sourceTree);
    if (
      source.version !== LEGACY_SOURCE_RECEIPT_VERSION ||
      source.sourceSha !== receipt.sourceSha ||
      source.sourcePath !== receipt.sourcePath ||
      source.eligibilityDigest !== identity ||
      source.contractDigest !== identity ||
      receipt.eligibilityDigest !== identity
    ) {
      return false;
    }
    const history = proof.history.findLast(
      (entry) =>
        entry.appId === proof.appId &&
        entry.workspaceId === receipt.workspaceId &&
        entry.workspaceDigest === receipt.workspaceDigest &&
        entry.sourceReceiptDigest === source.digest,
    );
    return (
      history !== undefined &&
      /^[a-f0-9]{40,64}$/u.test(history.privateSourceCommit) &&
      /^[a-f0-9]{40,64}$/u.test(history.sourceSnapshotTree) &&
      events.some(
        (candidate) =>
          candidate.type === ACTION_RESULT_EVENT &&
          candidate.data.status === "completed" &&
          candidate.data.error === undefined &&
          candidate.data.result.kind === TOOL_RESULT_KIND &&
          candidate.data.result.toolName === "prepare_workspace" &&
          candidate.data.result.isError !== true &&
          candidate.data.result.callId === history.reconciledByCallId &&
          isDeepStrictEqual(parsePreparedWorkspace(candidate.data.result.output), receipt),
      )
    );
  } catch {
    return false;
  }
};
const appCreationResult = z.object({ appId: z.string() });

const completedReconciliationIndex = (
  events: readonly MessageStreamEvent[],
  expected: TransportOwner,
): number => {
  const proof = expected.reconciliation;
  if (proof === undefined) {
    return -1;
  }
  const workspace = proof.currentWorkspace;
  const source = parseSourceReceipt(proof.sourceReceipt);
  if (
    workspace.workspaceId !== expected.workspaceId ||
    workspace.workspacePath !== expected.workspacePath ||
    workspace.sourcePath !== expected.sourcePath ||
    source.sourcePath !== workspace.sourcePath ||
    source.sourceSha !== workspace.sourceSha ||
    workspace.sourceTree !== workspace.workspaceDigest.slice(0, 40)
  ) {
    return -1;
  }
  const anchor = proof.history.findLast(
    (entry) =>
      entry.appId === proof.appId &&
      entry.workspaceId === workspace.workspaceId &&
      entry.workspaceDigest === workspace.workspaceDigest &&
      entry.sourceReceiptDigest === source.digest,
  );
  if (
    anchor === undefined ||
    !/^[a-f0-9]{40,64}$/u.test(anchor.privateSourceCommit) ||
    !/^[a-f0-9]{40,64}$/u.test(anchor.sourceSnapshotTree)
  ) {
    return -1;
  }
  const isAnchorResult = (event: MessageStreamEvent) =>
    event.type === ACTION_RESULT_EVENT &&
    event.data.result.kind === TOOL_RESULT_KIND &&
    event.data.result.callId === anchor.reconciledByCallId;
  const index = events.findIndex(isAnchorResult);
  if (index === -1 || index !== events.findLastIndex(isAnchorResult)) {
    return -1;
  }
  const event = events[index];
  if (
    event?.type !== ACTION_RESULT_EVENT ||
    event.data.status !== "completed" ||
    event.data.error !== undefined ||
    event.data.result.kind !== TOOL_RESULT_KIND ||
    event.data.result.isError === true
  ) {
    return -1;
  }
  const { toolName, output } = event.data.result;
  if (toolName === "prepare_workspace" && isDeepStrictEqual(output, workspace)) {
    return index;
  }
  if (
    toolName === "prepare_app_creation" &&
    appCreationResult.safeParse(output).data?.appId === proof.appId
  ) {
    return index;
  }
  return -1;
};

/** Only completed private Native tool results are source transport receipts; observations and prose are not. */
export const completedLocalSourceTransport = (
  events: readonly MessageStreamEvent[],
  expected: TransportOwner,
): (PreparedSandboxWorkspace & { requiresCurrentManifestReadback?: true }) | undefined => {
  const index = events.findLastIndex(
    (candidate) =>
      candidate.type === ACTION_RESULT_EVENT &&
      candidate.data.status === "completed" &&
      candidate.data.error === undefined &&
      candidate.data.result.kind === TOOL_RESULT_KIND &&
      candidate.data.result.toolName === "prepare_workspace" &&
      candidate.data.result.isError !== true,
  );
  const event = events[index];
  if (event?.type !== ACTION_RESULT_EVENT) {
    return undefined;
  }
  const receipt = parsePreparedWorkspace(event.data.result.output);
  if (
    receipt.workspaceId !== expected.workspaceId ||
    receipt.workspacePath !== expected.workspacePath ||
    receipt.sourcePath !== expected.sourcePath ||
    receipt.sourceTree !== receipt.workspaceDigest.slice(0, 40) ||
    (receipt.eligibilityDigest !== createHash("sha256").update(receipt.sourceSha).digest("hex") &&
      !matchesFrozenReconciliation(receipt, expected, events))
  ) {
    throw new Error("The completed source transport belongs to another workspace or source.");
  }
  if (expected.reconciliation && index < completedReconciliationIndex(events, expected)) {
    return { ...expected.reconciliation.currentWorkspace, requiresCurrentManifestReadback: true };
  }
  return receipt;
};
/** Local private HTTP only, pinned to the real tool context and protected recovered-child lineage. No send/resume operation exists here. */
export const readCompletedLocalSourceTransport = async (
  input: {
    sessionId: string;
    ownerRunId?: string;
    ownerAnchorRunId?: string;
    expected: TransportOwner;
    signal?: AbortSignal;
  },
  dependencies: {
    environment?: Readonly<Record<string, string | undefined>>;
    snapshot?: (sessionId: string, signal?: AbortSignal) => Promise<SessionSnapshot>;
    readAuthority?: typeof readLocalOperatorArtifactAuthority;
  } = {},
) => {
  const environment = dependencies.environment ?? process.env;
  const authority = dependencies.readAuthority ?? readLocalOperatorArtifactAuthority;
  const before = await authority(environment);
  if (before === undefined || !input.sessionId) {
    throw new Error("The private source transport owner is unavailable.");
  }
  const host = new URL(environment.EVE_AGENT_HOST ?? "");
  if (
    host.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(host.hostname) ||
    host.username ||
    host.password ||
    host.pathname !== "/" ||
    host.search ||
    host.hash
  ) {
    throw new Error("The private source transport history requires the local Native host.");
  }
  // Legacy authored workers may retain the local authority without its cycle variable.
  // Recover only the canonical binding inside that same protected authority; never
  // downgrade to an unrelated, unstitched Native history.
  const cycle =
    environment.APP_BUILDER_LOCAL_EVE_CYCLE_FILE ?? path.join(before.stateRoot, "eve-cycle");
  if (path.dirname(cycle) !== before.stateRoot) {
    throw new Error("The private source transport cycle belongs to another owner.");
  }
  const cycleGeneration = readLocalEveCycleBinding(cycle);
  const recovery = createLocalNativeRecovery({
    ...environment,
    APP_BUILDER_LOCAL_EVE_CYCLE_FILE: cycle,
  });
  if (recovery === undefined) {
    throw new Error("The private source transport recovery is unavailable.");
  }
  const lineage = recovery.lineage(input.sessionId);
  // Eve binds ownerRunId to the actual callback workflow, while ownerAnchorRunId
  // is its trusted prepared-session stream anchor. Recovery lineage names anchors,
  // not the later callback workflow. Both fields come only from SessionContext.
  const callbackOwner = input.ownerAnchorRunId ?? input.ownerRunId;
  if (
    (input.ownerAnchorRunId !== undefined &&
      (input.ownerRunId === undefined || input.ownerRunId.length === 0)) ||
    (callbackOwner !== undefined && lineage.at(-1) !== callbackOwner)
  ) {
    throw new Error("The private source transport owner changed.");
  }
  const snapshot =
    dependencies.snapshot ??
    (async (sessionId: string, signal?: AbortSignal) => {
      const native = new Client({ host: host.origin, redirect: "error" });
      const reader = withLocalRecoveredSessions(native, recovery);
      return await reader.sessions.attach(sessionId).snapshot({ signal });
    });
  input.signal?.throwIfAborted();
  const observed = await snapshot(input.sessionId, input.signal);
  input.signal?.throwIfAborted();
  if (
    observed.session.sessionId !== input.sessionId ||
    observed.session.streamIndex !== observed.events.length ||
    !isDeepStrictEqual(before, await authority(environment)) ||
    readLocalEveCycleBinding(cycle) !== cycleGeneration ||
    !isDeepStrictEqual(lineage, recovery.lineage(input.sessionId))
  ) {
    throw new Error("The private source transport history is incomplete or its owner changed.");
  }
  return completedLocalSourceTransport(observed.events, input.expected);
};
