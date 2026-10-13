import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { asSchema } from "ai";
import type { ToolContext } from "eve/tools";
// oxlint-disable-next-line sonarjs/no-internal-api-use -- Fixture measures the installed Eve model serializer without executing any tool or provider.
import {
  serializeInputSchema,
  toModelSchema,
} from "../../node_modules/eve/dist/src/tools/schema.js";
// oxlint-disable-next-line sonarjs/no-internal-api-use -- Fixture resolves the native approval policy without requesting a durable input.
import { resolveApprovalPolicy } from "../../node_modules/eve/dist/src/approval/definition.js";
import cleanup, {
  hostedRuntimeApprovalInputSchema,
} from "../../agent/tools/cleanup-app-hosted-runtime";
import {
  hostedOperatorPlanSchema,
  operatorPlanDigest,
} from "../provisioning/hosted-operator-contract";

const plan = hostedOperatorPlanSchema.parse({
  access: [],
  action: "cleanup",
  appDatabase: {
    database: "app_db",
    migratorRole: "app_migrator",
    resourceId: "app-resource",
    runtimeRole: "app_runtime",
  },
  authDatabase: {
    database: "auth_db",
    migratorRole: "auth_migrator",
    resourceId: "auth-resource",
    runtimeRole: "auth_runtime",
  },
  contextId: "fixture-context",
  cost: { class: "independent-service", description: "Fixture cleanup", owner: "Fixture owner" },
  effects: [
    { description: "Revoke fixture access", id: "revoke", kind: "revoke" },
    { description: "Remove fixture bindings", id: "bindings", kind: "remove-bindings" },
    { description: "Retire fixture resources", id: "retire", kind: "retire" },
  ],
  installer: { reference: "fixture-installer", sha256: "a".repeat(64) },
  neon: {
    branchId: "fixture-branch",
    connectionRef: "fixture-connection",
    endpoint: "ep-fixture.neon.tech",
    projectId: "fixture-project",
    source: "synthetic-only",
  },
  release: { artifactRef: "fixture-release", id: "fixture-v1", sha256: "b".repeat(64) },
  retention: { expiresAt: "2027-01-01T00:00:00Z", policy: "fixture" },
  selection: {
    appId: "spend-review",
    branch: "feature",
    environment: "preview",
    projectId: "fixture-project",
    sessionId: "fixture-session",
  },
  version: 1,
});
const input = {
  appId: plan.selection.appId,
  branch: plan.selection.branch,
  environment: plan.selection.environment,
  operationRef: "00000000-0000-4000-8000-000000000001",
  plan,
  planDigest: operatorPlanDigest(plan),
  projectId: plan.selection.projectId,
};
// Reconstruct the prior advertised shape with the exact unchanged top-level fields.
const priorSchema = z.strictObject({
  ...hostedRuntimeApprovalInputSchema.shape,
  plan: hostedOperatorPlanSchema,
});
const approvalContext = () => ({
  abortSignal: new AbortController().signal,
  approvedTools: new Set<string>(),
  callId: "fixture-call",
  getSandbox: async (): Promise<never> => await Promise.reject(new Error("Unexpected Sandbox use")),
  session: {
    auth: { current: null, initiator: null },
    id: "fixture-session",
    turn: { id: "fixture-turn", sequence: 0 },
  },
  toolInput: input,
  toolName: "cleanup-app-hosted-runtime",
});

