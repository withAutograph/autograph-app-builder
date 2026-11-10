import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { OperatorOwnerContext } from "../provisioning/hosted-operator-contract";
import { authSchemaRolloutApprovalReference } from "../provisioning/production-auth-schema-rollout-contract";
import type { AuthSchemaRolloutApproval } from "../provisioning/production-auth-schema-rollout-contract";
import { createAuthSchemaRolloutClient } from "./auth-schema-rollout-client";

const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace",
  ownerUserId: "operator",
};
const ownerContext: OperatorOwnerContext = {
  kind: "direct",
  authority,
  principal: { ...authority, scopes: ["autograph:send"] },
  sessionId: "session",
  adapterSessionId: "adapter",
  adapterGeneration: 1,
};
const plan: AuthSchemaRolloutApproval = {
  version: 1,
  operationRef: "11111111-1111-4111-8111-111111111111",
  scope: { authority, sessionId: "session", profileId: "shared-auth" },
  resourceLabel: "Shared Auth",
  planDigest: "a".repeat(64),
  resource: {
    version: 1,
    resourceId: "original-auth",
    environment: "production",
    hostname: "auth-database.example",
    port: 5432,
    database: "auth",
    schema: "public",
    migratorRole: "auth_migrator",
    runtimeRole: "auth_runtime",
    neon: { projectId: "project", branchId: "branch" },
  },
  authOperatorRole: "managed_operator",
  schemaPlanDigest: "b".repeat(64),
  targetDigest: "c".repeat(64),
  workerSha256: "d".repeat(64),
  sourceCapture: {
    kind: "operator-worker-catalog-v1",
    family: "auth",
    catalogPath: "/workers/catalog.json",
    catalogSha256: "e".repeat(64),
    sources: {
      builder: { sha: "1".repeat(40), tree: "2".repeat(40) },
      arrusted: { sha: "3".repeat(40), tree: "4".repeat(40) },
    },
  },
  effects: [
    {
      owner: "auth",
      sql: "ALTER TABLE test_fixture ADD COLUMN approved text",
      sha256: "f".repeat(64),
    },
  ],
};
const status = { version: 1, operationRef: plan.operationRef, state: "planned" };
const review = (selected = plan) => ({
  version: 1,
  plan: selected,
  approvalReference: authSchemaRolloutApprovalReference(selected),
});
const setup = (endpoint = "https://operator.example/") => {
  const controller = new AbortController();
  const fetch = vi.fn<typeof globalThis.fetch>();
  const workloadToken = vi.fn(async () => await Promise.resolve("test-workload-token"));
  const client = createAuthSchemaRolloutClient({
    endpoint,
    ownerContext,
    callId: "current-call",
    signal: controller.signal,
    workloadToken,
    fetch,
  });
  return { client, fetch, workloadToken, controller };
};

