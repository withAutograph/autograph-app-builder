import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { MessageStreamEvent } from "eve/client";
import type { OperatorOwnerContext } from "../provisioning/hosted-operator-contract";
import type { AuthSchemaRolloutApproval } from "../provisioning/production-auth-schema-rollout-contract";
import {
  createPrivateAuthSchemaRolloutApprovalCapture,
  readAuthSchemaRolloutApproval,
} from "./private-auth-schema-rollout-approval";

const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace",
  ownerUserId: "operator",
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
const owner: OperatorOwnerContext = {
  kind: "direct",
  authority,
  principal: { ...authority, scopes: ["autograph:send"] },
  sessionId: "session",
  adapterSessionId: "adapter",
  adapterGeneration: 1,
};
const nativeToolInputSchema = z.record(z.string(), z.json());
type NativeToolInput = z.infer<typeof nativeToolInputSchema>;
const request = (
  input: NativeToolInput = plan,
  callId = "call",
  toolName = "apply-production-auth-schema-rollout",
): MessageStreamEvent => ({
  type: "input.requested",
  meta: { at: "2026-11-09T00:00:00Z", id: "request" },
  data: {
    sequence: 1,
    stepIndex: 0,
    turnId: "turn",
    requests: [
      {
        kind: "tool-approval",
        requestId: "approval",
        prompt: "Apply the reviewed existing Auth schema change?",
        action: {
          kind: "tool-call",
          toolName,
          callId,
          input: nativeToolInputSchema.parse(input),
        },
      },
    ],
  },
});
const settle = (
  actor = "operator",
  outcome: "approved" | "cancelled" = "approved",
): MessageStreamEvent => ({
  type: "approval.settled",
  meta: { at: "2026-11-09T00:00:01Z", id: "settlement" },
  data: {
    sequence: 2,
    stepIndex: 0,
    turnId: "turn",
    requestId: "approval",
    responderPrincipalId: actor,
    outcome,
  },
});

