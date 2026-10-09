import { describe, expect, it, vi } from "vitest";
import { durableHostedSessionRecordSchema } from "../eve/hosted-store";
import { createHostedOperatorDeploymentOwnerContextResolver } from "./hosted-operator-owner-context";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "canonical-owner",
  workspaceId: "workspace",
};
const principal = { ...authority, scopes: ["autograph:get", "autograph:send"] };
const auth = {
  attributes: {
    "mcp:audience": authority.audience,
    "mcp:scopes": principal.scopes,
    "mcp:workspace-id": authority.workspaceId,
  },
  authenticator: "mcp-oauth-jwks",
  issuer: authority.issuer,
  principalId: principal.ownerUserId,
  principalType: "user",
  subject: principal.ownerUserId,
};
const environment = {
  BETTER_AUTH_URL: authority.issuer,
  DATABASE_URL: "postgresql://fixture_owner@db.example/owner_db",
  MCP_RESOURCE_URL: authority.audience,
};
const fixture = () => {
  const activeMember = vi.fn(async () => await Promise.resolve(true));
  const session = durableHostedSessionRecordSchema.parse({
    adapterGeneration: 7,
    adapterSessionId: "adapter-current",
    createdAtEpochMs: 1000,
    lastProgressAtEpochMs: 1000,
    originAdapterSessionId: "adapter-original",
    principal,
    resumability: "live",
    sessionId: "original-public-session",
    stage: "prototype",
    status: "waiting",
    title: "Original app",
    updatedAtEpochMs: 1000,
    version: 2,
  });
  const stores = {
    handoffs: {
      read: async () => {
        await Promise.resolve();
        throw new Error("Direct fixture has no handoff");
      },
    },
    isActiveMember: activeMember,
    sessions: {
      getSession: async () => await Promise.resolve(session),
      getSessionByAdapterSessionId: async () => await Promise.resolve(session),
    },
  };
  const openStores = vi.fn(async () => await Promise.resolve(stores));
  return { activeMember, openStores };
};
describe("deployed owner reader with narrow configuration", () => {
  it("composes the actual deployment resolver with only the three owner-reader inputs", async () => {
    const f = fixture();
    const readerEnvironment = { ...environment };
    Object.defineProperty(readerEnvironment, "BETTER_AUTH_SECRET", {
      get: () => {
        throw new Error("Signing secret must not be read");
      },
    });
    Object.defineProperty(readerEnvironment, "EVE_HOSTED_ADAPTER", {
      get: () => {
        throw new Error("Hosted mode must not be read");
      },
    });
    const resolver = await createHostedOperatorDeploymentOwnerContextResolver(
      readerEnvironment,
      f.openStores,
    );
    const input = {
      adapterSessionId: "adapter-current",
      authority,
      principal,
      sessionAuth: { current: auth, initiator: auth },
    };
    await expect(resolver(input)).resolves.toMatchObject({
      adapterGeneration: 7,
      kind: "direct",
      sessionId: "original-public-session",
    });
    expect(f.openStores).toHaveBeenCalledWith({
      databaseUrl: environment.DATABASE_URL,
      issuer: authority.issuer,
      resource: authority.audience,
    });
    expect(f.activeMember).toHaveBeenCalledWith(authority);
    f.activeMember.mockResolvedValue(false);
    await expect(resolver(input)).rejects.toMatchObject({ code: "authorization_required" });
    expect(f.openStores).toHaveBeenCalledTimes(1);
    expect(f.activeMember).toHaveBeenCalledTimes(2);
  });
  it("rejects invalid canonical URLs before opening private storage", async () => {
    const f = fixture();
    await expect(
      createHostedOperatorDeploymentOwnerContextResolver(
        { ...environment, MCP_RESOURCE_URL: "https://foreign.example/mcp" },
        f.openStores,
      ),
    ).rejects.toThrow();
    expect(f.openStores).not.toHaveBeenCalled();
  });
});
