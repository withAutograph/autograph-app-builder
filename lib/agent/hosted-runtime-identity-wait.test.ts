import { describe, expect, it, vi } from "vitest";
import type { WorkflowToolContext } from "eve/tools";
import type { prepareHostedRuntimeStep } from "./prepare-app-hosted-runtime-step";
import { continueHostedRuntimeOwnerPreparation } from "./hosted-runtime-identity-wait";
import type {
  HostedRuntimeIdentityWaitPorts,
  HostedRuntimeIdentityWake,
} from "./hosted-runtime-identity-wait";

const input = {
  appId: "example",
  branch: "feature",
  environment: "preview" as const,
  operationRef: "00000000-0000-4000-8000-000000000001",
  plan: {},
  planDigest: "a".repeat(64),
  projectId: "prj_example",
};
const identityInput = {
  browserUrl: "https://auth.example.test/link",
  expiresAt: "2027-01-01T00:00:00Z",
  operationRef: input.operationRef,
  sessionId: "public-session",
};
const result = {
  appId: input.appId,
  authenticatedBehavior: "unassessed" as const,
  operationRef: input.operationRef,
  status: "auth-schema-prepared" as const,
};
const context: WorkflowToolContext = {
  callId: "approved-call",
  toolName: "prepare-app-hosted-runtime",
  abortSignal: new AbortController().signal,
  ask: () => Promise.reject(new Error("No confirmation is expected")),
  agents: {},
  agent: () => Promise.reject(new Error("No agent call is expected")),
  getToken: () => Promise.reject(new Error("No provider token is expected")),
  requireAuth: () => {
    throw new Error("No provider authorization is expected");
  },
  session: {
    id: "adapter-session",
    auth: { current: null, initiator: null },
    turn: { id: "turn", sequence: 0 },
  },
};

const deferred = <T>() => Promise.withResolvers<T>();
const fixture = (conflict = false) => {
  const callback = deferred<HostedRuntimeIdentityWake>();
  const expiry = deferred<null>();
  const events: string[] = [];
  const dispose = vi.fn(() => {
    events.push("dispose");
  });
  const register = vi.fn<HostedRuntimeIdentityWaitPorts["register"]>(() => {
    events.push("register");
    return Promise.resolve({ status: "waiting" });
  });
  const acknowledge = vi.fn<HostedRuntimeIdentityWaitPorts["acknowledge"]>(() => {
    events.push("acknowledge");
    return Promise.resolve({ status: "consumed", eventId: "canonical-event" });
  });
  const prepare = vi
    .fn<typeof prepareHostedRuntimeStep>()
    .mockResolvedValueOnce({ identityInput, result })
    .mockImplementationOnce(() => {
      events.push("readback");
      return Promise.resolve({ identityInput: null, result: { ...result, status: "prepared" } });
    });
  const ports: HostedRuntimeIdentityWaitPorts = {
    createHook: () => ({
      token: "private-hook-token",
      // oxlint-disable-next-line unicorn/no-thenable, github/no-then -- Model the documented Workflow Hook thenable without invoking its VM runtime.
      then: callback.promise.then.bind(callback.promise),
      getConflict: () => {
        events.push("committed");
        return Promise.resolve(conflict ? {} : null);
      },
      dispose,
    }),
    register,
    acknowledge,
    sleepUntil: vi.fn(async () => {
      await expiry.promise;
    }),
  };
  return { callback, expiry, events, dispose, register, acknowledge, prepare, ports };
};