describe("existing Production Auth schema consent", () => {
  it("requires the actual matching owner settlement after the exact tool request", () => {
    const capture = createPrivateAuthSchemaRolloutApprovalCapture({ plan, callId: "call" });
    capture.observe(request());
    expect(capture.read()).toBeNull();
    capture.observe(settle());
    expect(capture.read()).toEqual({ approvalId: "approval", approvedByCallId: "call" });
  });

  it.each([
    { ...plan, operationRef: "22222222-2222-4222-8222-222222222222" },
    { ...plan, planDigest: "0".repeat(64) },
    { ...plan, scope: { ...plan.scope, sessionId: "another" } },
    { ...plan, scope: { ...plan.scope, profileId: "another" } },
    { ...plan, scope: { ...plan.scope, authority: { ...authority, ownerUserId: "another" } } },
    { ...plan, resource: { ...plan.resource, resourceId: "another" } },
    { ...plan, resourceLabel: "Another resource" },
    { ...plan, authOperatorRole: "administrator" },
    { ...plan, schemaPlanDigest: "0".repeat(64) },
    { ...plan, targetDigest: "0".repeat(64) },
    { ...plan, workerSha256: "0".repeat(64) },
    { ...plan, sourceCapture: { ...plan.sourceCapture, catalogSha256: "0".repeat(64) } },
    {
      ...plan,
      effects: [
        {
          ...plan.effects[0],
          owner: "other",
          sql: "DROP TABLE test_fixture",
          sha256: "0".repeat(64),
        },
      ],
    },
    { ...plan, effects: null },
    { ...plan, unexpected: "unreviewed" },
  ])(
    "rejects changed resource, worker, authority or SQL even with a retained digest",
    (changed) => {
      const capture = createPrivateAuthSchemaRolloutApprovalCapture({ plan, callId: "call" });
      capture.observe(request(changed));
      capture.observe(settle());
      expect(capture.read()).toBeNull();
    },
  );

  it.each(["wrong-tool", "old-call", "other-actor", "cancelled"])(
    "rejects %s consent",
    (variation) => {
      const capture = createPrivateAuthSchemaRolloutApprovalCapture({ plan, callId: "call" });
      capture.observe(
        request(
          plan,
          variation === "old-call" ? "old-call" : "call",
          variation === "wrong-tool"
            ? "prepare-app-production"
            : "apply-production-auth-schema-rollout",
        ),
      );
      capture.observe(
        settle(
          variation === "other-actor" ? "other" : "operator",
          variation === "cancelled" ? "cancelled" : "approved",
        ),
      );
      expect(capture.read()).toBeNull();
    },
  );

  it("does not reuse persisted approval for another owner, operation or call", () => {
    const capture = createPrivateAuthSchemaRolloutApprovalCapture({ plan, callId: "call" });
    capture.observe(request());
    capture.observe(settle());
    capture.proveComplete();
    const state = capture.snapshot();
    expect(
      createPrivateAuthSchemaRolloutApprovalCapture({ plan, callId: "new-call", state }).read(),
    ).toBeNull();
    expect(() =>
      createPrivateAuthSchemaRolloutApprovalCapture({
        plan: { ...plan, operationRef: "22222222-2222-4222-8222-222222222222" },
        callId: "call",
        state,
      }),
    ).toThrow("another intent or owner");
    expect(() =>
      createPrivateAuthSchemaRolloutApprovalCapture({
        plan: {
          ...plan,
          scope: { ...plan.scope, authority: { ...authority, ownerUserId: "another" } },
        },
        callId: "call",
        state,
      }),
    ).toThrow("another intent or owner");
    expect(() =>
      createPrivateAuthSchemaRolloutApprovalCapture({
        plan: { ...plan, resource: { ...plan.resource, resourceId: "another" } },
        callId: "call",
        state,
      }),
    ).toThrow("another intent or owner");
  });

  it("keeps cancellation denied after approval, persistence and later approvals", () => {
    const capture = createPrivateAuthSchemaRolloutApprovalCapture({ plan, callId: "call" });
    capture.observe(request());
    capture.observe(settle());
    capture.proveComplete();
    capture.observe(settle("operator", "cancelled"));
    const resumed = createPrivateAuthSchemaRolloutApprovalCapture({
      plan,
      callId: "call",
      state: capture.snapshot(),
    });
    resumed.observe(settle());
    expect(resumed.read()).toBeNull();
  });

  it("requires a complete durable tail and rechecks current owner after reading", async () => {
    const assertOwner = vi.fn(async () => {
      await Promise.resolve();
    });
    const readHistory = async (_start: number, observe: (event: MessageStreamEvent) => void) => {
      observe(request());
      observe(settle());
      return await Promise.resolve({ complete: false, nextNativeIndex: 2, nativeTailIndex: 2 });
    };
    await expect(
      readAuthSchemaRolloutApproval({ plan, callId: "call", owner, assertOwner, readHistory }),
    ).rejects.toThrow("complete durable tail");
    expect(assertOwner).toHaveBeenCalledOnce();
    await expect(
      readAuthSchemaRolloutApproval({
        plan,
        callId: "call",
        owner,
        readHistory: async (_start, observe) => {
          observe(request());
          observe(settle());
          return await Promise.resolve({ complete: true, nextNativeIndex: 2, nativeTailIndex: 2 });
        },
        assertOwner: async () => {
          await Promise.reject(new Error("owner revoked"));
        },
      }),
    ).rejects.toThrow("owner revoked");
  });

  it("rejects a foreign canonical owner before reading history", async () => {
    const readHistory = vi.fn();
    await expect(
      readAuthSchemaRolloutApproval({
        plan,
        callId: "call",
        owner: { ...owner, sessionId: "foreign" },
        assertOwner: async () => {
          await Promise.resolve();
        },
        readHistory,
      }),
    ).rejects.toThrow("owner changed");
    expect(readHistory).not.toHaveBeenCalled();
  });
});
