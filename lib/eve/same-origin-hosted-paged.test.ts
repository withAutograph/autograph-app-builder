import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createSameOriginEveTransport } from "./same-origin-http";
import { createHostedEveSessionService } from "./hosted-service";
import { hostedEveOperationScopes, tenantKeyFor } from "./hosted-auth";
import type { HostedPrincipal } from "./hosted-auth";
import { durableHostedSessionRecordSchema, InMemoryHostedEveStore } from "./hosted-store";
import type {
  HostedEveStore,
  HostedPagedCheckpointMetadata,
  HostedSessionRecord,
} from "./hosted-store";
import type { PublicEveEvent } from "../mcp/contracts";

const question = (requestId: string) => ({
  data: {
    requests: [
      { allowFreeform: true, display: "text", kind: "question", prompt: "Choose", requestId },
    ],
  },
  type: "input.requested",
});
const resolved = (requestId: string) => ({
  data: { resolutions: [{ requestId }] },
  type: "input.resolved",
});
/** Actual native transport/service; provider HTTP and paged storage are faithful local fixture ports. */
it("keeps native and public counters distinct through cold and delta request resolution", async () => {
  const principal: HostedPrincipal = {
    audience: "fixture",
    issuer: "https://identity.example",
    ownerUserId: "owner",
    scopes: Object.values(hostedEveOperationScopes),
    workspaceId: "workspace",
  };
  const native: unknown[] = [
    { data: {}, type: "session.started" },
    { data: {}, type: "session.waiting" },
  ];
  const starts: number[] = [];
  const transport = createSameOriginEveTransport({
    config: { baseUrl: "https://builder.example" },
    fetchImplementation: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (init?.method === "POST") {
        return Response.json(
          { ok: true, sessionId: "wrun_fixture", status: "accepted" },
          { status: 202 },
        );
      }
      const start = Number(url.searchParams.get("startIndex"));
      starts.push(start);
      return await Promise.resolve(
        new Response(
          `${native
            .slice(start)
            .map((event) => JSON.stringify(event))
            .join("\n")}\n`,
          {
            headers: {
              "content-type": "application/x-ndjson",
              "x-eve-session-id": "wrun_fixture",
              "x-eve-stream-format": "ndjson",
              "x-eve-stream-tail-index": String(native.length - 1),
              "x-eve-stream-version": "25",
            },
          },
        ),
      );
    },
    verifyReadAuthority: async (input) =>
      await Promise.resolve(
        input.adapterSessionId === "wrun_fixture" &&
          tenantKeyFor(input.principal) === tenantKeyFor(principal),
      ),
    workloadIdentity: { token: async () => await Promise.resolve("local-fixture-token") },
  });
  const base = new InMemoryHostedEveStore();
  const initial = createHostedEveSessionService({ principal, store: base, transport });
  const started = await initial.start({ clientRequestId: randomUUID(), prompt: "Fixture" });
  let saved: HostedSessionRecord | null = null;
  let metadata: HostedPagedCheckpointMetadata | null = null;
  let events: PublicEveEvent[] = [];
  const store: HostedEveStore = {
    getSession: async (owner, sessionId) =>
      await Promise.resolve(
        tenantKeyFor(owner) === tenantKeyFor(principal)
          ? (saved ?? (await base.getSession(owner, sessionId)))
          : null,
      ),
    listSessions: base.listSessions.bind(base),
    observeSessionPaged: async (input) => {
      const previous = saved ?? (await base.getSession(principal, started.sessionId));
      if (previous?.version !== 2 || previous.checkpointDigest !== input.expectedCheckpointDigest) {
        throw new Error("checkpoint CAS mismatch");
      }
      const staged: PublicEveEvent[] = [];
      for await (const event of input.events) {
        expect(event.index).toBe(staged.length);
        staged.push(event);
      }
      expect(input.metadata.nativeObservationState?.publicEventCount).toBe(staged.length);
      events = staged;
      ({ metadata } = input);
      const { checkpoint: oldInline, ...rest } = previous;
      void oldInline;
      const digest = `sha256:${createHash("sha256").update(JSON.stringify({ events, metadata })).digest("hex")}`;
      saved = durableHostedSessionRecordSchema.parse({
        ...rest,
        checkpointDigest: digest,
        checkpointProgressDigest: digest,
        checkpointRef: { digest, eventCount: events.length, id: randomUUID() },
        resumability: input.resumability,
        stage: input.stage,
        status: input.metadata.status,
        updatedAtEpochMs: input.nowEpochMs,
      });
      return saved;
    },
    readCheckpointPage: async (input) => {
      if (
        saved?.version !== 2 ||
        saved.checkpointRef?.digest !== input.checkpointRef.digest ||
        metadata === null
      ) {
        throw new Error("checkpoint mismatch");
      }
      const page = events.slice(input.cursor, input.cursor + input.limit);
      return await Promise.resolve({
        checkpointDigest: input.checkpointRef.digest,
        cursor: input.cursor + page.length,
        events: page,
        metadata,
        totalEvents: events.length,
      });
    },
    reserveOperation: base.reserveOperation.bind(base),
    settleSucceeded: base.settleSucceeded.bind(base),
    settleUnsuccessful: base.settleUnsuccessful.bind(base),
  };
  const service = createHostedEveSessionService({ principal, store, transport });
  native.push(question("first"), resolved("first"), { data: {}, type: "session.waiting" });
  const cold = await service.get({ cursor: 0, limit: 100, sessionId: started.sessionId });
  expect(cold.error).toBeUndefined();
  expect(cold.status).toBe("waiting");
  expect(cold.inputRequests ?? []).toEqual([]);
  expect(cold.events.map((event) => event.index)).toEqual(cold.events.map((_, index) => index));
  native.push(question("second"));
  const pending = await service.get({
    cursor: cold.cursor,
    limit: 100,
    sessionId: started.sessionId,
  });
  expect(pending.status).toBe("input_required");
  expect(pending.inputRequests?.map((request) => request.requestId)).toEqual(["second"]);
  native.push(resolved("second"), { data: {}, type: "session.waiting" });
  const settled = await service.get({
    cursor: pending.cursor,
    limit: 100,
    sessionId: started.sessionId,
  });
  expect(settled.error).toBeUndefined();
  expect(settled.status).toBe("waiting");
  expect(settled.inputRequests ?? []).toEqual([]);
  expect(events.map((event) => event.index)).toEqual(events.map((_, index) => index));
  expect(events.some((event) => event.type === "input_required")).toBe(true);
  expect(starts.slice(-3)).toEqual([0, 5, 6]);
});
