import { afterEach, describe, expect, it, vi } from "vitest";
import type { DynamicResolveContext } from "eve/tools";
import planTool from "../../agent/tools/plan-production-auth-schema-rollout";
import applyTool from "../../agent/tools/apply-production-auth-schema-rollout";
import { authSchemaRolloutAvailable } from "./auth-schema-rollout-availability";

const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "platform",
  ownerUserId: "administrator",
};
const principal = {
  attributes: {
    "mcp:audience": authority.audience,
    "mcp:scopes": ["autograph:send"],
    "mcp:workspace-id": authority.workspaceId,
  },
  authenticator: "mcp-oauth-jwks",
  issuer: authority.issuer,
  principalId: authority.ownerUserId,
  principalType: "user",
  subject: authority.ownerUserId,
};
const session: DynamicResolveContext["session"] = {
  id: "session",
  auth: { current: principal, initiator: principal },
};
const configured = { PRODUCTION_AUTH_SCHEMA_ROLLOUT_ADMINISTRATORS: JSON.stringify([authority]) };
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Production Auth maintenance tool discovery", () => {
  it("exposes maintenance only to an exact deployment-enrolled human authority", () => {
    expect(authSchemaRolloutAvailable(session, configured)).toBe(true);
    for (const field of ["issuer", "audience", "workspaceId", "ownerUserId"] as const) {
      expect(
        authSchemaRolloutAvailable(session, {
          PRODUCTION_AUTH_SCHEMA_ROLLOUT_ADMINISTRATORS: JSON.stringify([
            {
              ...authority,
              [field]:
                field === "issuer" || field === "audience" ? "https://other.example" : "other",
            },
          ]),
        }),
      ).toBe(false);
    }
  });

  it.each([
    undefined,
    "",
    "[]",
    "invalid JSON",
    "{}",
    JSON.stringify([{ ownerUserId: authority.ownerUserId }]),
  ])("omits tools for missing or malformed enrollment %s", (value) => {
    expect(
      authSchemaRolloutAvailable(
        session,
        value === undefined ? {} : { PRODUCTION_AUTH_SCHEMA_ROLLOUT_ADMINISTRATORS: value },
      ),
    ).toBe(false);
  });

  it("omits tools for non-user, mismatched and unauthenticated sessions", () => {
    expect(
      authSchemaRolloutAvailable(
        {
          ...session,
          auth: { current: { ...principal, principalType: "service" }, initiator: principal },
        },
        configured,
      ),
    ).toBe(false);
    expect(
      authSchemaRolloutAvailable(
        {
          ...session,
          auth: {
            current: principal,
            initiator: { ...principal, principalId: "other", subject: "other" },
          },
        },
        configured,
      ),
    ).toBe(false);
    expect(
      authSchemaRolloutAvailable(
        { ...session, auth: { current: null, initiator: null } },
        configured,
      ),
    ).toBe(false);
  });

  it.each([planTool, applyTool])(
    "resolves both internal tools only for the enrolled administrator",
    async (tool) => {
      const context: DynamicResolveContext = { session, model: null, channel: {}, messages: [] };
      vi.stubEnv("PRODUCTION_AUTH_SCHEMA_ROLLOUT_ADMINISTRATORS", "[]");
      expect(await tool.events["turn.started"]?.({}, context)).toBeNull();
      vi.stubEnv(
        "PRODUCTION_AUTH_SCHEMA_ROLLOUT_ADMINISTRATORS",
        configured.PRODUCTION_AUTH_SCHEMA_ROLLOUT_ADMINISTRATORS,
      );
      const selected = await tool.events["turn.started"]?.({}, context);
      expect(selected).toMatchObject({ availableInSubagents: false });
      vi.stubEnv("PRODUCTION_AUTH_SCHEMA_ROLLOUT_ADMINISTRATORS", "[]");
      expect(await tool.events["turn.started"]?.({}, context)).toBeNull();
    },
  );
});
