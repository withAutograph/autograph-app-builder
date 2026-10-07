import { describe, expect, it, vi } from "vitest";
import { hostedEveOperationScopes } from "../eve/hosted-auth";
import {
  durableHostedSessionRecordSchema,
  hostedSessionRecordSchema,
  InMemoryHostedEveStore,
  toDurableHostedSessionRecord,
} from "../eve/hosted-store";
import type { HostedSessionRecord } from "../eve/hosted-store";
import { createHostedEveSessionService } from "../eve/hosted-service";
import type { HostedEveTransport } from "../eve/hosted-service";
import { builderHandoffRecordSchema } from "../handoff/contracts";
import type { BuilderHandoffRecord } from "../handoff/contracts";
import { createHostedOperatorClient } from "./hosted-operator-client";
import { createHostedOperatorOwnerContextResolver } from "./hosted-operator-owner-context";

const handoffId = "123e4567-e89b-42d3-a456-426614174001";
const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "user_1",
  workspaceId: "workspace_1",
};
const principal = {
  ...authority,
  scopes: Object.values(hostedEveOperationScopes),
};
const sessionAuthFor = (sourceId?: string) => {
  const attributes = () => {
    const common = {
      "mcp:audience": authority.audience,
      "mcp:scopes": principal.scopes,
      "mcp:workspace-id": authority.workspaceId,
    };
    if (sourceId === undefined) {
      return common;
    }
    return { "autograph:source-handoff-id": sourceId, ...common };
  };
  return {
    current: {
      attributes: attributes(),
      authenticator: "mcp-oauth-jwks",
      issuer: authority.issuer,
      principalId: principal.ownerUserId,
      principalType: "user",
      subject: principal.ownerUserId,
    },
    initiator: {
      attributes: attributes(),
      authenticator: "mcp-oauth-jwks",
      issuer: authority.issuer,
      principalId: principal.ownerUserId,
      principalType: "user",
      subject: principal.ownerUserId,
    },
  };
};
const sessionAuth = sessionAuthFor(handoffId);
const directSessionAuth = sessionAuthFor();
const handoff: BuilderHandoffRecord = builderHandoffRecordSchema.parse({
  authority,
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
  creationRequestId: "123e4567-e89b-42d3-a456-426614174002",
  expiresAt: new Date("2026-10-02T00:00:00.000Z"),
  handoffId,
  intent: {
    appId: "sample-app",
    appName: "Sample app",
    brief: "Build a sample app",
    connections: [],
    modelId: "openai/gpt-5.6-terra",
    repository: { private: true, requestedName: "sample-app" },
  },
  redeemedAt: new Date("2026-10-01T01:00:00.000Z"),
  requestDigest: "a".repeat(64),
  sessionId: "public-session-1",
  version: 1,
});
const session: HostedSessionRecord = durableHostedSessionRecordSchema.parse({
  adapterGeneration: 7,
  adapterSessionId: "adapter-current",
  createdAtEpochMs: 1000,
  lastProgressAtEpochMs: 1000,
  originAdapterSessionId: "adapter-origin",
  principal,
  resumability: "live",
  sessionId: "public-session-1",
  sourceHandoffId: handoffId,
  stage: "prototype",
  status: "waiting",
  title: "Sample app",
  updatedAtEpochMs: 1000,
  version: 2,
});
const legacySession: HostedSessionRecord = hostedSessionRecordSchema.parse({
  adapterSessionId: "adapter-current",
  createdAtEpochMs: 1000,
  principal,
  sessionId: "public-session-1",
  status: "waiting",
  updatedAtEpochMs: 1000,
  version: 1,
});
const directSessionRecord = () => {
  const direct = toDurableHostedSessionRecord(session);
  delete direct.sourceHandoffId;
  return direct;
};

const fixture = (
  overrides: {
    handoff?: BuilderHandoffRecord | null;
    session?: HostedSessionRecord;
    isActiveMember?: boolean;
  } = {},
) => {
  const handoffs = {
    read: vi.fn(async () => {
      const result = await Promise.resolve(
        overrides.handoff === null ? undefined : (overrides.handoff ?? handoff),
      );
      return result;
    }),
  };
  const sessions = {
    getSession: vi.fn(async () => {
      const result = await Promise.resolve(overrides.session ?? session);
      return result;
    }),
    getSessionByAdapterSessionId: vi.fn(async () => {
      const result = await Promise.resolve(overrides.session ?? session);
      return result;
    }),
  };
  const resolver = createHostedOperatorOwnerContextResolver({
    audience: authority.audience,
    handoffs,
    isActiveMember: async () => {
      const result = await Promise.resolve(overrides.isActiveMember ?? true);
      return result;
    },
    issuer: authority.issuer,
    sessions,
  });
  return { handoffs, resolver, sessions };
};

