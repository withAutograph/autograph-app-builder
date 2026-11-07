/* oxlint-disable eslint/no-await-in-loop -- Create each owned parent before its child in the real local instance fixture. */
/* oxlint-disable typescript/no-unsafe-type-assertion, sonarjs/no-internal-api-use -- Controlled callback fields and actual installed Eve state qualify a read-only composed history adapter. */
import {
  contextStorage,
  ContextContainer,
} from "../../node_modules/eve/dist/src/context/container.js";
import { developmentExecutionEnvironment } from "../development/execution-environment.mjs";
import { reconcilePrivateApplyDecisions } from "../agent/reconcile-private-apply-decisions";
import {
  requestPrivateApplyApproval,
  recordApprovedPrivateApply,
  readPrivateApplyAuthority,
} from "../agent/private-apply-authority";
import { privateApplyDenialEvents } from "./private-apply-denial.test-fixture";
/* oxlint-disable eslint/require-await -- An actual SDK handle uses only controlled read snapshots in owned local instances. */
import { mkdtemp, mkdir, chmod, writeFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, ClientSession } from "eve/client";
import type { MessageStreamEvent } from "eve/client";
import { readLocalTurnExecutionEvidence } from "./read-local-turn-evidence";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});
const fixture = async (port = 2100) => {
  const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), "builder-turn-evidence-")));
  roots.push(root);
  await chmod(root, 0o700);
  const state = path.join(root, "state");
  const runs = path.join(state, "runs");
  const supervisor = path.join(runs, "supervisor-owned");
  const cycleRoot = path.join(supervisor, "cycle-owned");
  const serverDirectory = path.join(cycleRoot, "eve-application/source/.eve");
  for (const directory of [
    state,
    runs,
    supervisor,
    cycleRoot,
    path.join(cycleRoot, "eve-application"),
    path.join(cycleRoot, "eve-application/source"),
    serverDirectory,
  ]) {
    await mkdir(directory, { mode: 0o700 });
  }
  // Eve's ordinary marker directory need not be private when enclosed by the owner-only instance.
  await chmod(serverDirectory, 0o755);
  const cycleFile = path.join(state, "eve-cycle");
  const serverFile = path.join(serverDirectory, "dev-server-state.v1.json");
  await writeFile(cycleFile, "a".repeat(64), { mode: 0o600 });
  await writeFile(serverFile, JSON.stringify({ url: `http://127.0.0.1:${port}/` }), {
    mode: 0o600,
  });
  const events: MessageStreamEvent[] = [
    {
      type: "turn.started",
      data: { turnId: "turn_1", sequence: 1 },
      meta: { id: "event_started", at: "2026-11-04T00:03:22.960Z" },
    },
    {
      type: "message.received",
      data: { turnId: "turn_1", sequence: 1, message: "private body", parts: [] },
      meta: {
        id: "event_message",
        at: "2026-11-04T00:03:22.986Z",
        deliveryIds: ["delivery_owned"],
      },
    },
  ];
  const snapshot = vi
    .spyOn(ClientSession.prototype, "snapshot")
    .mockImplementation(async function snapshot(this: ClientSession) {
      return { session: { sessionId: this.state.sessionId, streamIndex: events.length }, events };
    });
  const client = new Client({ host: `http://127.0.0.1:${port}` });
  const send = vi.spyOn(ClientSession.prototype, "send");
  const cancel = vi.spyOn(ClientSession.prototype, "cancel");
  const clear = vi.spyOn(ClientSession.prototype, "clear");
  return { root, cycleRoot, cycleFile, serverFile, events, snapshot, client, send, cancel, clear };
};
describe("local execution evidence read path", () => {
  it("observes the exact local accepted turn without submitting any control or changing cursor", async () => {
    const f = await fixture();
    const output = await readLocalTurnExecutionEvidence(
      {
        cycleRoot: f.cycleRoot,
        sessionId: "wrun_owned",
        selector: { deliveryId: "delivery_owned" },
      },
      { client: f.client },
    );
    expect(output).toMatchObject({
      nativeCursor: 2,
      ownerLineage: ["wrun_owned"],
      selectedTurn: { execution: "unexercised", turnId: "turn_1" },
      sessionId: "wrun_owned",
    });
    expect(f.snapshot).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.clear).not.toHaveBeenCalled();
    expect(JSON.stringify(output)).not.toContain("private body");
  });
  it("refuses a cycle changed while reading instead of mixing two instances", async () => {
    const f = await fixture();
    f.snapshot.mockImplementation(async function snapshot(this: ClientSession) {
      await writeFile(f.cycleFile, "b".repeat(64));
      return {
        session: { sessionId: this.state.sessionId, streamIndex: f.events.length },
        events: f.events,
      };
    });
    await expect(
      readLocalTurnExecutionEvidence(
        { cycleRoot: f.cycleRoot, sessionId: "wrun_owned" },
        { client: f.client },
      ),
    ).rejects.toThrow("local_turn_execution_evidence_unavailable");
    expect(f.send).not.toHaveBeenCalled();
  });
  it.each([
    "https://remote.example/",
    "http://127.0.0.1:2100/other",
    "http://user:secret@127.0.0.1:2100/",
  ])("does not read an unbound server %s", async (url) => {
    const f = await fixture();
    await writeFile(f.serverFile, JSON.stringify({ url }));
    await expect(
      readLocalTurnExecutionEvidence(
        { cycleRoot: f.cycleRoot, sessionId: "wrun_owned" },
        { client: f.client },
      ),
    ).rejects.toThrow();
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("retains incomplete-history failures without falling back to a different session", async () => {
    const f = await fixture();
    f.snapshot.mockResolvedValue({
      session: { sessionId: "wrun_foreign", streamIndex: f.events.length + 1 },
      events: f.events,
    });
    await expect(
      readLocalTurnExecutionEvidence(
        { cycleRoot: f.cycleRoot, sessionId: "wrun_owned" },
        { client: f.client },
      ),
    ).rejects.toThrow();
    expect(f.snapshot).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
  });
});

it("composes the real local SDK history reader with exact denied authority catch-up without any session control", async () => {
  const f = await fixture();
  for (const [key, value] of Object.entries(developmentExecutionEnvironment)) {
    vi.stubEnv(key, value);
  }
  vi.stubEnv("APP_BUILDER_DEV_RUNTIME_HOME", path.join(f.cycleRoot, "home"));
  vi.stubEnv("APP_BUILDER_LOCAL_EVE_CYCLE_FILE", f.cycleFile);
  f.events.push(...privateApplyDenialEvents());
  const respond = vi.spyOn(ClientSession.prototype, "respond");
  await contextStorage.run(new ContextContainer(), async () => {
    const old = {
      appId: "app",
      appSpecDigest: "spec",
      proposalDigest: "default-proposal",
      sessionId: "wrun_owned",
      workspaceId: "workspace",
    };
    requestPrivateApplyApproval(old, "denied-call");
    const approved = { ...old, proposalDigest: "approved-compute" };
    requestPrivateApplyApproval(approved, "accepted");
    recordApprovedPrivateApply(approved, "accepted");
    requestPrivateApplyApproval({ ...old, proposalDigest: "unresolved" }, "unresolved-call");
    const controller = new AbortController();
    // SAFETY: The reader consumes only trusted framework session ID and cancellation; session auth is never synthesized or used to dispatch a control.
    await reconcilePrivateApplyDecisions({
      session: { id: "wrun_owned" },
      abortSignal: controller.signal,
    } as Parameters<typeof reconcilePrivateApplyDecisions>[0]);
    expect(readPrivateApplyAuthority().pending.map((row) => row.callId)).toEqual([
      "unresolved-call",
    ]);
    expect(readPrivateApplyAuthority().grant).toEqual(approved);
    expect(readPrivateApplyAuthority().terminalDecisions).toMatchObject([
      { callId: "denied-call", scope: old, requestId: "denied-request", outcome: "denied-not-run" },
    ]);
  });
  expect(f.snapshot).toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
  expect(f.cancel).not.toHaveBeenCalled();
  expect(f.clear).not.toHaveBeenCalled();
  expect(respond).not.toHaveBeenCalled();
});
