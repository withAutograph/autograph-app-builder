import { createHash } from "node:crypto";
import { z } from "zod";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { operatorOwnerContextSchema } from "./hosted-operator-contract";
import { centralHostCanonicalBytes } from "./central-integration-host-contract";

const REPOSITORY_PRODUCTION_SETUP_KIND = "repository-production-setup-v1";

const id = z.string().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const sqlName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u);
export const repositoryProductionScopeSchema = z.strictObject({
  authority: hostedTenantAuthoritySchema,
  appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  repositoryId: id,
  repositoryFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/u),
  projectId: id,
  organizationId: id,
  publicOrigin: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
  }),
  environment: z.literal("production"),
});
export type RepositoryProductionScope = z.infer<typeof repositoryProductionScopeSchema>;
export const repositoryProductionIntentSchema = z.strictObject({
  sessionId: id,
  sourceSha: z.string().regex(/^[a-f0-9]{40,64}$/u),
  creatorRoles: z.array(id),
  storage: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("none") }),
    z.strictObject({
      kind: z.literal("postgres"),
      releaseId: id,
      artifactRef: id,
      manifestSha256: hash,
      databaseEnvironment: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
    }),
  ]),
});
export type RepositoryProductionIntent = z.infer<typeof repositoryProductionIntentSchema>;
export const repositoryProductionResourceSchema = z
  .strictObject({
    resourceId: id,
    database: sqlName,
    runtimeRole: sqlName,
    migratorRole: sqlName,
  })
  .refine((value) => value.runtimeRole !== value.migratorRole);
export type RepositoryProductionResource = z.infer<typeof repositoryProductionResourceSchema>;
export const repositoryProductionEffectSchema = z.enum([
  "allocate-storage",
  "install-schema",
  "creator-access",
  "bind-runtime",
]);
export type RepositoryProductionEffect = z.infer<typeof repositoryProductionEffectSchema>;
const checkpointSchema = z.strictObject({
  state: z.enum(["idle", "pending", "applied"]),
  attemptId: z.uuid().optional(),
  receipt: z.json().optional(),
});
export const repositoryProductionRecordSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal(REPOSITORY_PRODUCTION_SETUP_KIND),
  scope: repositoryProductionScopeSchema,
  intent: repositoryProductionIntentSchema,
  resource: repositoryProductionResourceSchema.optional(),
  privateState: z.json().optional(),
  creatorActorId: id.optional(),
  appAccessUpgrade: z
    .strictObject({
      commandId: z.uuid(),
      state: z.enum(["pending", "applied"]),
    })
    .optional(),
  creatorRoleUpdate: z
    .strictObject({
      commandId: z.uuid(),
      roles: z.array(id),
      state: z.enum(["pending", "applied", "skipped"]),
    })
    .optional(),
  ownerContext: operatorOwnerContextSchema.optional(),
  creatorOwnerContext: operatorOwnerContextSchema.optional(),
  approval: z.strictObject({ planDigest: hash, approvedByCallId: id, approvalId: id }).optional(),
  effects: z.record(repositoryProductionEffectSchema, checkpointSchema),
  workerCheckpoints: z.array(z.json()),
  lease: z
    .strictObject({ leaseId: z.uuid(), fenceGeneration: z.number().int().positive() })
    .optional(),
});
export type RepositoryProductionRecord = z.infer<typeof repositoryProductionRecordSchema>;
export interface RepositoryProductionRow {
  operationRef: string;
  revision: number;
  record: RepositoryProductionRecord;
}
export const repositoryProductionDigest = (value: z.infer<ReturnType<typeof z.json>>) =>
  createHash("sha256").update(centralHostCanonicalBytes(value)).digest("hex");
/** Source revisions and worker sessions never choose a new app resource identity. */
export const repositoryProductionOperationRef = (scope: RepositoryProductionScope) => {
  const digest = repositoryProductionDigest({
    kind: REPOSITORY_PRODUCTION_SETUP_KIND,
    authority: scope.authority,
    appId: scope.appId,
    repositoryId: scope.repositoryId,
    environment: scope.environment,
  });
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};
export const deriveRepositoryProductionResource = (
  scope: RepositoryProductionScope,
): RepositoryProductionResource => {
  const stem = `app_${repositoryProductionOperationRef(scope).replaceAll("-", "")}`;
  return {
    resourceId: `repository-production:${repositoryProductionOperationRef(scope)}`,
    database: stem,
    runtimeRole: `${stem}_r`,
    migratorRole: `${stem}_m`,
  };
};
type InitialRepositoryProductionFields = Pick<
  z.input<typeof repositoryProductionRecordSchema>,
  "version" | "kind" | "scope" | "intent" | "resource"
>;

const initialRepositoryProductionRecordInput = (
  scope: RepositoryProductionScope,
  intent: RepositoryProductionIntent,
) => {
  const fields: InitialRepositoryProductionFields = {
    version: 1,
    kind: REPOSITORY_PRODUCTION_SETUP_KIND,
    scope,
    intent,
  };
  if (intent.storage.kind !== "none") {
    fields.resource = deriveRepositoryProductionResource(scope);
  }
  return {
    ...fields,
    effects: Object.fromEntries(
      repositoryProductionEffectSchema.options.map((effect) => [effect, { state: "idle" }]),
    ),
    workerCheckpoints: [],
  };
};

export const initialRepositoryProductionRecord = (
  scope: RepositoryProductionScope,
  intent: RepositoryProductionIntent,
): RepositoryProductionRecord =>
  repositoryProductionRecordSchema.parse(initialRepositoryProductionRecordInput(scope, intent));
