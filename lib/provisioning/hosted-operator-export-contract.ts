/* oxlint-disable unicorn/prefer-bigint-literals -- The configured ES2018 TypeScript target requires BigInt constructors. */
import { createHash } from "node:crypto";
import { z } from "zod";

// Shared worker wire v1. Builder's separate plan/journal schemas own approval
// authority. Parsing worker metadata never authorizes an export or a download.
const id = z.string().min(1);
const uuid = z.uuid();
const releaseAppMismatchMessage = "Export release belongs to another app";
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const count = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const decimalTotal = (values: string[]) =>
  values.every((value) => /^(?:0|[1-9][0-9]*)$/u.test(value))
    ? values.reduce((sum, value) => sum + BigInt(value), BigInt(0))
    : undefined;
const index = z.number().int().nonnegative().refine(Number.isSafeInteger);
const uuidPart = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const publicCustomerTablesSelection = "public-app-customer-tables-v1";
const artifactPattern = new RegExp(
  `^_protected-operator/artifacts/tenant-export/(${uuidPart})/(${uuidPart})/(data|manifest)/([a-f0-9]{64})$`,
  "u",
);
export const tenantExportArtifactReferenceSchema = z.string().regex(artifactPattern);
const emptyDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export const tenantExportScopeSchema = z.strictObject({ appId: id, customerId: id });
export const tenantExportResourceSchema = z
  .strictObject({
    branchId: id,
    database: id,
    environment: z.enum(["local", "preview", "production"]),
    hostname: id.refine((value) => !/[\s/\\]/u.test(value) && !value.includes("://")),
    migratorRole: id,
    port: z.number().int().min(1).max(65_535),
    projectId: id,
    resourceId: id,
    runtimeRole: id,
    schema: z.literal("public"),
  })

  .refine((value) => value.migratorRole !== value.runtimeRole);
export const tenantExportReleaseSchema = z.strictObject({
  artifactHash: digest,
  id,
  manifestRef: z
    .string()
    .regex(/^_protected-operator\/artifacts\/generated-release\/[a-z][a-z0-9-]*\/[a-f0-9]{64}$/u),
  manifestSha256: digest,
});
export const tenantExportWorkerDescriptorSchema = z.strictObject({
  executablePath: id.refine(
    (value) =>
      value.startsWith("/") &&
      !/[\\\p{Cc}]/u.test(value) &&
      !value.split("/").some((part) => part === ".." || part === "."),
  ),
  id,
  operationScope: z.literal("generated-app-data-export-v1"),
  sha256: digest,
  subcommand: z.literal("protected-generated-app-export"),
});

export const tenantExportWorkerInputSchema = z
  .strictObject({
    attemptId: uuid,
    exportId: uuid,
    format: z.literal("ndjson"),
    kind: z.literal("tenant-export-worker"),
    planDigest: digest,
    release: tenantExportReleaseSchema,
    resource: tenantExportResourceSchema,
    scope: tenantExportScopeSchema,
    selection: z.literal(publicCustomerTablesSelection),
    snapshotId: uuid,
    version: z.literal(1),
  })

  .refine((value) => value.release.manifestRef.split("/")[3] === value.scope.appId, {
    message: releaseAppMismatchMessage,
  });
// Only the trusted executor later supplies the app-migrator connection in its
// command-scoped environment. It is absent from JSON, argv and this contract.
export type TenantExportWorkerInput = z.infer<typeof tenantExportWorkerInputSchema>;

const chunkSchema = z.strictObject({
  artifactRef: tenantExportArtifactReferenceSchema,
  byteLength: count,
  index,
  sha256: digest,
});
export const tenantExportDataMemberSchema = z
  .strictObject({
    byteLength: count,
    chunks: z.array(chunkSchema),
    kind: z.literal("data"),
    name: z.string().regex(/^table-[0-9]+\.ndjson$/u),
    rowCount: count,
    sha256: digest,
    table: z.strictObject({ name: id, schema: z.literal("public") }),
  })

  .superRefine((value, ctx) => {
    if (value.chunks.some((chunk, position) => chunk.index !== position)) {
      ctx.addIssue({ code: "custom", message: "Export chunk order is invalid" });
    }
    if (
      decimalTotal(value.chunks.map((chunk) => chunk.byteLength)) !==
      decimalTotal([value.byteLength])
    ) {
      ctx.addIssue({ code: "custom", message: "Export member byte count differs" });
    }
    if (value.byteLength === "0" && value.sha256 !== emptyDigest) {
      ctx.addIssue({ code: "custom", message: "Empty export member digest differs" });
    }
    for (const chunk of value.chunks) {
      const parts = artifactPattern.exec(chunk.artifactRef);
      if (chunk.byteLength === "0" && chunk.sha256 !== emptyDigest) {
        ctx.addIssue({ code: "custom", message: "Empty export chunk digest differs" });
      }
      if (parts?.[3] !== "data" || parts[4] !== chunk.sha256) {
        ctx.addIssue({ code: "custom", message: "Export chunk reference differs" });
      }
    }
  });
