import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostedSessionRecordSchema, toDurableHostedSessionRecord } from "./hosted-store";
import { assertHostedBuildDecisionOwner } from "./approved-build-owner";
import { createHostedOperatorOwnerContextResolver } from "../provisioning/hosted-operator-owner-context";

const principal = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "user_1",
  scopes: ["autograph:read", "autograph:write"],
  workspaceId: "workspace_1",
};
const session = toDurableHostedSessionRecord(
  hostedSessionRecordSchema.parse({
    adapterSessionId: "original-adapter",
    createdAtEpochMs: 1,
    principal,
    sessionId: "original-public-session",
    status: "waiting",
    updatedAtEpochMs: 1,
    version: 1,
  }),
);
const resolver = (active: boolean) =>
  createHostedOperatorOwnerContextResolver({
    audience: principal.audience,
    handoffs: {
      read: async () => {
        await Promise.resolve();
        throw new Error("Direct owner must not read a handoff");
      },
    },
    isActiveMember: async () => await Promise.resolve(active),
    issuer: principal.issuer,
    sessions: {
      getSession: async () => await Promise.resolve(session),
      getSessionByAdapterSessionId: async () => await Promise.resolve(session),
    },
  });

describe("approved build owner authority projection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  it("passes exact tenant authority while retaining full forwarded principal scopes", async () => {
    await expect(
      assertHostedBuildDecisionOwner(session, { resolveOwner: resolver(true) }),
    ).resolves.toBeUndefined();
  });
  it("still rejects a revoked live workspace membership without logging identity", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {
      // Capture only the fixed reason asserted below.
    });
    await expect(
      assertHostedBuildDecisionOwner(session, { resolveOwner: resolver(false) }),
    ).rejects.toThrow("authorization_required");
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: "app_builder.approved_build_owner_boundary",
        reason: "ownership_denied",
      }),
    );
  });
});
