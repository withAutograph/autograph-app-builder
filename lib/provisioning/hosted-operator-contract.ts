import { createHash } from "node:crypto";
import { z } from "zod";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { hostedPrincipalSchema } from "../eve/hosted-auth";

const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sqlName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u);
const isPublicHttpsOrigin = (url: URL): boolean => {
  if (url.protocol !== "https:") {
    return false;
  }
  if (url.username !== "" || url.password !== "") {
    return false;
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return false;
  }
  if (url.hostname.endsWith(".vercel.run")) {
    return false;
  }
  return true;
};
const httpsPublicOrigin = z
  .url()
  .superRefine((value, ctx) => {
    const url = new URL(value);
    if (!isPublicHttpsOrigin(url)) {
      ctx.addIssue({ code: "custom", message: "Public Gateway origin must be exact HTTPS origin" });
    }
  })
  .transform((value) => new URL(value).origin);
export const operatorSelectionSchema = z.strictObject({
  appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  branch: id.refine((value) => !/[\p{Cc}]/u.test(value)),
  environment: z.literal("preview"),
  projectId: id,
  sessionId: id,
});
const databaseResource = z
  .strictObject({
    database: sqlName,
    migratorRole: sqlName,
    resourceId: id,
    runtimeRole: sqlName,
  })
  .refine((value) => value.runtimeRole !== value.migratorRole);
/** Approval names an exact owned source checkpoint, never a database-name lookup. */
export const sharedAuthAdoptionSchema = z.strictObject({
  kind: z.literal("owned-journal-auth-v1"),
  resource: z.strictObject({
    authDatabase: databaseResource,
    branchId: id,
    endpoint: id,
    endpointId: id,
    projectId: id,
  }),
  source: z.strictObject({
    checkpointSha256: digest,
    journalDigest: digest,
    operationRef: z.uuid(),
    planDigest: digest,
    selection: operatorSelectionSchema,
  }),
});
export type SharedAuthAdoption = z.infer<typeof sharedAuthAdoptionSchema>;
const previewDeploymentSchema = z.strictObject({
  branch: id,
  deploymentId: id.optional(),
  environment: z.literal("preview"),
  projectId: id,
});
const deploymentBoundarySchema = z.strictObject({
  app: previewDeploymentSchema,
  authority: hostedTenantAuthoritySchema,
  gateway: previewDeploymentSchema,
  operator: z.strictObject({
    deploymentId: id,
    environment: z.enum(["preview", "production"]),
    projectId: id,
  }),
  teamId: id,
  verification: z.strictObject({
    gatewayOrigin: httpsPublicOrigin,
    jwksUrl: z.url(),
    publicOrigin: httpsPublicOrigin,
  }),
});