describe("cleanup hosted runtime input advertisement", () => {
  it("advertises compact JSON while using the installed serializer and preserving top-level strict fields", () => {
    const original = serializeInputSchema(priorSchema);
    const compact = serializeInputSchema(hostedRuntimeApprovalInputSchema);
    const oldBytes = Buffer.byteLength(JSON.stringify(original));
    const newBytes = Buffer.byteLength(JSON.stringify(compact));
    expect(oldBytes).toBe(15_028);
    expect(newBytes).toBe(1041);
    expect(compact).toMatchObject({ additionalProperties: false, required: original.required });
    const originalProperties = z.record(z.string(), z.json()).parse(original.properties);
    expect(compact.properties).toMatchObject({
      appId: originalProperties.appId,
      branch: originalProperties.branch,
      environment: originalProperties.environment,
      operationRef: originalProperties.operationRef,
      planDigest: originalProperties.planDigest,
      projectId: originalProperties.projectId,
    });
    expect(JSON.stringify(compact)).not.toContain("authDatabase");
    expect(asSchema(toModelSchema(hostedRuntimeApprovalInputSchema, "input")).jsonSchema).toEqual(
      compact,
    );
    console.info({
      compactSchemaBytes: newBytes,
      priorSchemaBytes: oldBytes,
      savedSchemaBytes: oldBytes - newBytes,
    });
  });

  it("accepts the same valid plan and still requests the native user approval", async () => {
    expect(hostedRuntimeApprovalInputSchema.parse(input)).toEqual(priorSchema.parse(input));
    const validated = await hostedRuntimeApprovalInputSchema["~standard"].validate(input);
    expect(validated).not.toHaveProperty("issues");
    expect(cleanup.inputSchema).toBe(hostedRuntimeApprovalInputSchema);
    if (cleanup.approval === undefined) {
      throw new Error("Expected native always approval");
    }
    expect(await resolveApprovalPolicy(cleanup.approval)(approvalContext())).toBe("user-approval");
  });

  it("retains full plan rejection through the installed model-schema validation wrapper", async () => {
    const lowered = asSchema(toModelSchema(hostedRuntimeApprovalInputSchema, "input"));
    if (lowered.validate === undefined) {
      throw new Error("Expected the native input validator");
    }
    expect(await lowered.validate({ ...input, plan: {} })).toMatchObject({ success: false });
  });

  it("parses the strict typed plan before reading operator client authority during execution", async () => {
    const readAuth = vi.fn((): never => {
      throw new Error("Unexpected operator authority access");
    });
    const context: ToolContext = {
      ...approvalContext(),
      getToken: async (): Promise<never> =>
        await Promise.reject(new Error("Unexpected token access")),
      requireAuth: (): never => {
        throw new Error("Unexpected authorization request");
      },
      session: {
        get auth() {
          return readAuth();
        },
        id: "fixture-session",
        turn: { id: "fixture-turn", sequence: 0 },
      },
    };
    await expect(cleanup.execute({ ...input, plan: {} }, context)).resolves.toMatchObject({
      status: "blocked",
    });
    expect(readAuth).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    "malformed",
    {},
    { ...plan, unknownField: true },
    { ...plan, installer: { ...plan.installer, unknownField: true } },
    { ...plan, selection: { ...plan.selection, environment: "production" } },
    { ...plan, neon: { ...plan.neon, source: "unverified" } },
    { ...plan, effects: plan.effects.slice(0, 2) },
    { ...plan, appDatabase: plan.authDatabase },
  ])(
    "rejects malformed or nonconforming plans through native validation before approval: %#",
    async (candidate) => {
      const proposed = { ...input, plan: candidate };
      expect(priorSchema.safeParse(proposed).success).toBe(false);
      const validation = await hostedRuntimeApprovalInputSchema["~standard"].validate(proposed);
      expect(validation).toHaveProperty("issues");
      if (cleanup.approval === undefined) {
        throw new Error("Expected native always approval");
      }
      const requestApproval = vi.fn(resolveApprovalPolicy(cleanup.approval));
      if (validation.issues === undefined) {
        await requestApproval(approvalContext());
      }
      expect(requestApproval).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ...input, environment: "production" },
    { ...input, operationRef: "invalid" },
    { ...input, planDigest: "invalid" },
    { ...input, unknownField: true },
  ])("retains top-level strict rejection: %#", async (candidate) => {
    expect(priorSchema.safeParse(candidate).success).toBe(false);
    expect(await hostedRuntimeApprovalInputSchema["~standard"].validate(candidate)).toHaveProperty(
      "issues",
    );
  });
});
