/* oxlint-disable sonarjs/publicly-writable-directories -- Each disposable fixture is mkdtemp-owned, chmod0700, and removed in finally. */
import { chmod, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { Client, ClientSession } from "eve/client";
import type { InputResponse, MessageStreamEvent } from "eve/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalNativeRecovery, withLocalRecoveredSessions } from "./local-native-recovery";
import {
  nativeRecoveryBindingSchema,
  nativeRecoveryDescriptorSchema,
} from "./native-recovery-contract";
import { z } from "zod";
import { createLocalEveSessionService } from "./service";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});
const failed: MessageStreamEvent = {
  type: "session.failed",
  data: { code: "model_error", message: "Invalid tool schema", sessionId: "wrun_original" },
  meta: { at: "2026-11-03T00:00:00.000Z", id: "failed" },
};
const waiting: MessageStreamEvent = {
  type: "session.waiting",
  data: { continuationToken: "same", wait: "next-user-message" },
  meta: { at: "2026-11-03T00:01:00.000Z", id: "waiting" },
};
const fixture = async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "a469-local-recovery-test-")));
  roots.push(root);
  await chmod(root, 0o700);
  const cycle = path.join(root, "cycle");
  await writeFile(cycle, "a".repeat(64), { mode: 0o600 });
  const environment = {
    APP_BUILDER_EXECUTION_MODE: "development",
    APP_BUILDER_EXECUTION_BUNDLE: "local-development",
    APP_BUILDER_LOCAL_ADAPTER: "1",
    EVE_HOSTED_ADAPTER: "0",
    APP_BUILDER_LOCAL_EVE_CYCLE_FILE: cycle,
  };
  const recovery = createLocalNativeRecovery(environment);
  if (recovery === undefined) {
    throw new Error("Missing local fixture");
  }
  const client = new Client({ host: "http://127.0.0.1:49999" });
  const snapshots = vi
    .spyOn(ClientSession.prototype, "snapshot")
    .mockImplementation(function snapshot(this: ClientSession) {
      const events = this.state.sessionId === "wrun_original" ? [failed] : [waiting];
      return Promise.resolve({
        events,
        session: { sessionId: this.state.sessionId, streamIndex: events.length },
      });
    });
  const requestSchema = z.object({
    recovery: nativeRecoveryDescriptorSchema,
    recoveryPhase: z.literal("activate").optional(),
  });
  const auth = {
    attributes: { "eve:forwarded-by": "local-dev" },
    authenticator: "local-dev",
    principalId: "local-dev",
    principalType: "local-dev",
  };
  const post = vi.fn(async (body: Parameters<Parameters<typeof recovery.recover>[3]>[0]) => {
    const input = requestSchema.parse(body);
    const call = { auth, descriptor: input.recovery };
    await recovery.ports.authorize(call);
    const binding = nativeRecoveryBindingSchema.parse({
      ...input.recovery,
      ownerRunId: "wrun_recovered",
      provenance: {
        checkpointVersion: 1,
        kind: "failed-turn-input",
        sourceEventId: "event_failed_model",
        sourceSlot: 0,
        sourceStepId: "step_failed_model",
      },
    });
    await (input.recoveryPhase === "activate"
      ? recovery.ports.authorizeActivation(call)
      : recovery.ports.commitReceipt({ ...call, recoveryBinding: binding }));
    return { sessionId: binding.ownerRunId, recoveryBinding: binding };
  });
  return { auth, client, cycle, environment, post, recovery, root, snapshots };
};

