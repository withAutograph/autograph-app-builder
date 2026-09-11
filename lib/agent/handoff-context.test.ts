import { describe, expect, it, vi } from "vitest";
import { createPreparedHandoffReader } from "./handoff-context";
import { createBuilderHandoffService } from "../handoff/service";
import type { BuilderHandoffRecord } from "../handoff/contracts";
import { activeBuilderModelId } from "../integrations/active-model";

const handoffId = "123e4567-e89b-42d3-a456-426614174001";
const authority = {
  issuer: "https://builder.example.test/api/auth",
  audience: "https://builder.example.test/mcp",
  ownerUserId: "user_1",
  workspaceId: "workspace_1",
};
const context = {
  attributes: {
    "mcp:audience": authority.audience,
    "mcp:workspace-id": authority.workspaceId,
    "mcp:scopes": ["autograph:session"],
    "autograph:source-handoff-id": handoffId,
  },
  authenticator: "mcp-oauth-jwks",
  issuer: authority.issuer,
  principalId: authority.ownerUserId,
  subject: authority.ownerUserId,
  principalType: "user",
};
const sessionAuth = { current: context, initiator: context };

async function fixture() {
  let record: BuilderHandoffRecord | undefined;
  const handoffs = createBuilderHandoffService({
    createId: () => handoffId,
    now: () => new Date("2020-01-01T00:00:00Z"),
    store: {
      reserve: async (value) => {
        record = value;
        return { disposition: "created", record: value };
      },
      read: async () => record,
      bindSession: async () => undefined,
    },
  });
  await handoffs.create({
    authority,
    creationRequestId: handoffId,
    intent: {
      appName: "Accounts",
      appId: "accounts",
      brief: "Review accounts",
      repository: { requestedName: "accounts", private: true },
      modelId: activeBuilderModelId,
      connections: [],
    },
  });
  return record!;
}

describe("prepared session context", () => {
  it("loads the full record under current authority even after launch expiry", async () => {
    const record = await fixture();
    const read = vi.fn(async () => record);
    const isActiveMember = vi.fn(async () => true);
    const result = await createPreparedHandoffReader({ read, isActiveMember })(
      sessionAuth,
    );
    expect(result).toEqual(record.intent);
    expect(read).toHaveBeenCalledWith({ authority, handoffId });
    expect(isActiveMember).toHaveBeenCalledWith(authority);
  });
  it("rejects revoked membership and substituted records without exposing another app", async () => {
    const record = await fixture();
    const read = vi.fn(async () => record);
    await expect(
      createPreparedHandoffReader({ read, isActiveMember: async () => false })(
        sessionAuth,
      ),
    ).rejects.toThrow("handoff is unavailable");
    expect(read).not.toHaveBeenCalled();
    await expect(
      createPreparedHandoffReader({
        read: async () => ({
          ...record,
          authority: { ...authority, ownerUserId: "user_2" },
        }),
        isActiveMember: async () => true,
      })(sessionAuth),
    ).rejects.toThrow("handoff is unavailable");
  });
  it("does not read credentials or storage for ordinary local sessions", async () => {
    const read = vi.fn();
    expect(
      await createPreparedHandoffReader({ read, isActiveMember: vi.fn() })({
        current: null,
        initiator: null,
      }),
    ).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });
});