export const tenantExportManifestMemberSchema = z
  .strictObject({
    artifactRef: tenantExportArtifactReferenceSchema,
    byteLength: count,
    kind: z.literal("manifest"),
    name: z.literal("manifest.json"),
    sha256: digest,
  })

  .refine((value) => {
    const parts = artifactPattern.exec(value.artifactRef);
    return parts?.[3] === "manifest" && parts[4] === value.sha256;
  });

export const tenantExportArtifactManifestSchema = z
  .strictObject({
    attemptId: uuid,
    byteLength: count,
    exportId: uuid,
    files: z.array(tenantExportDataMemberSchema),
    format: z.literal("ndjson"),
    kind: z.literal("tenant-export"),
    planDigest: digest,
    release: tenantExportReleaseSchema,
    resource: tenantExportResourceSchema,
    rowCount: count,
    scope: tenantExportScopeSchema,
    snapshotId: uuid,
    version: z.literal(1),
  })

  .superRefine((value, ctx) => {
    if (value.release.manifestRef.split("/")[3] !== value.scope.appId) {
      ctx.addIssue({ code: "custom", message: releaseAppMismatchMessage });
    }
    if (new Set(value.files.map((file) => file.name)).size !== value.files.length) {
      ctx.addIssue({ code: "custom", message: "Export member identity repeats" });
    }
    for (const key of ["rowCount", "byteLength"] as const) {
      if (decimalTotal(value.files.map((file) => file[key])) !== decimalTotal([value[key]])) {
        ctx.addIssue({ code: "custom", message: "Export manifest count differs" });
      }
    }
    for (const file of value.files) {
      for (const chunk of file.chunks) {
        const parts = artifactPattern.exec(chunk.artifactRef);
        if (parts?.[1] !== value.exportId || parts[2] !== value.attemptId) {
          ctx.addIssue({ code: "custom", message: "Export member belongs to another attempt" });
        }
      }
    }
  });
export type TenantExportArtifactManifest = z.infer<typeof tenantExportArtifactManifestSchema>;

const sameFields = (
  left: Record<string, string | number>,
  right: Record<string, string | number>,
) => Object.keys(left).every((key) => left[key] === right[key]);
/** Correlation only; fresh owner, setup and export approval checks belong to the operator. */
export const parseTenantExportManifestForWorker = (
  input: TenantExportWorkerInput,
  output: TenantExportArtifactManifest,
) => {
  const worker = tenantExportWorkerInputSchema.parse(input);
  const manifest = tenantExportArtifactManifestSchema.parse(output);
  if (
    (["exportId", "attemptId", "snapshotId", "planDigest"] as const).some(
      (key) => worker[key] !== manifest[key],
    ) ||
    !sameFields(worker.scope, manifest.scope) ||
    !sameFields(worker.resource, manifest.resource) ||
    !sameFields(worker.release, manifest.release)
  ) {
    throw new Error("tenant_export_scope_mismatch");
  }
  return manifest;
};

/** Versioned cross-repository wire fixture, never an effect authorization. */
export const tenantExportWireFixtureSchema = z
  .strictObject({
    descriptor: tenantExportWorkerDescriptorSchema,
    manifest: tenantExportArtifactManifestSchema,
    manifestMember: tenantExportManifestMemberSchema,
    worker: tenantExportWorkerInputSchema,
  })

  .superRefine((value, ctx) => {
    try {
      parseTenantExportManifestForWorker(value.worker, value.manifest);
    } catch {
      ctx.addIssue({ code: "custom", message: "Export wire scope differs" });
    }
    const parts = artifactPattern.exec(value.manifestMember.artifactRef);
    if (parts?.[1] !== value.worker.exportId || parts[2] !== value.worker.attemptId) {
      ctx.addIssue({ code: "custom", message: "Export manifest belongs to another attempt" });
    }
  });

export type TenantExportScope = z.infer<typeof tenantExportScopeSchema>;
export type TenantExportResource = z.infer<typeof tenantExportResourceSchema>;
export type TenantExportRelease = z.infer<typeof tenantExportReleaseSchema>;
export type TenantExportWorkerDescriptor = z.infer<typeof tenantExportWorkerDescriptorSchema>;
export type TenantExportDataMember = z.infer<typeof tenantExportDataMemberSchema>;
export type TenantExportManifestMember = z.infer<typeof tenantExportManifestMemberSchema>;
export type TenantExportWireFixture = z.infer<typeof tenantExportWireFixtureSchema>;