/** Resolved by the protected planner from independently verified owner/provider/artifact state. */
const AUTH_BOOTSTRAP_STAGE = "auth-bootstrap";
const hostedOperatorPlanDataSchema = z.strictObject({
  access: z.array(
    z.strictObject({ actorId: id, organizationId: id, roles: z.array(sqlName).min(1) }),
  ),
  action: z.enum(["prepare", "cleanup"]),
  appDatabase: databaseResource,
  authAdoption: sharedAuthAdoptionSchema.optional(),
  authDatabase: databaseResource,
  authMembership: z
    .strictObject({
      actorId: id,
      bootstrapPlanDigest: digest,
      identityCapture: z.strictObject({
        capturedAt: z.iso.datetime({ offset: true }),
        realmSessionId: id,
      }),
      identityNonceSha256: digest,
      identityProof: z.strictObject({ reference: id, sha256: digest }),
      identityVerification: z.strictObject({
        audience: httpsPublicOrigin,
        issuer: httpsPublicOrigin,
        jwksUrl: z.url(),
        transportSource: z.strictObject({
          audience: z.url(),
          environment: z.enum(["preview", "production"]),
          issuer: z.url(),
          ownerId: id,
          projectId: id,
        }),
      }),
      kind: z.literal("create-owned-organization"),
      name: id,
      organizationId: id,
      slug: id,
    })
    .optional(),
  authSchema: z
    .strictObject({
      artifactRef: id,
      installer: z.strictObject({ reference: id, sha256: digest }),
      planDigest: digest,
      targetDigest: digest,
    })
    .optional(),
  bootstrap: z
    .strictObject({ endpointId: id, maintenanceDatabase: sqlName, role: sqlName })
    .optional(),
  contextId: id,
  cost: z.strictObject({
    class: z.enum(["shared-recovery-group", "independent-service"]),
    description: id,
    owner: id,
  }),
  delivery: z
    .strictObject({
      branch: id,
      gitSha: z
        .string()
        .regex(/^[a-f0-9]{40}$/u)
        .optional(),
      projectId: id,
      repoId: id,
    })
    .optional(),
  deploymentBoundary: deploymentBoundarySchema.optional(),
  effects: z
    .array(
      z.strictObject({
        description: id,
        id,
        kind: z.enum([
          "resources",
          "install",
          "gateway-bindings",
          "gateway-delivery",
          "access",
          "auth-membership",
          "bindings",
          "delivery",
          "revoke",
          "remove-bindings",
          "retire",
        ]),
        resourceId: id.optional(),
      }),
    )
    .min(1),
  gatewayBindings: z
    .strictObject({
      authBrowserOrigin: httpsPublicOrigin,
      builderCallbackOrigin: httpsPublicOrigin,
      catalogAppIds: z.array(id).min(1),
      operatorOrigin: httpsPublicOrigin,
      readonlyAttesters: z
        .strictObject({
          builderProduction: z.strictObject({
            audience: z.url(),
            environment: z.literal("production"),
            issuer: z.url(),
            ownerId: id,
            projectId: id,
          }),
          operatorPreview: z.strictObject({
            audience: z.url(),
            environment: z.literal("preview"),
            issuer: z.url(),
            ownerId: id,
            projectId: id,
          }),
        })
        .optional(),
      sourceWorkload: z.strictObject({
        audience: z.url(),
        environment: z.literal("preview"),
        issuer: z.url(),
        ownerId: id,
        projectId: id,
        subject: id,
      }),
    })
    .optional(),
  gatewayDelivery: z
    .strictObject({
      branch: id,
      gitSha: z
        .string()
        .regex(/^[a-f0-9]{40}$/u)
        .optional(),
      projectId: id,
      repoId: id,
    })
    .optional(),
  installer: z.strictObject({ reference: id, sha256: digest }),
  neon: z.strictObject({
    branchId: id,
    connectionRef: id,
    endpoint: z.string().regex(/^[a-z0-9.-]+\.neon\.tech$/u),
    projectId: id,
    source: z.literal("synthetic-only"),
  }),
  // Optional only when parsing persisted protected-operator-v1 records created before
  // native Gateway origins were part of the verified plan.
  publicGateway: z
    .strictObject({
      branch: id,
      origin: httpsPublicOrigin,
      projectId: id,
    })
    .optional(),
  release: z.strictObject({ artifactRef: id, id, sha256: digest }),
  resourcesInstaller: z.strictObject({ reference: id, sha256: digest }).optional(),
  retention: z.strictObject({ expiresAt: z.iso.datetime({ offset: true }), policy: id }),
  selection: operatorSelectionSchema,
  stage: z.enum([AUTH_BOOTSTRAP_STAGE, "app"]).optional(),
  version: z.literal(1),
});
const validatePlanStage = (
  plan: z.infer<typeof hostedOperatorPlanDataSchema>,
  ctx: z.RefinementCtx,
) => {
  if (
    plan.delivery !== undefined &&
    (plan.delivery.projectId !== plan.selection.projectId ||
      plan.delivery.branch !== plan.selection.branch)
  ) {
    ctx.addIssue({
      code: "custom",
      message: "Deployment delivery must remain in the exact selected Preview project and branch.",
    });
  }
  if (
    (plan.gatewayBindings !== undefined || plan.gatewayDelivery !== undefined) &&
    (plan.publicGateway === undefined || plan.deploymentBoundary === undefined)
  ) {
    ctx.addIssue({
      code: "custom",
      message: "Trusted Gateway effects require the frozen native project and boundary.",
    });
  }
  if (
    plan.gatewayDelivery !== undefined &&
    (plan.gatewayDelivery.projectId !== plan.publicGateway?.projectId ||
      plan.gatewayDelivery.branch !== plan.publicGateway?.branch)
  ) {
    ctx.addIssue({
      code: "custom",
      message: "Gateway delivery must match the exact approved native project and branch.",
    });
  }
  if (plan.stage === AUTH_BOOTSTRAP_STAGE) {
    const invalid = [
      plan.action !== "prepare",
      plan.access.length !== 0,
      plan.authSchema === undefined,
      plan.bootstrap === undefined,
      plan.effects.filter((effect) => effect.kind === "install").length !== 1,
    ].some(Boolean);
    if (invalid) {
      ctx.addIssue({
        code: "custom",
        message:
          "Auth bootstrap prepares resources and one Auth schema only, without actor grants.",
      });
    }
  }
  if (
    plan.effects.some(
      (effect) =>
        effect.kind === "retire" &&
        effect.resourceId !== undefined &&
        effect.resourceId !== plan.appDatabase.resourceId,
    )
  ) {
    ctx.addIssue({
      code: "custom",
      message: "Only the owned app resource may be retired; shared Auth is retained.",
    });
  }
};
const authorizationPhases = (plan: z.infer<typeof hostedOperatorPlanDataSchema>) => {
  let phases = ["revoke", "remove-bindings", "retire"];
  if (plan.action === "prepare") {
    phases = ["resources", "install"];
    if (plan.authMembership !== undefined) {
      phases.push("auth-membership");
    }
    phases.push("access", "bindings");
    if (plan.delivery !== undefined) {
      phases.push("delivery");
    }
  }
  if (plan.stage === AUTH_BOOTSTRAP_STAGE) {
    phases = ["resources", "install"];
  }
  if (plan.gatewayBindings !== undefined) {
    phases.push("gateway-bindings");
  }
  if (plan.gatewayDelivery !== undefined) {
    phases.push("gateway-delivery");
  }
  return phases;
};
const validateAuthAdoption = (
  plan: z.infer<typeof hostedOperatorPlanDataSchema>,
  ctx: z.RefinementCtx,
) => {
  if (plan.authAdoption !== undefined) {
    const { resource, source } = plan.authAdoption;
    const mismatch = [
      JSON.stringify(resource.authDatabase) !== JSON.stringify(plan.authDatabase),
      resource.projectId !== plan.neon.projectId,
      resource.branchId !== plan.neon.branchId,
      resource.endpoint !== plan.neon.endpoint,
      resource.endpointId !== plan.bootstrap?.endpointId,
      source.selection.appId === plan.selection.appId,
      plan.authSchema === undefined,
    ].some(Boolean);
    if (mismatch) {
      ctx.addIssue({
        code: "custom",
        message:
          "Shared Auth adoption must preserve the exact source Auth resource for an independent app.",
      });
    }
  }
};
export const hostedOperatorPlanSchema = hostedOperatorPlanDataSchema.superRefine((plan, ctx) => {
  validateAuthAdoption(plan, ctx);
  if ((plan.bootstrap === undefined) !== (plan.resourcesInstaller === undefined)) {
    ctx.addIssue({
      code: "custom",
      message: "Resource bootstrap requires its pinned installer.",
    });
  }
  if (plan.bootstrap) {
    const { bootstrap } = plan;
    const databases = [plan.authDatabase, plan.appDatabase];
    const roles = databases.flatMap((database) => [database.migratorRole, database.runtimeRole]);
    const resources = plan.effects.filter((effect) => effect.kind === "resources");
    const orderedResources = [
      resources.length === 2,
      resources[0]?.resourceId === plan.authDatabase.resourceId,
      resources[1]?.resourceId === plan.appDatabase.resourceId,
    ].every(Boolean);
    const invalid = [
      new Set(roles).size !== roles.length,
      plan.appDatabase.resourceId === plan.authDatabase.resourceId,
      roles.includes(bootstrap.role),
      databases.some((database) =>
        ["postgres", "neondb", bootstrap.maintenanceDatabase].includes(database.database),
      ),
      plan.action === "prepare" && !orderedResources,
      plan.effects.some(
        (effect) =>
          !["resources", "retire"].includes(effect.kind) && effect.resourceId !== undefined,
      ),
    ].some(Boolean);
    if (invalid) {
      ctx.addIssue({
        code: "custom",
        message: "Bootstrap effects must bind distinct Auth and app resources and roles.",
      });
    }
  } else if (plan.effects.some((effect) => effect.resourceId !== undefined)) {
    ctx.addIssue({
      code: "custom",
      message: "Resource effect bindings require the bootstrap plan.",
    });
  }
  if (
    new Set(plan.effects.map((effect) => effect.id)).size !== plan.effects.length ||
    plan.appDatabase.database === plan.authDatabase.database ||
    plan.appDatabase.runtimeRole === plan.authDatabase.runtimeRole
  ) {
    ctx.addIssue({
      code: "custom",
      message: "Resources and effects must have distinct identities.",
    });
  }
  if (plan.publicGateway && plan.publicGateway.branch !== plan.selection.branch) {
    ctx.addIssue({
      code: "custom",
      message: "Public Gateway origin must be bound to the selected Preview branch.",
      path: ["publicGateway"],
    });
  }
  if (plan.deploymentBoundary !== undefined) {
    const boundary = plan.deploymentBoundary;
    const jwks = new URL(boundary.verification.jwksUrl);
    const invalidBoundary = [
      new Set([boundary.app.projectId, boundary.gateway.projectId, boundary.operator.projectId])
        .size !== 3,
      boundary.app.projectId !== plan.selection.projectId,
      boundary.app.branch !== plan.selection.branch,
      boundary.gateway.branch !== plan.selection.branch,
      plan.publicGateway === undefined,
      boundary.gateway.projectId !== plan.publicGateway?.projectId,
      boundary.verification.publicOrigin !== plan.publicGateway?.origin,
      jwks.origin !== boundary.verification.gatewayOrigin,
      jwks.pathname !== "/_platform/jwks.json",
      jwks.username !== "",
      jwks.password !== "",
      jwks.search !== "",
      jwks.hash !== "",
    ].some(Boolean);
    if (invalidBoundary) {
      ctx.addIssue({
        code: "custom",
        message:
          "App, Gateway and operator require distinct bound deployment identities and exact public verification configuration.",
        path: ["deploymentBoundary"],
      });
    }
  }
  validatePlanStage(plan, ctx);
  // Each phase has an observed receipt, including a no-op verification for already-existing resources.
  // Authority is opened only after install/grant verification, and closed before retirement.
  const phases = authorizationPhases(plan);
  const kinds = plan.effects.map((effect) => effect.kind);
  const groups = kinds.filter((kind, index) => index === 0 || kind !== kinds[index - 1]);
  if (JSON.stringify(groups) !== JSON.stringify(phases)) {
    ctx.addIssue({
      code: "custom",
      message: "Effects must include every ordered authorization phase.",
    });
  }
});
export type HostedOperatorPlan = z.infer<typeof hostedOperatorPlanSchema>;
export type OperatorSelection = z.infer<typeof operatorSelectionSchema>;
export const operatorReceiptSchema = z.strictObject({
  effectId: id,
  /** Present on new protected grant/revoke checkpoints; absent in existing v1 receipts. */
  fenceGeneration: z.number().int().positive().optional(),
  observedAt: z.iso.datetime({ offset: true }),
  resourceVersion: id,
});
export type OperatorReceipt = z.infer<typeof operatorReceiptSchema>;
const workerReceiptSchema = z
  .strictObject({
    readbackSha256: digest.optional(),
    state: z.enum(["applied", "no_change", "unknown"]),
  })
  .superRefine((receipt, context) => {
    if (receipt.state === "unknown" && receipt.readbackSha256 !== undefined) {
      context.addIssue({ code: "custom", message: "Unknown worker readback cannot include facts" });
    }
    if (receipt.state !== "unknown" && receipt.readbackSha256 === undefined) {
      context.addIssue({ code: "custom", message: "Known worker readback requires a digest" });
    }
  });
