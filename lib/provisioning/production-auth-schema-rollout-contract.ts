import { createHash } from "node:crypto";
import { z } from "zod";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { centralHostCanonicalBytes } from "./central-integration-host-contract";
import { operatorWorkerSourceCaptureSchema } from "./operator-worker-source-capture";
import { workerEffectCheckpointFrameSchema } from "./hosted-operator-contract";
import { privateOperatorApprovalObservationSchema } from "../eve/private-operator-approval-observation";

const id = z.string().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const authSchemaSqlRoleSchema = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u);
export const productionAuthResourceSchema = z
  .strictObject({
    version: z.literal(1),
    resourceId: id,
    environment: z.literal("production"),
    hostname: id,
    port: z.literal(5432),
    database: authSchemaSqlRoleSchema,
    schema: z.literal("public"),
    migratorRole: authSchemaSqlRoleSchema,
    runtimeRole: authSchemaSqlRoleSchema,
    neon: z.strictObject({ projectId: id, branchId: id }),
  })
  .refine((value) => value.migratorRole !== value.runtimeRole);
export const authSchemaRolloutScopeSchema = z.strictObject({
  authority: hostedTenantAuthoritySchema,
  sessionId: id,
  profileId: id,
});
export type AuthSchemaRolloutScope = z.infer<typeof authSchemaRolloutScopeSchema>;
export const authSchemaRolloutWorkerSchema = z.strictObject({
  executablePath: id,
  id: z.literal("auth-protected-schema-v1"),
  operationScope: z.literal("auth-protected-schema-v1"),
  subcommand: z.literal("auth-protected-schema"),
  sha256: hash,
  sourceCapture: operatorWorkerSourceCaptureSchema.extend({ family: z.literal("auth") }),
});
export const authSchemaRolloutRuntimeSchema = z.strictObject({
  sandbox: z.union([
    z.strictObject({ image: id, projectId: id, teamId: id }),
    z.strictObject({
      source: z.strictObject({ type: z.literal("snapshot"), snapshotId: id }),
      projectId: id,
      teamId: id,
    }),
  ]),
  worker: authSchemaRolloutWorkerSchema,
  proposalWorker: z.strictObject({
    executablePath: id,
    id,
    sha256: hash,
    sourceCapture: operatorWorkerSourceCaptureSchema.extend({ family: z.literal("authProposal") }),
  }),
  catalogAppIds: z.array(id).min(1),
  migrationConnectionEnvironment: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
});
export type AuthSchemaRolloutRuntime = z.infer<typeof authSchemaRolloutRuntimeSchema>;
export const authSchemaRolloutApprovalSchema = z.strictObject({
  version: z.literal(1),
  operationRef: z.uuid(),
  scope: authSchemaRolloutScopeSchema,
  planDigest: hash,
  resource: productionAuthResourceSchema,
  resourceLabel: id,
  authOperatorRole: authSchemaSqlRoleSchema,
  schemaPlanDigest: hash,
  targetDigest: hash,
  workerSha256: hash,
  sourceCapture: operatorWorkerSourceCaptureSchema,
  effects: z.array(z.strictObject({ owner: id, sql: z.string(), sha256: hash })),
});
export type AuthSchemaRolloutApproval = z.infer<typeof authSchemaRolloutApprovalSchema>;
export const authSchemaRolloutStatusSchema = z.strictObject({
  version: z.literal(1),
  operationRef: z.uuid(),
  state: z.enum(["planned", "pending", "reconciling", "ready"]),
  readbackSha256: hash.optional(),
});
export const authSchemaRolloutPlanResponseSchema = z.strictObject({
  version: z.literal(1),
  plan: authSchemaRolloutApprovalSchema,
});
export const authSchemaRolloutRecordSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("production-auth-schema-rollout-v1"),
  plan: authSchemaRolloutApprovalSchema,
  runtime: authSchemaRolloutRuntimeSchema,
  proposal: z.json(),
  operatorPlan: z.json(),
  state: authSchemaRolloutStatusSchema.shape.state,
  approval: z.strictObject({ approvalId: id, approvedByCallId: id }).optional(),
  approvalObservation: privateOperatorApprovalObservationSchema.optional(),
  lease: z
    .strictObject({ leaseId: z.uuid(), fenceGeneration: z.number().int().positive() })
    .optional(),
  checkpoints: z.array(workerEffectCheckpointFrameSchema),
  readbackSha256: hash.optional(),
});
export type AuthSchemaRolloutRecord = z.infer<typeof authSchemaRolloutRecordSchema>;
export interface AuthSchemaRolloutRow {
  revision: number;
  record: AuthSchemaRolloutRecord;
}
export const authSchemaRolloutDigest = (value: z.infer<ReturnType<typeof z.json>>) =>
  createHash("sha256").update(centralHostCanonicalBytes(value)).digest("hex");
export const authSchemaRolloutOperationRef = (
  scope: AuthSchemaRolloutScope,
  planDigest: string,
) => {
  const digest = authSchemaRolloutDigest(z.json().parse({ scope, planDigest }));
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};
export const authSchemaRolloutPath = "/v1/auth-schema-rollout";