// Builder-only authority layer. These schemas do not extend preparation state,
// its encryption AAD, its receipts, or the five public MCP tool definitions.
const authoritySchema = z.strictObject({
  audience: id,
  issuer: id,
  ownerUserId: id,
  workspaceId: id,
});
const targetSchema = z.strictObject({ appId: id, branch: id, projectId: id, sessionId: id });
const planRefPattern = new RegExp(`^_protected-operator/export-plans/(${uuidPart})$`, "u");
const planRef = z.string().regex(planRefPattern);
const setupSchema = z.strictObject({
  approvalId: id,
  approvedByCallId: id,
  operationRef: uuid,
  planDigest: digest,
});
export const hostedTenantExportPlanSchema = z
  .strictObject({
    authority: authoritySchema,
    destination: z.strictObject({
      artifactPrefix: id,
      kind: z.literal("owner-private-builder-artifact"),
    }),
    exportId: uuid,
    format: z.literal("ndjson"),
    kind: z.literal("tenant-export-plan"),
    originalSetup: setupSchema,
    planRef,
    release: tenantExportReleaseSchema,
    resource: tenantExportResourceSchema,
    scope: tenantExportScopeSchema,
    selection: z.literal(publicCustomerTablesSelection),
    target: targetSchema,
    version: z.literal(1),
  })

  .superRefine((value, ctx) => {
    if (
      planRefPattern.exec(value.planRef)?.[1] !== value.exportId ||
      value.originalSetup.operationRef === value.exportId
    ) {
      ctx.addIssue({ code: "custom", message: "Export operation identity differs" });
    }
    if (value.scope.appId !== value.target.appId) {
      ctx.addIssue({ code: "custom", message: "Export target scope differs" });
    }
    if (value.release.manifestRef.split("/")[3] !== value.scope.appId) {
      ctx.addIssue({ code: "custom", message: releaseAppMismatchMessage });
    }
    if (
      value.destination.artifactPrefix !==
      `_protected-operator/artifacts/tenant-export/${value.exportId}`
    ) {
      ctx.addIssue({ code: "custom", message: "Export destination differs" });
    }
  });
export type HostedTenantExportPlan = z.infer<typeof hostedTenantExportPlanSchema>;

/** Schema projection gives equivalent input key ordering the same intent digest. */
export const tenantExportPlanDigest = (input: HostedTenantExportPlan): string =>
  createHash("sha256")
    .update(JSON.stringify(hostedTenantExportPlanSchema.parse(input)))
    .digest("hex");

/** Untrusted invocation: all resource, owner and destination choices are server-resolved. */
export const hostedTenantExportRequestSchema = z.strictObject({
  action: z.literal("export"),
  idempotencyKey: id,
  planDigest: digest,
  planRef,
});
export type HostedTenantExportRequest = z.infer<typeof hostedTenantExportRequestSchema>;
export const parseHostedTenantExportRequestForPlan = (
  input: HostedTenantExportRequest,
  planned: HostedTenantExportPlan,
) => {
  const request = hostedTenantExportRequestSchema.parse(input);
  const plan = hostedTenantExportPlanSchema.parse(planned);
  if (request.planRef !== plan.planRef || request.planDigest !== tenantExportPlanDigest(plan)) {
    throw new Error("tenant_export_intent_mismatch");
  }
  return request;
};
const approvalSchema = z.strictObject({
  action: z.literal("export"),
  approvalId: id,
  approvedByCallId: id,
  idempotencyKey: id,
  planDigest: digest,
  planRef,
});
const stateSchema = z.enum([
  "planned",
  "approved",
  "reading",
  "publishing",
  "complete",
  "failed",
  "reconciliation-required",
]);
const completionSchema = z.strictObject({
  attemptId: uuid,
  byteLength: count,
  fileCount: count,
  manifest: tenantExportManifestMemberSchema,
  rowCount: count,
  snapshotId: uuid,
});

const journalIssue = (ctx: z.RefinementCtx) => {
  ctx.addIssue({ code: "custom", message: "Export journal authority or intent differs" });
};