const positiveSequence = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const workerEffectCheckpointSchema = z.strictObject({
  attemptId: z.uuid(),
  contextDigest: digest,
  effectId: id,
  fenceGeneration: positiveSequence,
  operationRef: z.uuid(),
  parentEffectId: id,
  receipt: workerReceiptSchema,
  resourceId: id,
  sequence: positiveSequence,
  tenantId: id.optional(),
});
export type WorkerEffectCheckpoint = z.infer<typeof workerEffectCheckpointSchema>;
export const workerContextBindingSchema = z.strictObject({ contextDigest: digest });
export type WorkerContextBinding = z.infer<typeof workerContextBindingSchema>;
export const workerEffectCheckpointFrameSchema = z.strictObject({
  contextDigest: digest,
  effectId: id,
  fenceGeneration: positiveSequence,
  operationId: z.uuid(),
  receipt: workerReceiptSchema,
  resourceId: id,
  sequence: positiveSequence,
  tenantId: id.nullable().optional(),
});
export type WorkerEffectCheckpointFrame = z.infer<typeof workerEffectCheckpointFrameSchema>;
export const operatorRealmIdentityLinkSchema = z
  .strictObject({
    audience: httpsPublicOrigin,
    authResourceId: id,
    bootstrapPlanDigest: digest,
    browserOrigin: httpsPublicOrigin,
    consumedAt: z.iso.datetime({ offset: true }).optional(),
    endpointOrigin: httpsPublicOrigin,
    expiresAt: z.iso.datetime({ offset: true }),
    issuer: httpsPublicOrigin,
    nonceSha256: digest,
    organizationId: id.nullable(),
    ownerSessionId: id,
    proofRef: id.optional(),
    proofSha256: digest.optional(),
    sealedNonce: z
      .strictObject({ encryptedToken: id, keyVersion: id, tokenIv: id, tokenTag: id })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.consumedAt === undefined) !== (value.proofRef === undefined) ||
      (value.proofRef === undefined) !== (value.proofSha256 === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Captured Realm proof must be atomic with nonce consumption.",
      });
    }
  });
