import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  assertRuntimeRoleReadback,
  executePreviewActivation,
  planPreviewActivation,
  previewActivationApplyRequestSchema,
  type PreviewActivationStore,
} from "./preview-activation";

const now = Date.parse("2026-08-27T12:00:00.000Z");

function store(): PreviewActivationStore {
  return {
    provisionInvitedUser: vi.fn(async () => ({
      userRowsAffected: 1,
      accountRowsAffected: 1,
      membershipRowsAffected: 1,
    })),
    configureRuntimeRole: vi.fn(async () => ({
      runtimeRoleCreated: true,
      runtimeRoleLogin: true,
      runtimeRoleCanConnect: true,
      runtimeRoleCanUseSchema: true,
      runtimeRoleCanCreateSchemaObjects: false as const,
      runtimeRoleTablePrivilegesExact: true,
      runtimeRoleSequencePrivilegesExact: true,
      runtimeRoleAttributesExact: true,
      runtimeRoleMembershipCount: 0 as const,
    })),
    initializeOAuth: vi.fn(async () => ({
      resourceRowsBefore: 0,
      resourceRowsAfter: 1,
      jwksRowsBefore: 0,
      jwksRowsAfter: 1,
    })),
  };
}

const invite = {
  version: 1 as const,
  action: "invited-user.provision" as const,
  requestedAt: new Date(now).toISOString(),
  issuer: "https://builder.example.test/api/auth",
  resource: "https://builder.example.test/mcp",
  userId: "user_one",
  workspaceId: "workspace_one",
  email: "User@One.Example",
  name: "User One",
  password: "correct horse battery staple",
};

describe("Preview activation prerequisite contract", () => {
  it("plans and executes invited users without disclosing identity or password", async () => {
    const plan = planPreviewActivation(invite);
    expect(JSON.stringify(plan)).not.toContain(invite.password);
    expect(JSON.stringify(plan)).not.toContain(invite.email);
    const receipt = await executePreviewActivation({
      request: {
        ...invite,
        confirmationDigest: plan.requiredConfirmationDigest,
      },
      store: store(),
      now: () => now,
    });
    expect(receipt.effects).toMatchObject({
      userRowsAffected: 1,
      accountRowsAffected: 1,
      membershipRowsAffected: 1,
    });
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain(invite.password);
    expect(serialized).not.toContain(invite.email);
    expect(serialized).not.toContain(invite.workspaceId);
  });

  it.each([
    {
      version: 1,
      action: "runtime-role.configure",
      requestedAt: new Date(now).toISOString(),
      roleName: "app_builder_runtime",
      password: "runtime role password",
    },
    {
      version: 1,
      action: "oauth.initialize",
      requestedAt: new Date(now).toISOString(),
      issuer: "https://builder.example.test/api/auth",
      resource: "https://builder.example.test/mcp",
      authSecret: "a".repeat(32),
    },
  ])(
    "supports a closed confirmation-bound $action receipt",
    async (request) => {
      const plan = planPreviewActivation(request);
      const receipt = await executePreviewActivation({
        request: {
          ...request,
          confirmationDigest: plan.requiredConfirmationDigest,
        },
        store: store(),
        now: () => now,
      });
      expect(receipt.action).toBe(request.action);
      expect(receipt.status).toBe("applied");
    },
  );

  it("rejects stale, mismatched, unknown, and cross-origin inputs", async () => {
    const plan = planPreviewActivation(invite);
    await expect(
      executePreviewActivation({
        request: { ...invite, confirmationDigest: `sha256:${"0".repeat(64)}` },
        store: store(),
        now: () => now,
      }),
    ).rejects.toThrow("confirmation");
    await expect(
      executePreviewActivation({
        request: {
          ...invite,
          confirmationDigest: plan.requiredConfirmationDigest,
        },
        store: store(),
        now: () => now + 16 * 60_000,
      }),
    ).rejects.toThrow("stale");
    expect(() =>
      planPreviewActivation({
        ...invite,
        resource: "https://other.example.test/mcp",
      }),
    ).toThrow("same-origin");
    expect(() =>
      previewActivationApplyRequestSchema.parse({
        ...invite,
        confirmationDigest: plan.requiredConfirmationDigest,
        publicSignup: true,
      }),
    ).toThrow();
  });

  it("rejects every extra runtime role authority and role membership", () => {
    const exact = {
      canConnect: true,
      canUseSchema: true,
      canCreateSchemaObjects: false,
      tablePrivilegesExact: true,
      sequencePrivilegesExact: true,
      canLogin: true,
      inherits: false,
      superuser: false,
      createDatabase: false,
      createRole: false,
      replication: false,
      bypassRls: false,
      membershipCount: 0,
    } as const;
    expect(assertRuntimeRoleReadback(exact)).toEqual(exact);
    for (const drift of [
      { inherits: true },
      { superuser: true },
      { createDatabase: true },
      { createRole: true },
      { replication: true },
      { bypassRls: true },
      { membershipCount: 1 },
      { canCreateSchemaObjects: true },
      { tablePrivilegesExact: false },
      { sequencePrivilegesExact: false },
    ]) {
      expect(() => assertRuntimeRoleReadback({ ...exact, ...drift })).toThrow();
    }
  });

  it("has PostgreSQL quote the validated role credential without exposing failed SQL", async () => {
    const cli = await readFile("lib/db/preview-activation-cli.mts", "utf8");
    expect(cli).toContain(
      "select format(${template}::text, ${roleName}::text, ${password}::text)",
    );
    expect(cli).toContain("await sql.unsafe(statement)");
    expect(cli).toContain("Runtime database role configuration failed.");
    expect(cli).not.toContain("sql.unsafe(input.password)");
  });

  it("provisions the exact migrated membership shape in one transaction", async () => {
    const [cli, migration] = await Promise.all([
      readFile("lib/db/preview-activation-cli.mts", "utf8"),
      readFile("drizzle/0002_hosted_workspace_membership.sql", "utf8"),
    ]);
    const provisionStart = cli.indexOf("async provisionInvitedUser(input)");
    const provisionEnd = cli.indexOf("async configureRuntimeRole(input)");
    expect(provisionStart).toBeGreaterThanOrEqual(0);
    expect(provisionEnd).toBeGreaterThan(provisionStart);
    const provision = cli.slice(provisionStart, provisionEnd);
    expect(provision).toContain("return sql.begin(async (transaction) => {");
    expect(provision).toContain(
      "insert into hosted_workspace_membership (issuer, audience, workspace_id, owner_user_id, active, updated_at)",
    );
    expect(provision).not.toMatch(
      /hosted_workspace_membership[^;]*created_at/u,
    );
    expect(migration).toContain('"updated_at" timestamptz NOT NULL');
    expect(migration).not.toContain('"created_at"');
  });
});
