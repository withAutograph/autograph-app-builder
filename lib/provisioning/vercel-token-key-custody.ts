import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";

const id = z.string().min(1).max(512);
const instant = z.iso.datetime({ offset: true });
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const custodyKind = "vercel-token-key-custody-v1" as const;
export const custodySecretKey = "VERCEL_INTEGRATION_TOKEN_KEY" as const;
export const custodyVersionKey = "VERCEL_INTEGRATION_TOKEN_KEY_VERSION" as const;
export const canonicalSourceActorSchema = hostedTenantAuthoritySchema;
export type CanonicalSourceActor = z.infer<typeof canonicalSourceActorSchema>;
export const custodyPlanSchema = z.strictObject({
  version: z.literal(1),
  action: z.literal("transfer-active-vercel-token-key-to-operator-preview"),
  operationRef: z.uuid(), ownerSessionId: id, actorAuthorityDigest: digest, installationId: id,
  source: z.strictObject({ teamId: id, projectId: id, environment: z.literal("production"), deploymentId: id,
    key: z.literal(custodySecretKey), versionKey: z.literal(custodyVersionKey), keyVersion: z.literal("v1") }),
  destination: z.strictObject({ teamId: id, projectId: id, environment: z.literal("preview"), gitBranch: z.null(),
    key: z.literal(custodySecretKey), versionKey: z.literal(custodyVersionKey), requiredVersion: z.literal("v1"),
    type: z.literal("sensitive"), write: z.literal("create-only") }),
  approvalExpiresAt: instant,
}).refine((plan) => plan.source.teamId === plan.destination.teamId && plan.source.projectId !== plan.destination.projectId);
export type CustodyPlan = z.infer<typeof custodyPlanSchema>;
export const trustedCustodySetupGrantSchema = z.strictObject({
  version: z.literal(1), scope: z.literal("source-global-active-v1-key-custody"), grantRef: id,
  operationRef: z.uuid(), approvedPlanDigest: digest, originalActor: canonicalSourceActorSchema,
  ownerSessionId: id, approvalRef: id, approvedAt: instant, expiresAt: instant,
});
export type TrustedCustodySetupGrant = z.infer<typeof trustedCustodySetupGrantSchema>;
export const custodySecretMetadataSchema = z.strictObject({
  id, key: z.literal(custodySecretKey), type: z.literal("sensitive"), target: z.tuple([z.literal("preview")]),
  gitBranch: z.null(), projectId: id, teamId: id,
});
export type CustodySecretMetadata = z.infer<typeof custodySecretMetadataSchema>;
export const custodyReceiptSchema = z.strictObject({
  operationRef: z.uuid(), approvalRef: id, planDigest: digest, grantDigest: digest, providerRowId: id,
  keyVersion: z.literal("v1"), receivingDeploymentId: id, verifiedAt: instant, possession: z.literal("verified"),
});
export type CustodyReceipt = z.infer<typeof custodyReceiptSchema>;
export const custodyRecordSchema = z.strictObject({
  kind: z.literal(custodyKind), version: z.literal(1), plan: custodyPlanSchema, planDigest: digest,
  grantRef: id, grantDigest: digest, originalActor: canonicalSourceActorSchema, approvalRef: id,
  phase: z.enum(["reserved", "attempted", "secret-confirmed", "possession-pending", "possession-verified"]),
  leaseId: z.uuid().optional(), leaseExpiresAt: instant.optional(), fenceGeneration: z.number().int().nonnegative(),
  attemptedAt: instant.optional(), secret: custodySecretMetadataSchema.optional(),
  receivingDeploymentId: id.optional(), nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/u).optional(),
  nonceExpiresAt: instant.optional(), nonceConsumedAt: instant.optional(), receipt: custodyReceiptSchema.optional(),
}).superRefine((record, context) => {
  if (record.planDigest !== custodyPlanDigest(record.plan) || record.plan.actorAuthorityDigest !== custodyActorDigest(record.originalActor)) {
    context.addIssue({ code: "custom", message: "Custody identity mismatch." });
  }
  if ((record.leaseId === undefined) !== (record.leaseExpiresAt === undefined)) {
    context.addIssue({ code: "custom", message: "Incomplete custody lease." });
  }
  if (record.phase !== "reserved" && record.attemptedAt === undefined) context.addIssue({ code: "custom", message: "Missing attempted checkpoint." });
  if (["secret-confirmed", "possession-pending", "possession-verified"].includes(record.phase) && record.secret === undefined) context.addIssue({ code: "custom", message: "Missing owned Secret row." });
  if (["possession-pending", "possession-verified"].includes(record.phase) && [record.receivingDeploymentId, record.nonce, record.nonceExpiresAt].some((v) => v === undefined)) context.addIssue({ code: "custom", message: "Missing possession checkpoint." });
  if (record.phase === "possession-verified" && (record.receipt === undefined || record.nonceConsumedAt === undefined)) context.addIssue({ code: "custom", message: "Missing verified receipt." });
});
export type CustodyRecord = z.infer<typeof custodyRecordSchema>;
export interface CustodyJournalRow { record: CustodyRecord; revision: number }
export interface CustodyJournalStore {
  read(input: { authority: CanonicalSourceActor; operationRef: string }): Promise<CustodyJournalRow | undefined>;
  /** Only called under the fixed physical slot lock. Returns all authority tuples, safe metadata only. */
  findSlotClaims(input: { plan: CustodyPlan }): Promise<CustodyJournalRow[]>;
  reserve(input: { authority: CanonicalSourceActor; record: CustodyRecord; now: Date }): Promise<CustodyJournalRow>;
  compareAndSet(input: { authority: CanonicalSourceActor; operationRef: string; expectedRevision: number; record: CustodyRecord; now: Date }): Promise<CustodyJournalRow | undefined>;
}
export interface CustodyFence { operationRef: string; leaseId: string; fenceGeneration: number }
export type CustodyPhysicalLease = <T>(input: { lockKeys: readonly string[]; readCurrentFence: () => Promise<CustodyFence> }, run: (assertFence: () => Promise<void>) => Promise<T>) => Promise<T>;

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([,v]) => v !== undefined).toSorted(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
};
export const custodyDigest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export const custodyPlanDigest = (plan: CustodyPlan) => custodyDigest(custodyPlanSchema.parse(plan));
export const custodyActorDigest = (actor: CanonicalSourceActor) => custodyDigest(canonicalSourceActorSchema.parse(actor));
export const custodyGrantDigest = (grant: TrustedCustodySetupGrant) => custodyDigest(trustedCustodySetupGrantSchema.parse(grant));
export const custodySlotLockKey = (plan: CustodyPlan) => JSON.stringify(["vercel-token-key-custody-slot-v1", plan.destination.teamId, plan.destination.projectId, "preview", null, [custodySecretKey, custodyVersionKey]]);
export class CustodyUnavailableError extends Error { constructor() { super("Key custody is unavailable."); this.name = "CustodyUnavailableError"; } }
export class CustodyReconciliationRequiredError extends Error { constructor() { super("Key custody requires reconciliation."); this.name = "CustodyReconciliationRequiredError"; } }
export const assertCustodyGrant = (plan: CustodyPlan, grant: TrustedCustodySetupGrant, actor: CanonicalSourceActor, now: number) => {
  if (grant.operationRef !== plan.operationRef || grant.approvedPlanDigest !== custodyPlanDigest(plan) || grant.ownerSessionId !== plan.ownerSessionId || custodyActorDigest(actor) !== plan.actorAuthorityDigest || custodyActorDigest(grant.originalActor) !== plan.actorAuthorityDigest || Date.parse(grant.approvedAt) > now || Date.parse(grant.expiresAt) <= now || Date.parse(plan.approvalExpiresAt) <= now || Date.parse(grant.expiresAt) > Date.parse(plan.approvalExpiresAt)) throw new CustodyUnavailableError();
};
export const custodyPossessionContext = (record: CustodyRecord) => {
  if (record.phase !== "possession-pending" || record.nonce === undefined || record.nonceExpiresAt === undefined || record.receivingDeploymentId === undefined) throw new CustodyUnavailableError();
  return canonical({ domain: "autograph-active-v1-key-custody-possession-v1", operationRef: record.plan.operationRef, planDigest: record.planDigest, grantDigest: record.grantDigest, source: record.plan.source, destination: record.plan.destination, keyVersion: "v1", nonce: record.nonce, nonceExpiresAt: record.nonceExpiresAt, fenceGeneration: record.fenceGeneration, receivingDeploymentId: record.receivingDeploymentId });
};
export const createCustodyPossessionProof = (record: CustodyRecord, key: Buffer) => {
  if (key.length !== 32) throw new CustodyUnavailableError();
  return createHmac("sha256", key).update(custodyPossessionContext(record)).digest("hex");
};
export const verifyCustodyPossessionProof = (record: CustodyRecord, key: Buffer, proof: string) => {
  if (!digest.safeParse(proof).success) return false;
  return timingSafeEqual(Buffer.from(createCustodyPossessionProof(record, key), "hex"), Buffer.from(proof, "hex"));
};
