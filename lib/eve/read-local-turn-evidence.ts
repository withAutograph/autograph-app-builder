/* oxlint-disable sonarjs/expression-complexity -- Preserve the existing exact owner-only local path and server-origin proof. */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { Client } from "eve/client";
import { z } from "zod";
import { createLocalNativeRecovery, withLocalRecoveredSessions } from "./local-native-recovery";
import { readLocalEveCycleBinding } from "./local-cycle-binding";
import { summarizeNativeTurnExecution } from "./turn-execution-evidence";
import type { NativeTurnSelector } from "./turn-execution-evidence";

const unavailable = () => new Error("local_turn_execution_evidence_unavailable");
const owned = (filename: string, directory: boolean, privateRoot = directory) => {
  const stat = lstatSync(filename);
  if (
    realpathSync(filename) !== filename ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    // oxlint-disable-next-line eslint/no-bitwise -- Explicit owner-only file permission mask.
    (stat.mode & (privateRoot ? 0o077 : 0o022)) !== 0
  ) {
    throw unavailable();
  }
};
/** Observe only an explicitly selected owner-only local instance. There is no send, resume, cancel or provider operation. */
// oxlint-disable-next-line eslint/complexity -- Preserve the maintained exact local owner/path/server/session binding as one read boundary.
export const readLocalOwnedSessionHistory = async (
  input: {
    cycleRoot: string;
    sessionId: string;
    selector?: NativeTurnSelector;
    signal?: AbortSignal;
  },
  dependencies: { client?: Pick<Client, "sessions"> } = {},
) => {
  const root = input.cycleRoot;
  if (
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    !path.basename(root).startsWith("cycle-") ||
    !path.basename(path.dirname(root)).startsWith("supervisor-")
  ) {
    throw unavailable();
  }
  const runs = path.dirname(path.dirname(root));
  if (path.basename(runs) !== "runs") {
    throw unavailable();
  }
  for (const directory of [root, path.dirname(root), runs]) {
    owned(directory, true);
  }
  const stateRoot = path.dirname(runs);
  const cycleFile = path.join(stateRoot, "eve-cycle");
  const generation = readLocalEveCycleBinding(cycleFile);
  const app = path.join(root, "eve-application/source");
  const serverFile = path.join(app, ".eve/dev-server-state.v1.json");
  // The enclosing private directory protects Eve's ordinary server marker file.
  owned(path.dirname(serverFile), true, false);
  const stat = lstatSync(serverFile);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    realpathSync(serverFile) !== serverFile
  ) {
    throw unavailable();
  }
  const marker = z.object({ url: z.url() }).parse(JSON.parse(readFileSync(serverFile, "utf-8")));
  const host = new URL(marker.url);
  if (
    host.protocol !== "http:" ||
    host.hostname !== "127.0.0.1" ||
    host.username ||
    host.password ||
    host.pathname !== "/" ||
    host.search ||
    host.hash ||
    !host.port
  ) {
    throw unavailable();
  }
  const recovery = createLocalNativeRecovery({
    APP_BUILDER_EXECUTION_BUNDLE: "local-development",
    APP_BUILDER_EXECUTION_MODE: "development",
    APP_BUILDER_LOCAL_ADAPTER: "1",
    APP_BUILDER_LOCAL_EVE_CYCLE_FILE: cycleFile,
    EVE_HOSTED_ADAPTER: "0",
  });
  if (recovery === undefined) {
    throw unavailable();
  }
  const lineage = recovery.lineage(input.sessionId);
  const client = dependencies.client ?? new Client({ host: host.origin, redirect: "error" });
  const reader = withLocalRecoveredSessions(client, recovery);
  input.signal?.throwIfAborted();
  const snapshot = await reader.sessions.attach(input.sessionId).snapshot({ signal: input.signal });
  input.signal?.throwIfAborted();
  if (
    snapshot.session.sessionId !== input.sessionId ||
    readLocalEveCycleBinding(cycleFile) !== generation ||
    JSON.stringify(recovery.lineage(input.sessionId)) !== JSON.stringify(lineage)
  ) {
    throw unavailable();
  }
  if (snapshot.events.length !== snapshot.session.streamIndex) {
    throw unavailable();
  }
  return {
    events: snapshot.events,
    nativeCursor: snapshot.session.streamIndex,
    ownerLineage: lineage,
    sessionId: input.sessionId,
  };
};

/** Public diagnostic projection never returns private approval bodies. */
export const readLocalTurnExecutionEvidence = async (
  input: Parameters<typeof readLocalOwnedSessionHistory>[0],
  dependencies: Parameters<typeof readLocalOwnedSessionHistory>[1] = {},
) =>
  summarizeNativeTurnExecution({
    ...(await readLocalOwnedSessionHistory(input, dependencies)),
    selector: input.selector,
  });
