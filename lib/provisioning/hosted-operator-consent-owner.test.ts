import { describe, expect, it, vi } from "vitest";
import { durableHostedSessionRecordSchema } from "../eve/hosted-store";
import { builderHandoffRecordSchema } from "../handoff/contracts";
import { createHostedOperatorOwnerContextResolver } from "./hosted-operator-owner-context";
import { createHostedOperatorConsentOwner } from "./hosted-operator-consent-owner";
import type { OperatorOwnerContext } from "./hosted-operator-contract";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "canonical-owner",
  workspaceId: "workspace",
};
const principal = { ...authority, scopes: ["autograph:get", "autograph:send"] };
const workload = {
  audience: "https://vercel.com/team",
  environment: "production" as const,
  issuer: "https://oidc.vercel.com/team",
  ownerId: "team",
  projectId: "builder",
  subject: "builder-subject",
};
const handoffId = "123e4567-e89b-42d3-a456-426614174001";
const fixture = (kind: "direct" | "handoff" = "direct") => {
  let member = true;
  let generation = 7;
  const currentSession = () =>
    durableHostedSessionRecordSchema.parse({
      adapterGeneration: generation,
      adapterSessionId: "current-adapter",
      createdAtEpochMs: 1000,
      lastProgressAtEpochMs: 1000,
      originAdapterSessionId: "original-adapter",
      principal,
      resumability: "live",
      sessionId: "original-public-session",
      sourceHandoffId: kind === "handoff" ? handoffId : undefined,
      stage: "prototype",
      status: "waiting",
      title: "Original app",
      updatedAtEpochMs: 1000,
      version: 2,
    });
  const handoff = builderHandoffRecordSchema.parse({
    authority,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    creationRequestId: "123e4567-e89b-42d3-a456-426614174002",
    expiresAt: new Date("2026-10-02T00:00:00Z"),
    handoffId,
    intent: {
      appId: "original-app",
      appName: "Original app",
      brief: "Original brief",
      connections: [],
      modelId: "openai/gpt-5.6-terra",
      repository: { private: true, requestedName: "original-app" },
    },
    redeemedAt: new Date("2026-10-01T01:00:00Z"),
    requestDigest: "a".repeat(64),
    sessionId: "original-public-session",
    version: 1,
  });
  const sessions = {
    getSession: vi.fn(async () => await Promise.resolve(currentSession())),
    getSessionByAdapterSessionId: vi.fn(async () => await Promise.resolve(currentSession())),
  };
  const resolveOwner = createHostedOperatorOwnerContextResolver({
    audience: authority.audience,
    handoffs: { read: async () => await Promise.resolve(handoff) },
    isActiveMember: async () => await Promise.resolve(member),
    issuer: authority.issuer,
    sessions,
  });
  const verifyWorkload = vi.fn(async () => {
    await Promise.resolve();
  });
  const service = createHostedOperatorConsentOwner(workload, {}, { resolveOwner, verifyWorkload });
  const base = {
    adapterGeneration: generation,
    adapterSessionId: "current-adapter",
    authority,
    principal,
    sessionId: "original-public-session",
  };
  const hint: OperatorOwnerContext =
    kind === "direct" ? { ...base, kind } : { ...base, kind, sourceHandoffId: handoffId };
  return {
    hint,
    replaceAdapter: () => {
      generation += 1;
    },
    revoke: () => {
      member = false;
    },
    service,
    sessions,
    verifyWorkload,
  };
};
const request = () => new Request("https://operator.example/v1/runtime", { method: "POST" });
describe("consent owner authority without app provisioning", () => {
  it.each(["direct", "handoff"] as const)(
    "re-resolves actual %s session/membership without app ID, project installation, branch or release",
    async (kind) => {
      const f = fixture(kind);
      const owner = await f.service.authorize(request(), f.hint.sessionId, f.hint);
      expect(owner).toEqual({ authority, ownerContext: f.hint });
      expect(f.verifyWorkload).toHaveBeenCalledOnce();
      await expect(f.service.assertCurrent(owner)).resolves.toBeUndefined();
    },
  );
  it("rejects expired or foreign Builder workload before looking up a user", async () => {
    const f = fixture();
    f.verifyWorkload.mockRejectedValue(new Error("invalid Builder OIDC"));
    await expect(f.service.authorize(request(), f.hint.sessionId, f.hint)).rejects.toThrow(
      "invalid Builder OIDC",
    );
    expect(f.sessions.getSessionByAdapterSessionId).not.toHaveBeenCalled();
  });
  it("does not replace a canonical owner with request-provided identity", async () => {
    const f = fixture();
    const hint = {
      ...f.hint,
      authority: { ...authority, ownerUserId: "foreign-owner" },
      principal: { ...principal, ownerUserId: "foreign-owner" },
    };
    await expect(f.service.authorize(request(), f.hint.sessionId, hint)).rejects.toMatchObject({
      code: "authorization_required",
    });
  });
  it("rejects a mismatched original public session", async () => {
    const f = fixture();
    await expect(
      f.service.authorize(request(), "another-public-session", f.hint),
    ).rejects.toMatchObject({ code: "authorization_required" });
  });
  it("rejects membership revocation during the same consent continuation", async () => {
    const f = fixture();
    const owner = await f.service.authorize(request(), f.hint.sessionId, f.hint);
    f.revoke();
    await expect(f.service.assertCurrent(owner)).rejects.toMatchObject({
      code: "authorization_required",
    });
  });
  it("rejects changed adapter generation without requiring a project installation", async () => {
    const f = fixture();
    const owner = await f.service.authorize(request(), f.hint.sessionId, f.hint);
    f.replaceAdapter();
    await expect(f.service.assertCurrent(owner)).rejects.toMatchObject({
      code: "authorization_required",
    });
  });
});
