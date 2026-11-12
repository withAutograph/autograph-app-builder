import { expect, vi } from "vitest";
import { z } from "zod";
import { createAutographMcpHandler } from "../../mcp/request-handler";
import { eveSessionResultSchema } from "../../mcp/contracts";
import type {
  eveGetInputSchema,
  eveRespondInputSchema,
  eveSendInputSchema,
  eveStartInputSchema,
} from "../../mcp/contracts";
import { hostedEveOperationScopes } from "../hosted-auth";
import { createHostedEveSessionService } from "../hosted-service";
import type { HostedEngineSnapshot, HostedEveTransport } from "../hosted-service";
import { InMemoryHostedEveStore } from "../hosted-store";

const principal = {
  audience: "https://builder.example.test/mcp",
  issuer: "https://builder.example.test/api/auth",
  ownerUserId: "creator",
  scopes: Object.values(hostedEveOperationScopes),
  workspaceId: "workspace",
};
const adapterSessionId = "original-native-session";
const approval = {
  allowFreeform: false,
  kind: "approval" as const,
  requestId: "publish-original-draft",
  title: "Publish the reviewed changes?",
};
const publishedEvent = z.object({
  result: z.object({
    isError: z.literal(false).optional(),
    structuredContent: eveSessionResultSchema,
  }),
});
type PublicRequest =
  | ["autograph_start", z.input<typeof eveStartInputSchema>]
  | ["autograph_get", z.input<typeof eveGetInputSchema>]
  | ["autograph_respond", z.input<typeof eveRespondInputSchema>]
  | ["autograph_send", z.input<typeof eveSendInputSchema>];

/** Real public MCP handler and hosted session journal, with scripted Eve turns. */
export const publicDraftRecovery = (input: {
  approve: (operationId: string) => Promise<string>;
  resume: () => Promise<string>;
}) => {
  let snapshot: HostedEngineSnapshot = {
    events: [{ index: 0, request: approval, type: "input.requested" }],
    status: "input_required",
  };
  const append = (text: string, turnId: string) => {
    snapshot = {
      ...snapshot,
      events: [
        ...snapshot.events,
        { index: snapshot.events.length, text, turnId, type: "assistant.message" },
      ],
      status: "waiting",
    };
  };
  const start = vi
    .fn<HostedEveTransport["start"]>()
    .mockImplementation(async () => await Promise.resolve({ adapterSessionId, snapshot }));
  const respond = vi.fn<HostedEveTransport["respond"]>(async (request) => {
    expect(request.adapterSessionId).toBe(adapterSessionId);
    expect(request.responses).toEqual([
      { requestId: approval.requestId, response: { kind: "approve" } },
    ]);
    const outcome = await input.approve(request.operationId);
    snapshot = {
      ...snapshot,
      events: [
        ...snapshot.events,
        {
          index: snapshot.events.length,
          requestIds: [approval.requestId],
          type: "input.resolved",
        },
      ],
    };
    append(outcome, "publication-turn");
    return snapshot;
  });
  const send = vi.fn<HostedEveTransport["send"]>(async (request) => {
    expect(request.adapterSessionId).toBe(adapterSessionId);
    const deliveryId = `native-${request.operationId}`;
    await request.onAccepted?.(deliveryId);
    const outcome = await input.resume();
    const turnId = `resume-${snapshot.events.length}`;
    append(outcome, turnId);
    snapshot = {
      ...snapshot,
      nativeDeliveryState: {
        turns: [
          {
            boundary: "turn.completed",
            boundaryDeliveryIds: [deliveryId],
            deliveryIds: [deliveryId],
            turnId,
          },
        ],
        version: 1,
      },
    };
    return snapshot;
  });
  const service = createHostedEveSessionService({
    assertSendDeliveryOwner: async (record) => {
      expect(record.principal).toEqual(principal);
      await Promise.resolve();
    },
    principal,
    store: new InMemoryHostedEveStore(),
    transport: {
      start,
      respond,
      send,
      get: async () => await Promise.resolve(snapshot),
      cancel: vi.fn<HostedEveTransport["cancel"]>().mockRejectedValue(new Error("Unexpected Stop")),
    },
  });
  const handler = createAutographMcpHandler(service);
  const call = async (...[name, args]: PublicRequest) => {
    const response = await handler(
      new Request(principal.audience, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: args, name },
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    const data =
      body
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6) ?? body;
    return publishedEvent.parse(JSON.parse(data)).result.structuredContent;
  };
  return { call, respond, send, start };
};