export type OperatorRealmIdentityLink = z.infer<typeof operatorRealmIdentityLinkSchema>;
export const projectPendingRealmIdentityLink = (input: OperatorRealmIdentityLink) => {
  const { sealedNonce, ...publicLink } = operatorRealmIdentityLinkSchema.parse(input);
  void sealedNonce;
  return publicLink;
};
export const operatorDeploymentCandidateSchema = z.strictObject({
  branch: id,
  deploymentId: id,
  operationRef: z.uuid(),
  origin: httpsPublicOrigin,
  projectId: id,
  projectName: id.optional(),
  readyState: id,
  repoId: id,
  scopeSlug: id.optional(),
});
export type OperatorDeploymentCandidate = z.infer<typeof operatorDeploymentCandidateSchema>;
export const operatorDeploymentCandidatesSchema = z.array(operatorDeploymentCandidateSchema);
export const operatorAuthSchemaPreparationSchema = z.strictObject({
  assetSha256: digest,
  catalogFingerprint: digest,
  database: sqlName,
  observedAt: z.iso.datetime({ offset: true }),
  runtimeRole: sqlName,
  targetDigest: digest,
});
export type OperatorAuthSchemaPreparation = z.infer<typeof operatorAuthSchemaPreparationSchema>;
export const managedOperatorEnvironmentRowSchema = z.strictObject({
  branch: id,
  comment: id,
  id,
  key: z.string().regex(/^[A-Z][A-Z0-9_]{0,199}$/u),
  operationRef: z.uuid(),
  projectId: id,
});
export type ManagedOperatorEnvironmentRow = z.infer<typeof managedOperatorEnvironmentRowSchema>;
export const managedOperatorEnvironmentRowsSchema = z.array(managedOperatorEnvironmentRowSchema);
const hostedOperatorRecordDataSchema = z.strictObject({
  approvalId: id.optional(),
  authPreparation: operatorAuthSchemaPreparationSchema.optional(),
  deliveredDeploymentId: id.optional(),
  deliveredGatewayDeploymentId: id.optional(),
  deliveryCandidates: operatorDeploymentCandidatesSchema.optional(),
  /** Shared across Auth and kernel rows; allocated once by the existing journal CAS. */
  fenceGeneration: z.number().int().positive().optional(),
  gatewayDeliveryCandidates: operatorDeploymentCandidatesSchema.optional(),
  gatewayEnvironment: managedOperatorEnvironmentRowsSchema.optional(),
  identityLink: operatorRealmIdentityLinkSchema.optional(),
  managedEnvironment: managedOperatorEnvironmentRowsSchema.optional(),
  mode: z.literal("protected-operator-v1"),
  operationRef: z.uuid(),
  pendingEffectAttempt: z
    .strictObject({ contextDigest: digest.optional(), id: z.uuid() })
    .optional(),
  pendingEffectId: id.optional(),
  plan: hostedOperatorPlanSchema,
  planDigest: digest,
  receipts: z.array(operatorReceiptSchema),
  workerCheckpoints: z.array(workerEffectCheckpointSchema).optional(),
});
const gatewayDeliveryOrigin = (operator: z.infer<typeof hostedOperatorRecordDataSchema>) =>
  operator.gatewayDeliveryCandidates?.find(
    (candidate) =>
      candidate.deploymentId === operator.deliveredGatewayDeploymentId &&
      candidate.readyState === "READY",
  )?.origin;