describe("internal Production Auth schema rollout transport", () => {
  it("plans against the canonical owner with workload authentication and no redirects", async () => {
    const fixture = setup();
    fixture.fetch.mockResolvedValue(Response.json({ version: 1, plan }));
    await expect(fixture.client.plan("shared-auth")).resolves.toEqual(review());
    expect(fixture.fetch).toHaveBeenCalledWith(
      new URL("https://operator.example/v1/auth-schema-rollout"),
      {
        method: "POST",
        redirect: "error",
        signal: fixture.controller.signal,
        headers: {
          authorization: "Bearer test-workload-token",
          "content-type": "application/json",
          "x-vercel-trusted-oidc-idp-token": "test-workload-token",
        },
        body: JSON.stringify({
          version: 1,
          action: "plan",
          sessionId: "session",
          ownerContext,
          profileId: "shared-auth",
        }),
      },
    );
  });

  it("executes only the frozen operation and digest with the current approval call", async () => {
    const fixture = setup();
    fixture.fetch.mockResolvedValue(Response.json({ ...status, state: "pending" }));
    await expect(fixture.client.apply(plan)).resolves.toEqual({ ...status, state: "pending" });
    expect(fixture.fetch.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        version: 1,
        action: "execute",
        sessionId: "session",
        ownerContext,
        operationRef: plan.operationRef,
        planDigest: plan.planDigest,
        approvedByCallId: "current-call",
      }),
    );
  });

  it("rereads the original saved plan and reference without creating a replacement plan", async () => {
    const fixture = setup();
    fixture.fetch.mockResolvedValue(Response.json(review()));
    await expect(fixture.client.review(plan.operationRef)).resolves.toEqual(review());
    expect(fixture.fetch.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        version: 1,
        action: "review",
        sessionId: "session",
        ownerContext,
        operationRef: plan.operationRef,
      }),
    );
  });

  it("sends only the exact server-derived reference with the fresh native call identity", async () => {
    const fixture = setup();
    fixture.fetch.mockResolvedValue(Response.json(status));
    const reference = authSchemaRolloutApprovalReference(plan);
    await expect(fixture.client.apply(reference)).resolves.toEqual(status);
    const body = z.string().parse(fixture.fetch.mock.calls[0]?.[1]?.body);
    expect(JSON.parse(body)).toEqual({
      version: 1,
      action: "execute",
      sessionId: "session",
      ownerContext,
      operationRef: reference.operationRef,
      planDigest: reference.planDigest,
      approvalDigest: reference.approvalDigest,
      approvedByCallId: "current-call",
    });
    expect(body).not.toContain(plan.effects[0]?.sql);
  });

  it("rejects a returned reference that does not bind the full saved plan", async () => {
    const fixture = setup();
    fixture.fetch.mockResolvedValue(
      Response.json({
        ...review(),
        approvalReference: {
          ...authSchemaRolloutApprovalReference(plan),
          approvalDigest: "0".repeat(64),
        },
      }),
    );
    await expect(fixture.client.review(plan.operationRef)).rejects.toThrow(
      "auth_schema_rollout_scope_mismatch",
    );
  });

  it("reads the same operation without replaying a mutation", async () => {
    const fixture = setup();
    fixture.fetch.mockResolvedValue(Response.json(status));
    await expect(fixture.client.status(plan.operationRef)).resolves.toEqual(status);
    expect(fixture.fetch.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        version: 1,
        action: "status",
        sessionId: "session",
        ownerContext,
        operationRef: plan.operationRef,
      }),
    );
  });

  it.each([
    { ...plan, scope: { ...plan.scope, profileId: "another" } },
    { ...plan, scope: { ...plan.scope, sessionId: "another" } },
    { ...plan, scope: { ...plan.scope, authority: { ...authority, workspaceId: "another" } } },
  ])(
    "rejects a returned plan outside the selected profile and canonical owner",
    async (foreign) => {
      const fixture = setup();
      fixture.fetch.mockResolvedValue(Response.json({ version: 1, plan: foreign }));
      await expect(fixture.client.plan("shared-auth")).rejects.toThrow(
        "auth_schema_rollout_scope_mismatch",
      );
    },
  );

  it("rejects a foreign session before applying anything", async () => {
    const fixture = setup();
    await expect(
      fixture.client.apply({ ...plan, scope: { ...plan.scope, sessionId: "another" } }),
    ).rejects.toThrow("auth_schema_rollout_scope_mismatch");
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(fixture.workloadToken).not.toHaveBeenCalled();
  });

  it.each(["apply", "status"] as const)(
    "rejects a %s result from another operation",
    async (action) => {
      const fixture = setup();
      fixture.fetch.mockResolvedValue(
        Response.json({ ...status, operationRef: "22222222-2222-4222-8222-222222222222" }),
      );
      await expect(
        action === "apply" ? fixture.client.apply(plan) : fixture.client.status(plan.operationRef),
      ).rejects.toThrow("auth_schema_rollout_scope_mismatch");
    },
  );

  it("preserves uncertain execution and gives reconciliation guidance without provider output", async () => {
    const fixture = setup();
    fixture.fetch.mockResolvedValue(
      new Response("private database and credential details", { status: 502 }),
    );
    await expect(fixture.client.apply(plan)).rejects.toThrow(
      "Read status for this same operation before retrying; do not create a replacement rollout.",
    );
  });

  it("contains network and malformed-response errors while preserving the original operation", async () => {
    const network = setup();
    network.fetch.mockRejectedValue(new Error("private provider credential details"));
    const message =
      "Builder could not confirm the Auth schema rollout result. Read status for this same operation before retrying; do not create a replacement rollout.";
    await expect(network.client.apply(plan)).rejects.toMatchObject({ message });
    const malformed = setup();
    malformed.fetch.mockResolvedValue(new Response("private provider output", { status: 200 }));
    await expect(malformed.client.apply(plan)).rejects.toMatchObject({ message });
  });

  it.each(["plan", "status"] as const)(
    "keeps failed %s reads separate from schema mutation",
    async (action) => {
      const fixture = setup();
      fixture.fetch.mockResolvedValue(
        new Response("private database and credential details", { status: 403 }),
      );
      await expect(
        action === "plan"
          ? fixture.client.plan("shared-auth")
          : fixture.client.status(plan.operationRef),
      ).rejects.toThrow("This read did not apply a schema change.");
    },
  );

  it.each([
    "http://operator.example/",
    "https://user:password@operator.example/",
    "https://operator.example/wrong",
    "https://operator.example/?token=private",
    "https://operator.example/#fragment",
  ])("rejects unsafe operator endpoint %s before obtaining credentials", (endpoint) => {
    expect(() => setup(endpoint)).toThrow("protected_operator_required");
  });

  it("preserves cancellation before authentication and after dispatch", async () => {
    const before = setup();
    const reason = new Error("cancelled by owner");
    before.controller.abort(reason);
    await expect(before.client.apply(plan)).rejects.toBe(reason);
    expect(before.workloadToken).not.toHaveBeenCalled();
    const after = setup();
    after.fetch.mockImplementation(async () => {
      after.controller.abort(reason);
      return await Promise.resolve(Response.json(status));
    });
    await expect(after.client.apply(plan)).rejects.toBe(reason);
  });
});
