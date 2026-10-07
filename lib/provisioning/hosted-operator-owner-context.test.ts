import { describe, expect, it, vi } from "vitest";
import { hostedEveOperationScopes } from "../eve/hosted-auth";
import {
  durableHostedSessionRecordSchema,
  hostedSessionRecordSchema,
} from "../eve/hosted-store";
import type { HostedSessionRecord } from "../eve/hosted-store";
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
const sessionAuth = {
  current: {
    attributes: {
      "autograph:source-handoff-id": handoffId,
      "mcp:audience": authority.audience,
      "mcp:scopes": principal.scopes,
      "mcp:workspace-id": authority.workspaceId,
    },
    authenticator: "mcp-oauth-jwks",
    issuer: authority.issuer,
    principalId: principal.ownerUserId,
    principalType: "user",
    subject: principal.ownerUserId,
  },
  initiator: {
    attributes: {
      "autograph:source-handoff-id": handoffId,
      "mcp:audience": authority.audience,
      "mcp:scopes": principal.scopes,
      "mcp:workspace-id": authority.workspaceId,
    },
    authenticator: "mcp-oauth-jwks",
    issuer: authority.issuer,
    principalId: principal.ownerUserId,
    principalType: "user",
    subject: principal.ownerUserId,
  },
};
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
      sessionId: "public-session-1",
      sourceHandoffId: handoffId,
    });
    expect(f.handoffs.read).toHaveBeenCalledWith({ authority, handoffId });
    expect(f.sessions.getSession).toHaveBeenCalledWith(
      principal,
      "public-session-1",
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
    await expect(
      fixture({
        handoff: null,
      }).resolver({
        adapterSessionId: "adapter-current",
        authority,
        principal,
        sessionAuth,
      }),
    ).rejects.toMatchObject({ code: "authorization_required" });
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
    expect(captured?.headers.get("authorization")).toBe(
      "Bearer operator-workload-token",
    );
    await expect(captured?.json()).resolves.toMatchObject({
      ownerContext: resolved,
    });
    expect(JSON.stringify(captured?.headers)).not.toContain(
      sessionAuth.current.subject,
    );
  });
});
