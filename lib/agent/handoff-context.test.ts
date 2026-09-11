import { describe, expect, it, vi } from "vitest";

import type { BuilderHandoffRecord } from "../handoff/contracts";
import { createBuilderHandoffService } from "../handoff/service";
import { activeBuilderModelId } from "../integrations/active-model";
import { createPreparedHandoffReader } from "./handoff-context";

const handoffId = "123e4567-e89b-42d3-a456-426614174001";
const authority = {
  audience: "https://builder.example.test/mcp",
  issuer: "https://builder.example.test/api/auth",
  ownerUserId: "user_1",
  workspaceId: "workspace_1",
};
const context = {
  attributes: {
    "autograph:source-handoff-id": handoffId,
    "mcp:audience": authority.audience,
    "mcp:scopes": ["autograph:session"],
    "mcp:workspace-id": authority.workspaceId,
  },
  authenticator: "mcp-oauth-jwks",
  issuer: authority.issuer,
  principalId: authority.ownerUserId,
  principalType: "user",
  subject: authority.ownerUserId,
};
const sessionAuth = { current: context, initiator: context };

async function fixture() {
  let record: BuilderHandoffRecord | undefined;
  const handoffs = createBuilderHandoffService({
    createId: () => handoffId,
    now: () => new Date("2020-01-01T00:00:00Z"),
    store: {
      bindSession: async () => undefined,
      read: async () => record,
      reserve: async (value) => {
        record = value;
        return { disposition: "created", record: value };
      },
    },
  });
  await handoffs.create({
    authority,
    creationRequestId: handoffId,
    intent: {
      appId: "accounts",
      appName: "Accounts",
      brief: "Review accounts",
      connections: [],
      modelId: activeBuilderModelId,
      repository: { private: true, requestedName: "accounts" },
    },
  });
  return record!;
}

describe("prepared session context", () => {
  it("loads the full record under current authority even after launch expiry", async () => {
    const record = await fixture();
    const read = vi.fn(async () => record);
    const isActiveMember = vi.fn(async () => true);
    const result = await createPreparedHandoffReader({ isActiveMember, read })(
      sessionAuth
    );
    expect(result).toEqual(record.intent);
    expect(read).toHaveBeenCalledWith({ authority, handoffId });
    expect(isActiveMember).toHaveBeenCalledWith(authority);
  });
  it("rejects revoked membership and substituted records without exposing another app", async () => {
    const record = await fixture();
    const read = vi.fn(async () => record);
    await expect(
      createPreparedHandoffReader({ isActiveMember: async () => false, read })(
        sessionAuth
      )
    ).rejects.toThrow("handoff is unavailable");
    expect(read).not.toHaveBeenCalled();
    await expect(
      createPreparedHandoffReader({
        isActiveMember: async () => true,
        read: async () => ({
          ...record,
          authority: { ...authority, ownerUserId: "user_2" },
        }),
      })(sessionAuth)
    ).rejects.toThrow("handoff is unavailable");
  });
  it("does not read credentials or storage for ordinary local sessions", async () => {
    const read = vi.fn();
    expect(
      await createPreparedHandoffReader({ isActiveMember: vi.fn(), read })({
        current: null,
        initiator: null,
      })
    ).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });
});