// oxlint-disable-next-line eslint/complexity, sonarjs/expression-complexity -- Frozen identity link and actual delivered candidate identities require every exact binding.
const validateOperatorMetadata = (
  operator: z.infer<typeof hostedOperatorRecordDataSchema>,
  context: z.RefinementCtx,
) => {
  const link = operator.identityLink;
  if (link !== undefined) {
    const matches = [
      link.authResourceId === operator.plan.authDatabase.resourceId,
      link.browserOrigin === operator.plan.gatewayBindings?.authBrowserOrigin,
      link.ownerSessionId === operator.plan.selection.sessionId,
      link.issuer === operator.plan.deploymentBoundary?.verification.publicOrigin,
      link.endpointOrigin === operator.plan.deploymentBoundary?.verification.gatewayOrigin ||
        gatewayDeliveryOrigin(operator) === link.endpointOrigin,
    ].every(Boolean);
    if (!matches) {
      context.addIssue({
        code: "custom",
        message:
          "Realm identity link must match the owned Auth resource, exact issuer and canonical owner session.",
      });
    }
  }
  const gatewayCandidates = operator.gatewayDeliveryCandidates ?? [];
  if (
    new Set(gatewayCandidates.map((value) => value.deploymentId)).size !==
      gatewayCandidates.length ||
    gatewayCandidates.some(
      (value) =>
        value.projectId !== operator.plan.publicGateway?.projectId ||
        value.branch !== operator.plan.publicGateway?.branch,
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Gateway candidates must belong to the exact approved native project and branch.",
    });
  }
  if (
    operator.deliveredGatewayDeploymentId !== undefined &&
    !gatewayCandidates.some(
      (value) =>
        value.deploymentId === operator.deliveredGatewayDeploymentId &&
        value.readyState === "READY",
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Only an independently READY Gateway candidate may be pinned.",
    });
  }
  const candidates = operator.deliveryCandidates ?? [];
  if (
    new Set(candidates.map((value) => value.deploymentId)).size !== candidates.length ||
    candidates.some(
      (value) =>
        value.projectId !== operator.plan.selection.projectId ||
        value.branch !== operator.plan.selection.branch,
    )
  ) {
    context.addIssue({
      code: "custom",
      message:
        "Deployment candidates must remain within their approved project and Preview branch.",
    });
  }
  if (
    operator.deliveredDeploymentId !== undefined &&
    !candidates.some(
      (value) =>
        value.deploymentId === operator.deliveredDeploymentId &&
        value.readyState === "READY" &&
        value.operationRef === operator.operationRef,
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Only an observed READY deployment of this approved delivery may be selected.",
    });
  }
};
export const hostedOperatorRecordSchema = hostedOperatorRecordDataSchema.superRefine(
  (operator, context) => {
    validateOperatorMetadata(operator, context);
    const environmentRows = operator.managedEnvironment ?? [];
    const appKey = `${operator.plan.selection.appId.toUpperCase().replaceAll("-", "_")}_DATABASE_URL`;
    const ownedKeys = new Set([
      appKey,
      "PLATFORM_ORIGIN",
      "PLATFORM_PUBLIC_ORIGIN",
      "PLATFORM_JWKS_URL",
      "PLATFORM_APP_BOUNDARY",
    ]);
    if (
      new Set(environmentRows.map((row) => row.key)).size !== environmentRows.length ||
      new Set(environmentRows.map((row) => row.id)).size !== environmentRows.length ||
      environmentRows.some(
        (row) =>
          row.projectId !== operator.plan.selection.projectId ||
          row.branch !== operator.plan.selection.branch ||
          !ownedKeys.has(row.key) ||
          row.comment !== `App Builder protected operator ${row.operationRef}`,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Managed environment rows must belong to this approved app operation.",
        path: ["managedEnvironment"],
      });
    }
    const gatewayRows = operator.gatewayEnvironment ?? [];
    const gatewayKeys = new Set([
      "AUTH_DATABASE_RESOURCE",
      "PLATFORM_AUTH_DATABASE_URL",
      "PLATFORM_GATEWAY_PROTECTED_APPLICATIONS",
      "PLATFORM_REALM_OPERATOR_LINK_CONFIG",
      "PLATFORM_GATEWAY_PROJECT_BINDINGS",
    ]);
    if (
      new Set(gatewayRows.map((row) => row.key)).size !== gatewayRows.length ||
      new Set(gatewayRows.map((row) => row.id)).size !== gatewayRows.length ||
      gatewayRows.some(
        (row) =>
          row.projectId !== operator.plan.publicGateway?.projectId ||
          row.branch !== operator.plan.publicGateway?.branch ||
          !gatewayKeys.has(row.key) ||
          row.comment !== `App Builder protected operator ${row.operationRef}`,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Gateway rows must remain in the owned trusted project.",
        path: ["gatewayEnvironment"],
      });
    }
    const resources = new Set([
      operator.plan.appDatabase.resourceId,
      operator.plan.authDatabase.resourceId,
    ]);
    const tenants = new Set(operator.plan.access.map((target) => target.organizationId));
    const effects = new Set(operator.plan.effects.map((effect) => effect.id));
    for (const [index, checkpoint] of (operator.workerCheckpoints ?? []).entries()) {
      const invalidIdentity =
        checkpoint.operationRef !== operator.operationRef ||
        operator.fenceGeneration === undefined ||
        checkpoint.fenceGeneration !== operator.fenceGeneration;
      const outsidePlan =
        !resources.has(checkpoint.resourceId) ||
        !effects.has(checkpoint.parentEffectId) ||
        (checkpoint.tenantId !== undefined && !tenants.has(checkpoint.tenantId));
      if (invalidIdentity || outsidePlan) {
        context.addIssue({
          code: "custom",
          message: "Worker checkpoint is outside the frozen operator plan",
          path: ["workerCheckpoints", index],
        });
      }
    }
  },
);
export const operatorPlanDigest = (input: HostedOperatorPlan) =>
  createHash("sha256")
    .update(JSON.stringify(hostedOperatorPlanSchema.parse(input)))
    .digest("hex");