describe("owner identity continuation", () => {
  it("commits and binds the hook before streaming a link, then resumes the original approval automatically", async () => {
    const f = fixture();
    const generator = continueHostedRuntimeOwnerPreparation(input, context, f.prepare, f.ports);
    expect(await generator.next()).toMatchObject({
      done: false,
      value: { authIdentityLink: identityInput.browserUrl },
    });
    expect(f.events).toEqual(["committed", "register"]);
    expect(f.register).toHaveBeenCalledWith(input, context, {
      token: "private-hook-token",
      identityInput,
    });
    const terminal = generator.next();
    f.callback.resolve({ eventId: "canonical-event" });
    expect(await terminal).toMatchObject({ done: true, value: { status: "prepared" } });
    expect(f.acknowledge).toHaveBeenCalledWith(input, context, { eventId: "canonical-event" });
    expect(f.events).toEqual(["committed", "register", "acknowledge", "dispose", "readback"]);
    expect(f.prepare.mock.calls).toEqual([
      [input, context],
      [input, context],
    ]);
    expect(f.prepare.mock.calls[1]?.[1].session.auth).toBe(context.session.auth);
  });

  it.each(["consumed", "expired"] as const)(
    "re-reads a canonically %s request without showing a stale link",
    async (status) => {
      const f = fixture();
      f.register.mockResolvedValueOnce({ status, eventId: "canonical-event" });
      const generator = continueHostedRuntimeOwnerPreparation(input, context, f.prepare, f.ports);
      expect(await generator.next()).toMatchObject({ done: true, value: { status: "prepared" } });
      expect(f.acknowledge).toHaveBeenCalledWith(input, context, { eventId: "canonical-event" });
      expect(f.ports.sleepUntil).not.toHaveBeenCalled();
    },
  );

  it("asks the server to observe canonical expiry when the timer fires", async () => {
    const f = fixture();
    f.register
      .mockResolvedValueOnce({ status: "waiting" })
      .mockResolvedValueOnce({ status: "expired", eventId: "expired-event" });
    const generator = continueHostedRuntimeOwnerPreparation(input, context, f.prepare, f.ports);
    await generator.next();
    const terminal = generator.next();
    f.expiry.resolve(null);
    await terminal;
    expect(f.acknowledge).toHaveBeenCalledWith(input, context, { eventId: "expired-event" });
    expect(f.register.mock.calls[1]).toEqual(f.register.mock.calls[0]);
    expect(f.ports.sleepUntil).toHaveBeenCalledWith(new Date(identityInput.expiresAt));
  });

  it("recovers consumed proof through short canonical readback when the hook write is lost", async () => {
    const f = fixture();
    const checkAfter = "2026-12-31T23:45:05Z";
    f.register
      .mockResolvedValueOnce({ status: "waiting", checkAfter })
      .mockResolvedValueOnce({ status: "consumed", eventId: "canonical-event" });
    const generator = continueHostedRuntimeOwnerPreparation(input, context, f.prepare, f.ports);
    await generator.next();
    const terminal = generator.next();
    // The hook promise remains pending: the canonical proof became consumed despite lost delivery.
    f.expiry.resolve(null);
    expect(await terminal).toMatchObject({ done: true, value: { status: "prepared" } });
    expect(f.ports.sleepUntil).toHaveBeenCalledOnce();
    expect(f.ports.sleepUntil).toHaveBeenCalledWith(new Date(checkAfter));
    expect(f.ports.sleepUntil).not.toHaveBeenCalledWith(new Date(identityInput.expiresAt));
    expect(f.register.mock.calls[1]).toEqual(f.register.mock.calls[0]);
    expect(f.acknowledge).toHaveBeenCalledWith(input, context, { eventId: "canonical-event" });
    expect(f.events.slice(-3)).toEqual(["acknowledge", "dispose", "readback"]);
  });

  it("uses fresh server deadlines and settles at one canonical read every thirty seconds", async () => {
    const f = fixture();
    const serverTime = Date.parse("2026-12-31T23:45:00Z");
    const seconds = [5, 25, 30, 40, 60, 90, 120];
    for (const second of seconds) {
      f.register.mockResolvedValueOnce({
        status: "waiting",
        checkAfter: new Date(serverTime + second * 1000).toISOString(),
      });
    }
    f.register.mockResolvedValueOnce({ status: "consumed", eventId: "canonical-event" });
    const generator = continueHostedRuntimeOwnerPreparation(input, context, f.prepare, f.ports);
    await generator.next();
    const terminal = generator.next();
    f.expiry.resolve(null);
    await terminal;
    expect(f.ports.sleepUntil).toHaveBeenNthCalledWith(1, new Date(serverTime + 5000));
    // The first read took longer than its old deadline; the fresh server deadline moves it forward.
    expect(f.ports.sleepUntil).toHaveBeenNthCalledWith(2, new Date(serverTime + 25_000));
    expect(f.ports.sleepUntil).toHaveBeenNthCalledWith(3, new Date(serverTime + 35_000));
    expect(f.ports.sleepUntil).toHaveBeenNthCalledWith(4, new Date(serverTime + 55_000));
    expect(f.ports.sleepUntil).toHaveBeenNthCalledWith(5, new Date(serverTime + 85_000));
    expect(f.ports.sleepUntil).toHaveBeenNthCalledWith(6, new Date(serverTime + 115_000));
    expect(f.ports.sleepUntil).toHaveBeenNthCalledWith(7, new Date(serverTime + 145_000));
  });

  it("never treats an event as identity evidence when server acknowledgement rejects it", async () => {
    const f = fixture();
    f.acknowledge.mockRejectedValueOnce(new Error("Canonical event mismatch"));
    const generator = continueHostedRuntimeOwnerPreparation(input, context, f.prepare, f.ports);
    await generator.next();
    const terminal = generator.next();
    f.callback.resolve({ eventId: "wrong-event" });
    await expect(terminal).rejects.toThrow("Canonical event mismatch");
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.dispose).toHaveBeenCalledOnce();
  });

  it("backs off durable expiry observations when server time still reports waiting", async () => {
    const f = fixture();
    f.register
      .mockResolvedValueOnce({ status: "waiting" })
      .mockResolvedValueOnce({ status: "waiting" })
      .mockResolvedValueOnce({ status: "expired", eventId: "expired-event" });
    const generator = continueHostedRuntimeOwnerPreparation(input, context, f.prepare, f.ports);
    await generator.next();
    const terminal = generator.next();
    f.expiry.resolve(null);
    await terminal;
    expect(f.ports.sleepUntil).toHaveBeenNthCalledWith(1, new Date(identityInput.expiresAt));
    expect(f.ports.sleepUntil).toHaveBeenNthCalledWith(
      2,
      new Date(Date.parse(identityInput.expiresAt) + 5000),
    );
    expect(f.register.mock.calls[2]).toEqual(f.register.mock.calls[0]);
  });

  it("rejects a hook conflict before exposing or registering an invitation", async () => {
    const f = fixture(true);
    const generator = continueHostedRuntimeOwnerPreparation(input, context, f.prepare, f.ports);
    await expect(generator.next()).rejects.toThrow("already registered");
    expect(f.register).not.toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledOnce();
  });
});