export const tenantExportJournalRecordSchema = z
  .strictObject({
    approval: approvalSchema.optional(),
    attempts: z.array(
      z.strictObject({
        attemptId: uuid,
        snapshotId: uuid.optional(),
        state: z.enum([
          "reserved",
          "reading",
          "publishing",
          "complete",
          "failed",
          "reconciliation-required",
        ]),
      }),
    ),
    authority: authoritySchema,
    claim: z
      .strictObject({
        attemptId: uuid,
        claimId: uuid,
        fenceGeneration: z.number().int().positive().refine(Number.isSafeInteger),
      })

      .optional(),
    completion: completionSchema.optional(),
    fenceGeneration: index,
    idempotencyKey: id,
    kind: z.literal("app-export"),
    plan: hostedTenantExportPlanSchema,
    planDigest: digest,
    requestId: uuid,
    revision: index,
    state: stateSchema,
    target: targetSchema,
    version: z.literal(1),
  })

  .superRefine((value, ctx) => {
    if (
      value.requestId !== value.plan.exportId ||
      !sameFields(value.authority, value.plan.authority) ||
      !sameFields(value.target, value.plan.target)
    ) {
      journalIssue(ctx);
    }
    const parsedPlan = hostedTenantExportPlanSchema.safeParse(value.plan);
    if (!parsedPlan.success) {
      journalIssue(ctx);
      return;
    }
    if (value.planDigest !== tenantExportPlanDigest(parsedPlan.data)) {
      journalIssue(ctx);
    }
    if (
      value.approval &&
      (value.approval.planRef !== value.plan.planRef ||
        value.approval.planDigest !== value.planDigest ||
        value.approval.idempotencyKey !== value.idempotencyKey)
    ) {
      journalIssue(ctx);
    }
  })
  .superRefine((value, ctx) => {
    if (
      ["approved", "reading", "publishing", "complete"].includes(value.state) &&
      !value.approval
    ) {
      journalIssue(ctx);
    }
    if ((value.attempts.length > 0 || value.claim) && !value.approval) {
      journalIssue(ctx);
    }
    if (["reading", "publishing"].includes(value.state) && !value.claim) {
      journalIssue(ctx);
    }
    const attemptIds = new Set(value.attempts.map((attempt) => attempt.attemptId));
    if (attemptIds.size !== value.attempts.length) {
      journalIssue(ctx);
    }
    if (
      value.claim &&
      (value.claim.fenceGeneration !== value.fenceGeneration ||
        !attemptIds.has(value.claim.attemptId))
    ) {
      journalIssue(ctx);
    }
    if (
      value.claim &&
      ["reading", "publishing"].includes(value.state) &&
      value.attempts.find((attempt) => attempt.attemptId === value.claim?.attemptId)?.state !==
        value.state
    ) {
      journalIssue(ctx);
    }
  })
  .superRefine((value, ctx) => {
    if (value.state === "complete" && !value.completion) {
      journalIssue(ctx);
    }
    if (value.completion) {
      const attempt = value.attempts.find(
        (entry) => entry.attemptId === value.completion?.attemptId,
      );
      const reference = artifactPattern.exec(value.completion.manifest.artifactRef);
      const attemptMatches =
        attempt?.state === "complete" && attempt.snapshotId === value.completion.snapshotId;
      const manifestMatches =
        reference?.[1] === value.plan.exportId && reference[2] === value.completion.attemptId;
      if (value.state !== "complete" || !attemptMatches || !manifestMatches) {
        journalIssue(ctx);
      }
    }
  });
export type TenantExportJournalRecord = z.infer<typeof tenantExportJournalRecordSchema>;

export const tenantExportStatusSchema = z
  .strictObject({
    counts: z.strictObject({ byteLength: count, fileCount: count, rowCount: count }).optional(),
    download: z.strictObject({ indexPath: id }).optional(),
    exportId: uuid,
    planRef,
    state: stateSchema,
  })

  .superRefine((value, ctx) => {
    if (planRefPattern.exec(value.planRef)?.[1] !== value.exportId) {
      ctx.addIssue({ code: "custom", message: "Export status identity differs" });
    }
    if (value.state === "complete" && (!value.counts || !value.download)) {
      ctx.addIssue({ code: "custom", message: "Completed export metadata is missing" });
    }
    if (
      value.download &&
      (value.state !== "complete" ||
        value.download.indexPath !== `/api/hosted-operator/exports/${value.exportId}`)
    ) {
      ctx.addIssue({ code: "custom", message: "Export download is unavailable" });
    }
  });
export type TenantExportStatus = z.infer<typeof tenantExportStatusSchema>;

/** Bind retained metadata to current trusted owner context; never infer ownership from app roles. */
export const parseHostedTenantExportPlanForOwner = (
  input: HostedTenantExportPlan,
  expected: {
    authority: z.infer<typeof authoritySchema>;
    target: Pick<z.infer<typeof targetSchema>, "appId" | "sessionId">;
  },
) => {
  const plan = hostedTenantExportPlanSchema.parse(input);
  // Retained exports survive later source/release changes. Execution separately
  // checks the frozen setup/resource selection; current read authority is owner/app/session.
  const ownerTarget = {
    appId: id.parse(expected.target.appId),
    sessionId: id.parse(expected.target.sessionId),
  };
  if (
    !sameFields(plan.authority, authoritySchema.parse(expected.authority)) ||
    !sameFields({ appId: plan.target.appId, sessionId: plan.target.sessionId }, ownerTarget)
  ) {
    throw new Error("tenant_export_owner_mismatch");
  }
  return plan;
};