/** Private server-derived claims; the operator re-reads their durable authority. */
const ownerContextBaseSchema = z.strictObject({
  adapterGeneration: z.number().int().positive(),
  adapterSessionId: z.string().min(1).max(200),
  authority: hostedTenantAuthoritySchema,
  principal: hostedPrincipalSchema,
  sessionId: z.string().min(1).max(200),
});
const handoffOwnerContextSchema = ownerContextBaseSchema.extend({
  kind: z.literal("handoff"),
  sourceHandoffId: z.uuid(),
});
const directOwnerContextSchema = ownerContextBaseSchema.extend({ kind: z.literal("direct") });
const legacyHandoffOwnerContextSchema = ownerContextBaseSchema.extend({
  sourceHandoffId: z.uuid(),
});
export const operatorOwnerContextSchema = z
  .union([handoffOwnerContextSchema, directOwnerContextSchema, legacyHandoffOwnerContextSchema])
  .transform((value) => ("kind" in value ? value : { ...value, kind: "handoff" as const }))
  .superRefine((value, context) => {
    if (
      (["audience", "issuer", "ownerUserId", "workspaceId"] as const).some(
        (key) => value.principal[key] !== value.authority[key],
      )
    ) {
      context.addIssue({ code: "custom", message: "Operator owner claims disagree" });
    }
  });