describe("local native terminal recovery authority", () => {
  it("commits actual protocol receipts without a hosted principal and preserves the original public transcript", async () => {
    const f = await fixture();
    await f.recovery.recover(f.client, "wrun_original", "explicit-resume", f.post);
    expect(f.post).toHaveBeenCalledTimes(2);
    expect(f.recovery.lineage("wrun_original")).toEqual(["wrun_original", "wrun_recovered"]);
    const wrapped = withLocalRecoveredSessions(f.client, f.recovery);
    expect(await wrapped.sessions.attach("wrun_original").snapshot()).toEqual({
      events: [failed, waiting],
      session: { sessionId: "wrun_original", streamIndex: 2 },
    });
    const restarted = createLocalNativeRecovery(f.environment);
    expect(restarted?.lineage("wrun_original")).toEqual(["wrun_original", "wrun_recovered"]);
    const files = await readdir(path.join(f.root, "local-native-recovery"));
    expect(files).toHaveLength(2);
    await Promise.all(
      files.map(async (file) => {
        const bytes = await readFile(path.join(f.root, "local-native-recovery", file), "utf-8");
        expect(bytes).not.toContain("Invalid tool schema");
        expect(bytes).not.toContain("hosted");
      }),
    );
    await f.recovery.recover(f.client, "wrun_original", "retry-explicit-resume", f.post);
    expect(f.post).toHaveBeenCalledTimes(2);
  });
  it("reads both physical histories concurrently and preserves canonical order", async () => {
    const f = await fixture();
    await f.recovery.recover(f.client, "wrun_original", "explicit-resume", f.post);
    const original = Promise.withResolvers<Awaited<ReturnType<ClientSession["snapshot"]>>>();
    const successorStarted = Promise.withResolvers<boolean>();
    f.snapshots.mockImplementation(function snapshot(this: ClientSession) {
      if (this.state.sessionId === "wrun_original") {
        return original.promise;
      }
      successorStarted.resolve(true);
      return Promise.resolve({
        events: [waiting],
        session: { sessionId: "wrun_recovered", streamIndex: 1 },
      });
    });
    const reading = withLocalRecoveredSessions(f.client, f.recovery)
      .sessions.attach("wrun_original")
      .snapshot();
    await successorStarted.promise;
    original.resolve({
      events: [failed],
      session: { sessionId: "wrun_original", streamIndex: 1 },
    });
    expect(await reading).toEqual({
      events: [failed, waiting],
      session: { sessionId: "wrun_original", streamIndex: 2 },
    });
  });

  it.each([
    { sessionId: "wrun_foreign", streamIndex: 1 },
    { sessionId: "wrun_original", streamIndex: 2 },
  ])("rejects an invalid ancestor snapshot ($sessionId, $streamIndex)", async (malformed) => {
    const f = await fixture();
    await f.recovery.recover(f.client, "wrun_original", "explicit-resume", f.post);
    const session = withLocalRecoveredSessions(f.client, f.recovery).sessions.attach(
      "wrun_original",
    );
    f.snapshots.mockImplementation(function snapshot(this: ClientSession) {
      return Promise.resolve(
        this.state.sessionId === "wrun_original"
          ? { events: [failed], session: malformed }
          : { events: [waiting], session: { sessionId: "wrun_recovered", streamIndex: 1 } },
      );
    });
    await expect(session.snapshot()).rejects.toThrow("terminal recovery is unavailable");
  });

  it("validates recovered GET history once when no continuation decision is runnable", async () => {
    const f = await fixture();
    for (const [key, value] of Object.entries(f.environment)) {
      vi.stubEnv(key, value);
    }
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Vitest uses undefined to clear an inherited variable.
    vi.stubEnv("APP_BUILDER_DEV_RUNS_ROOT", undefined);
    await f.recovery.recover(f.client, "wrun_original", "explicit-resume", f.post);
    f.snapshots.mockClear();
    const service = createLocalEveSessionService(withLocalRecoveredSessions(f.client, f.recovery), {
      stateGeneration: f.root,
      isRecoveredSession: (id) => f.recovery.lineage(id).length > 1,
    });

    const get = () => service.get({ cursor: 0, limit: 100, sessionId: "wrun_original" });
    const first = await get();
    expect(first).toMatchObject({ cursor: 3, sessionId: "wrun_original", status: "waiting" });
    expect(f.snapshots).toHaveBeenCalledTimes(2);
    expect(await get()).toEqual(first);
    expect(f.snapshots).toHaveBeenCalledTimes(4);
    expect(f.post).toHaveBeenCalledTimes(2);
  });

  it("recovers only through an explicit public resume and keeps the same public cursor", async () => {
    const f = await fixture();
    const service = createLocalEveSessionService(withLocalRecoveredSessions(f.client, f.recovery), {
      stateGeneration: f.root,
      isRecoveredSession: (id) => f.recovery.lineage(id).length > 1,
      recoverTerminal: async (sessionId, requestId) => {
        await f.recovery.recover(f.client, sessionId, requestId, f.post);
      },
    });
    const original = await service.start({
      resumeSessionId: "wrun_original",
      clientRequestId: "read-only-resume",
    });
    expect(original).toMatchObject({ cursor: 2, sessionId: "wrun_original", status: "failed" });
    expect(f.post).not.toHaveBeenCalled();
    const recovered = await service.start({
      resumeSessionId: "wrun_original",
      resumeMode: "recover",
      clientRequestId: "explicit-public-recovery",
    });
    expect(recovered).toMatchObject({ cursor: 3, sessionId: "wrun_original", status: "waiting" });
    expect(recovered.events[0]).toEqual(original.events[0]);
    expect(f.post).toHaveBeenCalledTimes(2);
  });
  it("refreshes a native recovery tail that arrives after the activation reply", async () => {
    const f = await fixture();
    let childVisible = false;
    f.snapshots.mockImplementation(function snapshot(this: ClientSession) {
      let events: MessageStreamEvent[] = [];
      if (this.state.sessionId === "wrun_original") {
        events = [failed];
      } else if (childVisible) {
        events = [waiting];
      }
      return Promise.resolve({
        events,
        session: { sessionId: this.state.sessionId, streamIndex: events.length },
      });
    });
    const service = createLocalEveSessionService(withLocalRecoveredSessions(f.client, f.recovery), {
      stateGeneration: f.root,
      isRecoveredSession: (id) => f.recovery.lineage(id).length > 1,
      recoverTerminal: async (id, requestId) => {
        await f.recovery.recover(f.client, id, requestId, f.post);
      },
    });
    const initial = await service.start({
      resumeSessionId: "wrun_original",
      resumeMode: "recover",
      clientRequestId: "resume-delayed-tail",
    });
    expect(initial).toMatchObject({ cursor: 2, status: "failed" });
    childVisible = true;
    const current = await service.get({
      cursor: initial.cursor,
      limit: 100,
      sessionId: "wrun_original",
    });
    expect(current).toMatchObject({ cursor: 3, sessionId: "wrun_original", status: "waiting" });
    expect(current.events).toHaveLength(1);
    const readback = await service.get({ cursor: 0, limit: 100, sessionId: "wrun_original" });
    expect(readback.events).toHaveLength(3);
  });
  it("catches up a current native snapshot without replacing an older live reader array", async () => {
    const f = await fixture();
    await f.recovery.recover(f.client, "wrun_original", "recover-live-reader", f.post);
    const childEvents: MessageStreamEvent[] = [waiting];
    f.snapshots.mockImplementation(function snapshot(this: ClientSession) {
      const events = this.state.sessionId === "wrun_original" ? [failed] : [...childEvents];
      return Promise.resolve({
        events,
        session: { sessionId: this.state.sessionId, streamIndex: events.length },
      });
    });
    const { promise: resumed, resolve: finish } = Promise.withResolvers<boolean>();
    const native = withLocalRecoveredSessions(f.client, f.recovery);
    const service = createLocalEveSessionService(
      {
        sessions: {
          create: native.sessions.create,
          attach: (id, options) => ({
            ...native.sessions.attach(id, options),
            send: () =>
              Promise.resolve({
                cancel: () => Promise.resolve(),
                async *[Symbol.asyncIterator]() {
                  const interim = { ...waiting, meta: { ...waiting.meta, id: "interim-wait" } };
                  childEvents.push(interim);
                  yield interim;
                  await resumed;
                  const completed = { ...waiting, meta: { ...waiting.meta, id: "final-wait" } };
                  yield completed;
                },
              }),
          }),
        },
      },
      { stateGeneration: f.root, isRecoveredSession: (id) => f.recovery.lineage(id).length > 1 },
    );
    await service.start({ resumeSessionId: "wrun_original", clientRequestId: "read-reader" });
    await service.send({
      sessionId: "wrun_original",
      clientRequestId: "new-reader-message",
      message: "Continue",
    });
    await vi.waitFor(() => {
      expect(childEvents).toHaveLength(2);
    });
    const completed = { ...waiting, meta: { ...waiting.meta, id: "final-wait" } };
    childEvents.push(completed);
    const caughtUp = await service.get({ cursor: 0, limit: 100, sessionId: "wrun_original" });
    expect(caughtUp.events).toHaveLength(5);
    expect(caughtUp.cursor).toBe(5);
    finish(true);
    await vi.waitFor(async () => {
      const result = await service.get({ cursor: 0, limit: 100, sessionId: "wrun_original" });
      expect(result.events).toHaveLength(5);
    });
    const tail = await service.get({ cursor: 5, limit: 100, sessionId: "wrun_original" });
    expect(tail.events).toEqual([]);
    expect(tail.cursor).toBe(5);
  });
  it("shows and answers the current batch while the previous response reader is still open", async () => {
    const f = await fixture();
    await f.recovery.recover(f.client, "wrun_original", "recover-current-batch", f.post);
    const question = (id: string): MessageStreamEvent => ({
      type: "input.requested",
      data: {
        sequence: 1,
        stepIndex: 1,
        turnId: "turn-current",
        requests: [
          {
            kind: "question",
            requestId: id,
            prompt: "Continue?",
            allowFreeform: true,
            action: {
              kind: "tool-call",
              callId: `${id}-call`,
              toolName: "ask_question",
              input: {},
            },
          },
        ],
      },
      meta: { ...waiting.meta, id },
    });
    const resolution = (id: string): MessageStreamEvent => ({
      type: "input.resolved",
      data: {
        sequence: 2,
        stepIndex: 1,
        turnId: "turn-current",
        resolutions: [{ kind: "question", requestId: id, outcome: "answered" }],
      },
      meta: { ...waiting.meta, id: `${id}-resolved` },
    });
    const childEvents = [waiting, question("old-input")];
    f.snapshots.mockImplementation(function snapshot(this: ClientSession) {
      const events = this.state.sessionId === "wrun_original" ? [failed] : [...childEvents];
      return Promise.resolve({
        events,
        session: { sessionId: this.state.sessionId, streamIndex: events.length },
      });
    });
    const { promise: oldReader, resolve: finishOldReader } = Promise.withResolvers<boolean>();
    const respond = vi.fn((_input: readonly InputResponse[]) =>
      Promise.resolve({
        cancel: () => Promise.resolve(),
        async *[Symbol.asyncIterator]() {
          if (respond.mock.calls.length === 1) {
            const started: MessageStreamEvent = {
              type: "step.started",
              data: { modelId: "test", sequence: 1, stepIndex: 1, turnId: "turn-current" },
              meta: { ...waiting.meta, id: "started" },
            };
            childEvents.push(started);
            yield started;
            await oldReader;
            yield resolution("old-input");
            yield question("new-input");
          } else {
            childEvents.push(resolution("new-input"));
            const done = { ...waiting, meta: { ...waiting.meta, id: "done" } };
            childEvents.push(done);
            yield resolution("new-input");
            yield done;
          }
        },
      }),
    );
    const native = withLocalRecoveredSessions(f.client, f.recovery);
    const cancel = vi.fn(() =>
      Promise.resolve({ sessionId: "wrun_original", status: "accepted" as const }),
    );
    const service = createLocalEveSessionService(
      {
        sessions: {
          create: native.sessions.create,
          attach: (id, options) => ({ ...native.sessions.attach(id, options), respond, cancel }),
        },
      },
      { stateGeneration: f.root, isRecoveredSession: () => true, modelTurnTimeoutMs: 200 },
    );
    await service.get({ cursor: 0, limit: 100, sessionId: "wrun_original" });
    await service.respond({
      sessionId: "wrun_original",
      clientRequestId: "answer-old-once",
      responses: [{ requestId: "old-input", response: { kind: "answer", value: "Yes" } }],
    });
    await vi.waitFor(() => {
      expect(childEvents.at(-1)?.type).toBe("step.started");
    });
    childEvents.push(resolution("old-input"), question("new-input"));
    const current = await service.get({ cursor: 0, limit: 100, sessionId: "wrun_original" });
    expect(current.inputRequests?.map((entry) => entry.requestId)).toEqual(["new-input"]);
    await delay(250);
    expect(cancel).not.toHaveBeenCalled();
    await service.respond({
      sessionId: "wrun_original",
      clientRequestId: "answer-new-once",
      responses: [{ requestId: "new-input", response: { kind: "answer", value: "Yes" } }],
    });
    await vi.waitFor(async () => {
      const result = await service.get({ cursor: 0, limit: 100, sessionId: "wrun_original" });
      expect(result.inputRequests ?? []).toEqual([]);
      expect(result.status).toBe("waiting");
    });
    const settled = await service.get({ cursor: 0, limit: 100, sessionId: "wrun_original" });
    finishOldReader(true);
    await vi.waitFor(async () => {
      const result = await service.get({ cursor: 0, limit: 100, sessionId: "wrun_original" });
      expect(result.inputRequests ?? []).toEqual([]);
      expect(result.cursor).toBe(settled.cursor);
    });
    expect(respond).toHaveBeenCalledTimes(2);
    expect(respond.mock.calls.map(([input]) => input)).toEqual([
      [{ requestId: "old-input", text: "Yes" }],
      [{ requestId: "new-input", text: "Yes" }],
    ]);
    expect(f.post).toHaveBeenCalledTimes(2);
  });
  it("hydrates recovered history before a fresh-process send", async () => {
    const f = await fixture();
    await f.recovery.recover(f.client, "wrun_original", "recover-before-send", f.post);
    const native = withLocalRecoveredSessions(f.client, f.recovery);
    const cursors: number[] = [];
    const service = createLocalEveSessionService(
      {
        sessions: {
          create: native.sessions.create,
          attach: (id, options) => ({
            ...native.sessions.attach(id, options),
            send: () => {
              cursors.push(options?.streamIndex ?? 0);
              return Promise.resolve({
                cancel: () => Promise.resolve(),
                async *[Symbol.asyncIterator]() {
                  yield { ...waiting, meta: { ...waiting.meta, id: "new-delivery-wait" } };
                },
              });
            },
          }),
        },
      },
      { stateGeneration: f.root, isRecoveredSession: () => true },
    );
    await service.send({
      sessionId: "wrun_original",
      clientRequestId: "fresh-process",
      message: "Continue",
    });
    expect(cursors).toEqual([2]);
  });
  it("reconciles an unchanged delivery-only cache from canonical native history", async () => {
    const f = await fixture();
    await f.recovery.recover(f.client, "wrun_original", "recover-fragment", f.post);
    const native = withLocalRecoveredSessions(f.client, f.recovery);
    let recovered = false;
    const service = createLocalEveSessionService(
      {
        sessions: {
          create: native.sessions.create,
          attach: (id, options) => ({
            ...native.sessions.attach(id, options),
            send: () =>
              Promise.resolve({
                cancel: () => Promise.resolve(),
                async *[Symbol.asyncIterator]() {
                  yield waiting;
                },
              }),
          }),
        },
      },
      { stateGeneration: f.root, isRecoveredSession: () => recovered },
    );
    await service.send({
      sessionId: "wrun_original",
      clientRequestId: "old-fragment",
      message: "Continue",
    });
    await vi.waitFor(async () => {
      const current = await service.get({ cursor: 0, limit: 100, sessionId: "wrun_original" });
      expect(current.status).toBe("waiting");
    });
    recovered = true;
    const result = await service.get({ cursor: 0, limit: 100, sessionId: "wrun_original" });
    expect(result).toMatchObject({ cursor: 3, status: "waiting" });
    expect(result.error).toBeUndefined();
    expect(result.events[0]).toMatchObject({ code: "model_error", type: "error" });
    expect(f.post).toHaveBeenCalledTimes(2);
  });
  it("clears an unavailable read projection only after canonical recovery readback", async () => {
    const f = await fixture();
    await f.recovery.recover(f.client, "wrun_original", "recover-readback", f.post);
    const good = f.snapshots.getMockImplementation();
    if (good === undefined) {
      throw new Error("Missing snapshot fixture");
    }
    f.snapshots.mockImplementation(function snapshot(this: ClientSession) {
      return Promise.resolve({
        events: [],
        session: { sessionId: this.state.sessionId, streamIndex: 0 },
      });
    });
    const service = createLocalEveSessionService(withLocalRecoveredSessions(f.client, f.recovery), {
      stateGeneration: f.root,
      isRecoveredSession: () => true,
    });
    expect(await service.get({ cursor: 0, limit: 100, sessionId: "wrun_original" })).toMatchObject({
      error: { code: "session_recovery_unavailable" },
    });
    f.snapshots.mockImplementation(good);
    const restored = await service.get({ cursor: 0, limit: 100, sessionId: "wrun_original" });
    expect(restored).toMatchObject({ cursor: 3, status: "waiting" });
    expect(restored.error).toBeUndefined();
    expect(f.post).toHaveBeenCalledTimes(2);
  });
  it("rejects retained-event substitution instead of repairing its cache", async () => {
    const f = await fixture();
    await f.recovery.recover(f.client, "wrun_original", "recover-conflict", f.post);
    const service = createLocalEveSessionService(withLocalRecoveredSessions(f.client, f.recovery), {
      stateGeneration: f.root,
      isRecoveredSession: () => true,
    });
    await service.get({ cursor: 0, limit: 100, sessionId: "wrun_original" });
    f.snapshots.mockImplementation(function snapshot(this: ClientSession) {
      const events =
        this.state.sessionId === "wrun_original"
          ? [{ ...failed, data: { ...failed.data, message: "changed" } }]
          : [waiting];
      return Promise.resolve({
        events,
        session: { sessionId: this.state.sessionId, streamIndex: events.length },
      });
    });
    const rejected = await service.get({ cursor: 0, limit: 100, sessionId: "wrun_original" });
    expect(rejected).toMatchObject({
      error: { code: "session_recovery_unavailable" },
      status: "failed",
    });
    expect(f.post).toHaveBeenCalledTimes(2);
  });
  it("dispatches controls to the logical session and observes only the accepted physical delivery", async () => {
    const f = await fixture();
    await f.recovery.recover(f.client, "wrun_original", "recover-controls", f.post);
    const post = vi.fn<NonNullable<Parameters<typeof withLocalRecoveredSessions>[2]>>((logicalId) =>
      Promise.resolve({ sessionId: logicalId, deliveryId: "delivery-mine" }),
    );
    const physicalReads: string[] = [];
    vi.spyOn(ClientSession.prototype, "stream").mockImplementation(
      async function* physicalStream(this: ClientSession) {
        physicalReads.push(this.state.sessionId);
        yield {
          ...waiting,
          meta: { ...waiting.meta, id: "unrelated", deliveryIds: ["delivery-other"] },
        };
        yield {
          ...waiting,
          meta: { ...waiting.meta, id: "accepted", deliveryIds: ["delivery-mine"] },
        };
      },
    );
    const cancellations: string[] = [];
    vi.spyOn(ClientSession.prototype, "cancel").mockImplementation(
      function cancel(this: ClientSession) {
        cancellations.push(this.state.sessionId);
        return Promise.resolve({ sessionId: this.state.sessionId, status: "accepted" });
      },
    );
    const session = withLocalRecoveredSessions(f.client, f.recovery, post).sessions.attach(
      "wrun_original",
      { streamIndex: 2 },
    );
    f.snapshots.mockClear();
    const response = await session.send("New message", { turnPolicy: "queue" });
    expect(
      f.snapshots.mock.contexts.map((context) =>
        context instanceof ClientSession ? context.state.sessionId : null,
      ),
    ).toEqual(["wrun_original"]);
    const events: MessageStreamEvent[] = [];
    for await (const event of response) {
      events.push(event);
    }
    expect(post).toHaveBeenCalledWith("wrun_original", {
      message: "New message",
      turnPolicy: "queue",
    });
    expect(physicalReads).toEqual(["wrun_recovered"]);
    expect(events.map((event) => event.meta.id)).toEqual(["accepted"]);
    await session.cancel();
    expect(cancellations).toEqual(["wrun_original"]);
    f.snapshots.mockClear();
    const approved = await session.respond([{ requestId: "current-input", optionId: "approve" }]);
    expect(
      f.snapshots.mock.contexts.map((context) =>
        context instanceof ClientSession ? context.state.sessionId : null,
      ),
    ).toEqual(["wrun_original"]);
    for await (const event of approved) {
      expect(event.meta.id).toBe("accepted");
    }
    expect(post).toHaveBeenLastCalledWith("wrun_original", {
      inputResponses: [{ optionId: "approve", requestId: "current-input" }],
    });
  });
  it("rejects a control receipt naming a different logical session", async () => {
    const f = await fixture();
    await f.recovery.recover(f.client, "wrun_original", "recover-wrong-control", f.post);
    const post = vi.fn<NonNullable<Parameters<typeof withLocalRecoveredSessions>[2]>>(() =>
      Promise.resolve({ sessionId: "foreign-logical-session", deliveryId: "foreign-delivery" }),
    );
    const session = withLocalRecoveredSessions(f.client, f.recovery, post).sessions.attach(
      "wrun_original",
      { streamIndex: 2 },
    );
    await expect(session.send("New message")).rejects.toThrow();
  });
  it("does not create reservations for an active or cancelled source", async () => {
    const f = await fixture();
    f.snapshots.mockResolvedValue({
      events: [waiting],
      session: { sessionId: "wrun_original", streamIndex: 1 },
    });
    await expect(f.recovery.recover(f.client, "wrun_original", "resume", f.post)).rejects.toThrow();
    expect(f.post).not.toHaveBeenCalled();
  });
  it("retains a failed submission reservation and uses its exact operation on explicit recovery", async () => {
    const f = await fixture();
    const failedPost = vi.fn<Parameters<typeof f.recovery.recover>[3]>(() =>
      Promise.reject(new Error("connection lost")),
    );
    await expect(
      f.recovery.recover(f.client, "wrun_original", "first", failedPost),
    ).rejects.toThrow("connection lost");
    const reserved = failedPost.mock.calls[0]?.[0].recovery.operationId;
    await f.recovery.recover(f.client, "wrun_original", "new-explicit-resume", f.post);
    expect(f.post.mock.calls[0]?.[0].recovery.operationId).toBe(reserved);
  });
  it("cancellation during preparation revokes the frozen local recovery epoch", async () => {
    const f = await fixture();
    const post = vi.fn<Parameters<typeof f.recovery.recover>[3]>(async (body) => {
      await f.recovery.cancel("wrun_original");
      return await f.post(body);
    });
    await expect(
      f.recovery.recover(f.client, "wrun_original", "resume-race", post),
    ).rejects.toThrow();
    expect(post.mock.calls[0]?.[0].recovery.parentCancellationRevision).toBe(0);
    expect(f.recovery.lineage("wrun_original")).toEqual(["wrun_original"]);
    await expect(
      f.recovery.recover(f.client, "wrun_original", "later-resume", f.post),
    ).rejects.toThrow();
  });
  it("cancellation after canonical preparation prevents activation", async () => {
    const f = await fixture();
    const post = vi.fn<Parameters<typeof f.recovery.recover>[3]>(async (body) => {
      if (body.recoveryPhase === "activate") {
        await f.recovery.cancel("wrun_original");
      }
      return await f.post(body);
    });
    await expect(
      f.recovery.recover(f.client, "wrun_original", "cancel-before-activate", post),
    ).rejects.toThrow();
    const descriptor = post.mock.calls[0]?.[0].recovery;
    if (descriptor === undefined) {
      throw new Error("Missing reservation");
    }
    await expect(
      f.recovery.ports.authorizeActivation({ auth: f.auth, descriptor }),
    ).rejects.toThrow();
  });
  it("denies a foreign principal even with an exact reserved descriptor", async () => {
    const f = await fixture();
    const fail = vi.fn<Parameters<typeof f.recovery.recover>[3]>(() =>
      Promise.reject(new Error("offline")),
    );
    await expect(f.recovery.recover(f.client, "wrun_original", "resume", fail)).rejects.toThrow();
    const descriptor = fail.mock.calls[0]?.[0].recovery;
    if (descriptor === undefined) {
      throw new Error("Missing reservation");
    }
    expect(() =>
      f.recovery.ports.authorize({
        auth: { ...f.auth, principalType: "user", principalId: "customer" },
        descriptor,
      }),
    ).toThrow();
    expect(
      f.recovery.trustForwarder(f.auth, {
        principal: { current: { ...f.auth, principalId: "customer" } },
      }),
    ).toBe(false);
  });
  it("rejects a forged acceptance without a canonical native receipt", async () => {
    const f = await fixture();
    const forged = vi.fn<Parameters<typeof f.recovery.recover>[3]>((body) =>
      Promise.resolve({
        sessionId: "wrun_forged",
        recoveryBinding: nativeRecoveryBindingSchema.parse({
          ...body.recovery,
          ownerRunId: "wrun_forged",
          provenance: {
            checkpointVersion: 1,
            kind: "failed-turn-input",
            sourceEventId: "event",
            sourceSlot: 0,
            sourceStepId: "step",
          },
        }),
      }),
    );
    await expect(f.recovery.recover(f.client, "wrun_original", "resume", forged)).rejects.toThrow();
    expect(f.recovery.lineage("wrun_original")).toEqual(["wrun_original"]);
  });
  it("does not expose this authority in hosted mode or from a non-private cycle", async () => {
    const f = await fixture();
    expect(
      createLocalNativeRecovery({ ...f.environment, EVE_HOSTED_ADAPTER: "1" }),
    ).toBeUndefined();
    await chmod(f.cycle, 0o644);
    expect(() => f.recovery.lineage("wrun_original")).toThrow();
  });
});