describe("hosted operator owner context", () => {
  it("maps the authenticated source handoff to its current durable public session", async () => {
    const f = fixture();
    await expect(
      f.resolver({
        adapterSessionId: "adapter-current",
        authority,
        principal,
        sessionAuth,
      }),
    ).resolves.toMatchObject({
      adapterGeneration: 7,
      adapterSessionId: "adapter-current",
      kind: "handoff",
      sessionId: "public-session-1",
      sourceHandoffId: handoffId,
    });
    expect(f.handoffs.read).toHaveBeenCalledWith({ authority, handoffId });
    expect(f.sessions.getSession).toHaveBeenCalledWith(principal, "public-session-1");
  });

  it("maps a direct public start through the exact tenant-scoped adapter index", async () => {
    const directSession: HostedSessionRecord = directSessionRecord();
    const f = fixture({ session: directSession });
    await expect(
      f.resolver({
        adapterSessionId: "adapter-current",
        authority,
        principal,
        sessionAuth: directSessionAuth,
      }),
    ).resolves.toMatchObject({
      adapterGeneration: 7,
      adapterSessionId: "adapter-current",
      kind: "direct",
      sessionId: "public-session-1",
    });
    expect(f.sessions.getSessionByAdapterSessionId).toHaveBeenCalledWith(
      principal,
      "adapter-current",
    );
    expect(f.handoffs.read).not.toHaveBeenCalled();
  });

  it("resolves a real public prompt start without fabricating a handoff", async () => {
    const store = new InMemoryHostedEveStore();
    const transport: HostedEveTransport = {
      cancel: async () => {
        await Promise.resolve();
        return { events: [], status: "waiting" };
      },
      get: async () => {
        await Promise.resolve();
        return { events: [], status: "waiting" };
      },
      respond: async () => {
        await Promise.resolve();
        return { events: [], status: "waiting" };
      },
      send: async () => {
        await Promise.resolve();
        return { events: [], status: "waiting" };
      },
      start: async () => {
        await Promise.resolve();
        return {
          adapterSessionId: "adapter-direct-start",
          snapshot: { events: [], status: "waiting" },
        };
      },
    };
    const service = createHostedEveSessionService({ principal, store, transport });
    const started = await service.start({
      clientRequestId: "direct-start",
      prompt: "Build an app",
    });
    const handoffs = {
      read: vi.fn(async (): Promise<BuilderHandoffRecord | undefined> => {
        await Promise.resolve();
        return new Map<string, BuilderHandoffRecord>().get("missing-handoff");
      }),
    };
    const resolver = createHostedOperatorOwnerContextResolver({
      audience: authority.audience,
      handoffs,
      isActiveMember: async () => {
        await Promise.resolve();
        return true;
      },
      issuer: authority.issuer,
      sessions: store,
    });
    const resolved = await resolver({
      adapterSessionId: "adapter-direct-start",
      authority,
      principal,
      sessionAuth: directSessionAuth,
    });
    const durable = await store.getSessionByAdapterSessionId?.(principal, "adapter-direct-start");
    expect(durable).toMatchObject({
      sessionId: started.sessionId,
      version: 2,
    });
    expect(durable).not.toHaveProperty("sourceHandoffId");
    expect(resolved).toMatchObject({
      adapterSessionId: "adapter-direct-start",
      kind: "direct",
      sessionId: started.sessionId,
    });
    expect(resolved).not.toHaveProperty("sourceHandoffId");
    expect(handoffs.read).not.toHaveBeenCalled();
    if (resolved === null) {
      throw new Error("Expected direct-start owner context.");
    }
    let captured: Request | undefined;
    const client = createHostedOperatorClient({
      endpoint: "https://operator.example",
      fetch: async (input, init) => {
        await Promise.resolve();
        captured = new Request(input, init);
        return Response.json({
          appId: "sample-app",
          authenticatedBehavior: "unassessed",
          status: "pending",
        });
      },
      ownerContext: resolved,
      token: async () => {
        await Promise.resolve();
        return "operator-workload-token";
      },
    });
    await client.request({
      action: "status",
      operationRef: "123e4567-e89b-42d3-a456-426614174003",
      selection: {
        appId: "sample-app",
        branch: "main",
        environment: "preview",
        projectId: "project-1",
        sessionId: resolved.sessionId,
      },
    });
    await expect(captured?.json()).resolves.toMatchObject({
      ownerContext: { kind: "direct" },
    });
  });

  it("rejects direct lookup rows that are stale, cross-owner, legacy, or handoff-bound", async () => {
    const directSession = directSessionRecord();
    await Promise.all(
      [
        { ...directSession, adapterSessionId: "adapter-old" },
        { ...directSession, principal: { ...principal, ownerUserId: "other-user" } },
        legacySession,
        session,
      ].map(async (invalidSession) => {
        await expect(
          fixture({ session: invalidSession }).resolver({
            adapterSessionId: "adapter-current",
            authority,
            principal,
            sessionAuth: directSessionAuth,
          }),
        ).rejects.toMatchObject({ code: "authorization_required" });
      }),
    );
  });

  it("rejects stale SDK adapters, unbound handoffs, and inactive membership", async () => {
    await expect(
      fixture().resolver({
        adapterSessionId: "adapter-replaced",
        authority,
        principal,
        sessionAuth,
      }),
    ).rejects.toMatchObject({ code: "authorization_required" });
    const unbound = fixture({ handoff: null });
    await expect(
      unbound.resolver({
        adapterSessionId: "adapter-current",
        authority,
        principal,
        sessionAuth,
      }),
    ).rejects.toMatchObject({ code: "authorization_required" });
    expect(unbound.sessions.getSessionByAdapterSessionId).not.toHaveBeenCalled();
    await expect(
      fixture({ isActiveMember: false }).resolver({
        adapterSessionId: "adapter-current",
        authority,
        principal,
        sessionAuth,
      }),
    ).rejects.toMatchObject({ code: "authorization_required" });
  });

  it("rejects a durable row whose source handoff or principal does not match", async () => {
    await expect(
      fixture({
        session: {
          ...session,
          sourceHandoffId: "123e4567-e89b-42d3-a456-426614174099",
        },
      }).resolver({
        adapterSessionId: "adapter-current",
        authority,
        principal,
        sessionAuth,
      }),
    ).rejects.toMatchObject({ code: "authorization_required" });
    await expect(
      fixture({
        session: {
          ...session,
          principal: { ...principal, ownerUserId: "other-user" },
        },
      }).resolver({
        adapterSessionId: "adapter-current",
        authority,
        principal,
        sessionAuth,
      }),
    ).rejects.toMatchObject({ code: "authorization_required" });
  });

  it("does not downgrade a real handoff to direct when its durable row lacks that binding", async () => {
    const directSession: HostedSessionRecord = directSessionRecord();
    const f = fixture({ session: directSession });
    await expect(
      f.resolver({
        adapterSessionId: "adapter-current",
        authority,
        principal,
        sessionAuth,
      }),
    ).rejects.toMatchObject({ code: "authorization_required" });
    expect(f.sessions.getSessionByAdapterSessionId).not.toHaveBeenCalled();
  });

  it("normalizes a bound legacy session without changing its runtime journal", async () => {
    await expect(
      fixture({ session: legacySession }).resolver({
        adapterSessionId: "adapter-current",
        authority,
        principal,
        sessionAuth,
      }),
    ).resolves.toMatchObject({
      adapterGeneration: 1,
      adapterSessionId: "adapter-current",
      sessionId: "public-session-1",
      sourceHandoffId: handoffId,
    });
  });

  it("sends only resolved owner claims with the operator workload token", async () => {
    const resolved = await fixture().resolver({
      adapterSessionId: "adapter-current",
      authority,
      principal,
      sessionAuth,
    });
    if (resolved === null) {
      throw new Error("Expected forwarded handoff owner context.");
    }
    let captured: Request | undefined;
    const client = createHostedOperatorClient({
      endpoint: "https://operator.example",
      fetch: async (input, init) => {
        captured = new Request(input, init);
        const response = await Promise.resolve(
          Response.json({
            appId: "sample-app",
            authenticatedBehavior: "unassessed",
            status: "pending",
          }),
        );
        return response;
      },
      ownerContext: resolved,
      token: async () => {
        const token = await Promise.resolve("operator-workload-token");
        return token;
      },
    });
    await client.request({
      action: "status",
      operationRef: "123e4567-e89b-42d3-a456-426614174003",
      selection: {
        appId: "sample-app",
        branch: "main",
        environment: "preview",
        projectId: "project-1",
        sessionId: resolved.sessionId,
      },
    });
    expect(captured?.headers.get("authorization")).toBe("Bearer operator-workload-token");
    await expect(captured?.json()).resolves.toMatchObject({
      ownerContext: resolved,
    });
    expect(JSON.stringify(captured?.headers)).not.toContain(sessionAuth.current.subject);
  });
});