export type OperatorOwnerContext = z.infer<typeof operatorOwnerContextSchema>;
export const operatorRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("neon-authorization"),
    callbackUrl: z.url().optional(),
    ownerContext: operatorOwnerContextSchema.optional(),
    phase: z.enum(["check", "start", "complete"]),
    sessionId: id,
  }),
  z.strictObject({
    action: z.literal("plan"),
    operation: z.enum(["prepare", "cleanup"]),
    ownerContext: operatorOwnerContextSchema.optional(),
    selection: operatorSelectionSchema,
  }),
  z.strictObject({
    action: z.literal("execute"),
    callId: id,
    operationRef: z.uuid(),
    ownerContext: operatorOwnerContextSchema.optional(),
    planDigest: digest,
    selection: operatorSelectionSchema,
  }),
  z.strictObject({
    action: z.literal("status"),
    operationRef: z.uuid(),
    ownerContext: operatorOwnerContextSchema.optional(),
    selection: operatorSelectionSchema,
  }),
  z.strictObject({
    action: z.literal("bindings"),
    operationRef: z.uuid(),
    ownerContext: operatorOwnerContextSchema.optional(),
    selection: operatorSelectionSchema,
  }),
  z.strictObject({
    action: z.literal("auth-identity-input"),
    operationRef: z.uuid(),
    ownerContext: operatorOwnerContextSchema.optional(),
    selection: operatorSelectionSchema,
  }),
]);
export type OperatorRequest = z.infer<typeof operatorRequestSchema>;
export const operatorAuthIdentityInputSchema = z.strictObject({
  browserUrl: z.url().startsWith("https://"),
  expiresAt: z.iso.datetime({ offset: true }),
  operationRef: z.uuid(),
  sessionId: id,
});
export const operatorPublicResultSchema = z.strictObject({
  appId: id,
  authenticatedBehavior: z.literal("unassessed"),
  code: z
    .enum([
      "protected_operator_required",
      "auth_identity_required",
      "auth_membership_required",
      "auth_schema_not_ready",
      "authorization_required",
      "resource_mismatch",
      "operation_in_progress",
      "reconciliation_required",
      "operator_unavailable",
      "legacy_runtime_requires_migration",
    ])
    .optional(),
  operationRef: z.uuid().optional(),
  plan: hostedOperatorPlanSchema.optional(),
  planDigest: digest.optional(),
  status: z.enum(["planned", "pending", "prepared", "cleaned", "blocked", "auth-schema-prepared"]),
});
export type OperatorPublicResult = z.infer<typeof operatorPublicResultSchema>;
export class HostedOperatorError extends Error {
  readonly code: NonNullable<OperatorPublicResult["code"]>;
  constructor(code: NonNullable<OperatorPublicResult["code"]>) {
    super(code);
    this.name = "HostedOperatorError";
    this.code = code;
  }
}

/** Public runtime/verifier facts; credentials remain in the app-specific URL alone. */
export const protectedAppBoundarySchema = z.strictObject({
  appId: operatorSelectionSchema.shape.appId,
  mode: z.literal("protected-gateway-v1"),
  runtime: z.strictObject({
    database: sqlName,
    environment: z.enum(["local", "hosted"]),
    hostname: z.string().min(1),
    port: z.number().int().min(1).max(65_535),
    runtimeRole: sqlName,
  }),
  verification: z.strictObject({ jwksUrl: z.url(), publicOrigin: httpsPublicOrigin }),
  version: z.literal(1),
});
export type ProtectedAppBoundary = z.infer<typeof protectedAppBoundarySchema>;
export type ProtectedAppEnvironment = Record<string, string> & { PLATFORM_APP_BOUNDARY: string };
const publicAppBoundary = (plan: HostedOperatorPlan): ProtectedAppBoundary => {
  const boundary = plan.deploymentBoundary;
  if (boundary === undefined) {
    throw new HostedOperatorError("legacy_runtime_requires_migration");
  }
  return protectedAppBoundarySchema.parse({
    appId: plan.selection.appId,
    mode: "protected-gateway-v1",
    runtime: {
      database: plan.appDatabase.database,
      environment: "hosted",
      hostname: plan.neon.endpoint,
      port: 5432,
      runtimeRole: plan.appDatabase.runtimeRole,
    },
    verification: {
      jwksUrl: boundary.verification.jwksUrl,
      publicOrigin: boundary.verification.publicOrigin,
    },
    version: 1,
  });
};

/** Public plan data is not provider proof. The trusted binding adapter must read current
 * project ownership/deployment environments before projecting this narrow app boundary. */
export const restrictedOperatorEnvironment = (
  plan: HostedOperatorPlan,
  input: Record<string, string>,
  authenticatedAuthority?: z.infer<typeof hostedTenantAuthoritySchema>,
): ProtectedAppEnvironment => {
  const parsedPlan = hostedOperatorPlanSchema.parse(plan);
  const boundary = parsedPlan.deploymentBoundary;
  if (boundary === undefined || authenticatedAuthority === undefined) {
    throw new HostedOperatorError("legacy_runtime_requires_migration");
  }
  const authority = hostedTenantAuthoritySchema.parse(authenticatedAuthority);
  if (JSON.stringify(boundary.authority) !== JSON.stringify(authority)) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const env = z.record(z.string(), z.string()).parse(input);
  const appKey = `${parsedPlan.selection.appId.toUpperCase().replaceAll("-", "_")}_DATABASE_URL`;
  const keys = [appKey, "PLATFORM_JWKS_URL", "PLATFORM_ORIGIN", "PLATFORM_PUBLIC_ORIGIN"];
  const allowedKeys = new Set([...keys, "PLATFORM_APP_BOUNDARY"]);
  if (Object.keys(env).some((key) => !allowedKeys.has(key)) || keys.some((key) => !env[key])) {
    throw new HostedOperatorError("resource_mismatch");
  }
  if (
    env.PLATFORM_PUBLIC_ORIGIN !== boundary.verification.publicOrigin ||
    env.PLATFORM_ORIGIN !== boundary.verification.gatewayOrigin ||
    env.PLATFORM_JWKS_URL !== boundary.verification.jwksUrl
  ) {
    throw new HostedOperatorError("resource_mismatch");
  }
  let url: URL;
  try {
    url = new URL(env[appKey]);
  } catch {
    throw new HostedOperatorError("resource_mismatch");
  }
  const resource = parsedPlan.appDatabase;
  const valid = [
    ["postgres:", "postgresql:"].includes(url.protocol),
    url.hostname === parsedPlan.neon.endpoint,
    url.pathname === `/${resource.database}`,
    decodeURIComponent(url.username) === resource.runtimeRole,
    url.password !== "",
    ["", "5432"].includes(url.port),
    url.hash === "",
    url.searchParams.getAll("sslmode").length === 1,
    url.searchParams.get("sslmode") === "verify-full",
    [...url.searchParams.keys()].every((name) => ["sslmode", "channel_binding"].includes(name)),
    url.searchParams.getAll("channel_binding").length <= 1,
    !url.searchParams.has("channel_binding") ||
      url.searchParams.get("channel_binding") === "require",
  ];
  if (valid.includes(false)) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const expectedBoundary = publicAppBoundary(parsedPlan);
  if (env.PLATFORM_APP_BOUNDARY !== undefined) {
    try {
      const provided = protectedAppBoundarySchema.parse(JSON.parse(env.PLATFORM_APP_BOUNDARY));
      if (JSON.stringify(provided) !== JSON.stringify(expectedBoundary)) {
        throw new HostedOperatorError("resource_mismatch");
      }
    } catch {
      throw new HostedOperatorError("resource_mismatch");
    }
  }
  return { ...env, PLATFORM_APP_BOUNDARY: JSON.stringify(expectedBoundary) };
};

export const sameOperatorSelection = (left: OperatorSelection, right: OperatorSelection) =>
  (["appId", "branch", "environment", "projectId", "sessionId"] as const).every(
    (key) => left[key] === right[key],
  );
