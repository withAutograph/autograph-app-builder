import { createHash } from "node:crypto";
import { z } from "zod";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { hostedPrincipalSchema } from "../eve/hosted-auth";
import {
  normalActorProgramDigest,
  normalActorProgramSchema,
} from "./hosted-operator-normal-actor-program";
import { hostedOperatorAppProjectSettingsSchema } from "./hosted-operator-app-project-settings";
import {
  externallyManagedTrustedSourcesSchema,
  matchesExternalTrustedSources,
} from "./hosted-operator-host-protection";
import { readyDeliveryReplacementIntentSchema } from "./hosted-operator-ready-delivery-replacement-intent";

const GATEWAY_BINDINGS_EFFECT = "gateway-bindings";
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
/** Non-secret provider snapshot approved for read-only cross-journal ownership lookup. */
export const canonicalGatewayEnvironmentRowSchema = z.strictObject({
  branch: id,
  gitBranch: id.nullable().optional(),
  comment: id,
  id,
  key: z.enum([
    "AUTH_DATABASE_RESOURCE",
    "PLATFORM_AUTH_DATABASE_URL",
    "PLATFORM_GATEWAY_PROTECTED_APPLICATIONS",
    "PLATFORM_REALM_OPERATOR_LINK_CONFIG",
    "PLATFORM_GATEWAY_PROJECT_BINDINGS",
  ]),
  operationRef: z.uuid(),
  projectId: id,
  target: z.tuple([z.literal("preview")]),
  type: z.literal("encrypted"),
  valueSha256: digest,
});
export type CanonicalGatewayEnvironmentRow = z.infer<typeof canonicalGatewayEnvironmentRowSchema>;
export const canonicalGatewayEnvironmentRowsSchema = z
  .array(canonicalGatewayEnvironmentRowSchema)
  .min(1);
/** Approval names an exact owned source checkpoint, never a database-name lookup. */
export const sharedAuthAdoptionSchema = z.strictObject({
  gatewayEnvironment: canonicalGatewayEnvironmentRowsSchema.optional(),
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
const AUTH_PARTICIPANTS_STAGE = "auth-participants";
const CREATE_OWNED_ORGANIZATION = "create-owned-organization";
export const hostedOperatorOwnedOrganizationSpecSchema = z.strictObject({
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
  kind: z.literal(CREATE_OWNED_ORGANIZATION),
  name: id,
  organizationId: id,
  slug: id,
});
export type HostedOperatorOwnedOrganizationSpec = z.infer<
  typeof hostedOperatorOwnedOrganizationSpecSchema
>;
export const hostedOperatorAuthMembershipSchema = z.union([
  hostedOperatorOwnedOrganizationSpecSchema,
  z
    .strictObject({
      kind: z.literal("create-owned-organizations"),
      organizations: z.array(hostedOperatorOwnedOrganizationSpecSchema).min(1),
    })
    .superRefine((membership, ctx) => {
      const { organizations } = membership;
      if (
        new Set(organizations.map((organization) => organization.organizationId)).size !==
          organizations.length ||
        new Set(organizations.map((organization) => organization.slug)).size !==
          organizations.length
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Approved organization identities must be unique.",
        });
      }
    }),
]);
export type HostedOperatorAuthMembership = z.infer<typeof hostedOperatorAuthMembershipSchema>;
/** A private target selects one entry without changing the approved whole-plan digest. */
export const selectHostedOperatorOwnedOrganizationSpec = (
  membershipInput: HostedOperatorAuthMembership,
  target?: { organizationId: string },
): HostedOperatorOwnedOrganizationSpec => {
  const membership = hostedOperatorAuthMembershipSchema.parse(membershipInput);
  if (membership.kind === CREATE_OWNED_ORGANIZATION) {
    if (target !== undefined && target.organizationId !== membership.organizationId) {
      throw new Error("auth_membership_target_mismatch");
    }
    return membership;
  }
  const selected = membership.organizations.find(
    (organization) => organization.organizationId === target?.organizationId,
  );
  if (selected === undefined) {
    throw new Error("auth_membership_target_mismatch");
  }
  return selected;
};
/** Public references to the durable first approval; authority is independently read from that journal. */
export const normalActorPreparationSchema = z.strictObject({
  accountOperationRef: z.uuid(),
  programDigest: digest,
  accountPlanDigest: digest,
  accountApprovalId: id,
  accountApprovedByCallId: id,
});
export type NormalActorPreparation = z.infer<typeof normalActorPreparationSchema>;
const hostedOperatorAuthSignupPolicyFieldsSchema = z.strictObject({
  version: z.literal(1),
  policyId: id,
  authResourceId: id,
  appId: operatorSelectionSchema.shape.appId,
  origin: httpsPublicOrigin,
  appPath: z.string().regex(/^\/(?!\/)[^?#\\]*$/u),
  organizationId: id,
  eligibility: z.enum(["public", "approved-email"]),
  allowedEmails: z.array(z.email()).optional(),
  membershipRole: z.literal("member"),
  appRoles: z.array(sqlName).min(1),
});
export const hostedOperatorAuthSignupPolicySchema =
  hostedOperatorAuthSignupPolicyFieldsSchema.superRefine((policy, ctx) => {
    if (policy.eligibility === "approved-email" && (policy.allowedEmails?.length ?? 0) === 0) {
      ctx.addIssue({
        code: "custom",
        message: "Approved-email signup requires eligible accounts.",
      });
    }
    if (
      policy.allowedEmails &&
      new Set(policy.allowedEmails.map((value) => value.toLowerCase())).size !==
        policy.allowedEmails.length
    ) {
      ctx.addIssue({ code: "custom", message: "Signup eligibility entries must be unique." });
    }
  });
export type HostedOperatorAuthSignupPolicy = z.infer<typeof hostedOperatorAuthSignupPolicySchema>;
export const hostedOperatorAuthSignupPolicyInputSchema =
  hostedOperatorAuthSignupPolicyFieldsSchema.omit({
    policyId: true,
    authResourceId: true,
    appId: true,
    origin: true,
  });
export type HostedOperatorAuthSignupPolicyInput = z.infer<
  typeof hostedOperatorAuthSignupPolicyInputSchema
>;
export const managedOperatorEnvironmentRowSchema = z
  .strictObject({
    branch: id,
    gitBranch: id.nullable().optional(),
    comment: id,
    id,
    key: z.string().regex(/^[A-Z][A-Z0-9_]{0,199}$/u),
    operationRef: z.uuid(),
    pendingOperationRef: z.uuid().optional(),
    pendingValueSha256: digest.optional(),
    projectId: id,
    valueSha256: digest.optional(),
  })
  .refine(
    (row) => (row.pendingOperationRef === undefined) === (row.pendingValueSha256 === undefined),
    "Pending Gateway value must bind its operation",
  );
export type ManagedOperatorEnvironmentRow = z.infer<typeof managedOperatorEnvironmentRowSchema>;
export const managedOperatorEnvironmentRowsSchema = z.array(managedOperatorEnvironmentRowSchema);

const REMOVE_APP_BINDINGS = "remove-bindings";
const appPreviewTrustedSource = z.strictObject({
  projectId: id,
  from: z.literal("preview"),
  to: z.literal("preview"),
});
const hostedOperatorPlanDataSchema = z.strictObject({
  access: z.array(
    z.strictObject({ actorId: id, organizationId: id, roles: z.array(sqlName).min(1) }),
  ),
  action: z.enum(["prepare", "cleanup"]),
  releaseIntent: z.literal("prepared-preview").optional(),
  appDatabase: databaseResource,
  /** Schema installation scope is independent of actor and role grants. */
  appInstallation: z.strictObject({ customerIds: z.array(id).min(1) }).optional(),
  appEnvironmentCleanup: managedOperatorEnvironmentRowsSchema.optional(),
  appTrustedSources: z
    .strictObject({
      gatewayPreview: z.strictObject({
        from: z.literal("preview"),
        projectId: id,
        to: z.literal("preview"),
      }),
    })
    .optional(),
  authAdoption: sharedAuthAdoptionSchema.optional(),
  authDatabase: databaseResource,
  authMembership: hostedOperatorAuthMembershipSchema.optional(),
  authSchema: z
    .strictObject({
      artifactRef: id,
      installer: z.strictObject({ reference: id, sha256: digest }),
      planDigest: digest,
      targetDigest: digest,
    })
    .optional(),
  authSignupPolicy: hostedOperatorAuthSignupPolicySchema.optional(),
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
      projectSettings: hostedOperatorAppProjectSettingsSchema.optional(),
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
          GATEWAY_BINDINGS_EFFECT,
          "gateway-delivery",
          "access",
          "auth-membership",
          "auth-signup-policy",
          "normal-accounts",
          "bindings",
          "delivery",
          "revoke",
          REMOVE_APP_BINDINGS,
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
      trustedSources: z
        .union([
          z.strictObject({
            builderProduction: z.strictObject({
              projectId: id,
              from: z.literal("production"),
              to: z.literal("preview"),
            }),
            operatorPreview: z.strictObject({
              projectId: id,
              from: z.literal("preview"),
              to: z.literal("preview"),
            }),
            appPreview: appPreviewTrustedSource.optional(),
          }),
          z.strictObject({ appPreview: appPreviewTrustedSource }),
        ])
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
  hostProtection: externallyManagedTrustedSourcesSchema.optional(),
  appDeliveryReplacement: readyDeliveryReplacementIntentSchema.optional(),
  neon: z.strictObject({
    branchId: id,
    connectionRef: id,
    endpoint: z.string().regex(/^[a-z0-9.-]+\.neon\.tech$/u),
    projectId: id,
    source: z.literal("synthetic-only"),
  }),
  normalActorProgram: normalActorProgramSchema.optional(),
  normalActorPreparation: normalActorPreparationSchema.optional(),
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
  stage: z.enum([AUTH_BOOTSTRAP_STAGE, AUTH_PARTICIPANTS_STAGE, "app"]).optional(),
  version: z.literal(1),
});
export const plannedAppBranch = (plan: z.infer<typeof hostedOperatorPlanDataSchema>) =>
  plan.deploymentBoundary?.app.branch ?? plan.selection.branch;
const boundaryAppBranch = (plan: z.infer<typeof hostedOperatorPlanDataSchema>) =>
  plan.action === "cleanup"
    ? plannedAppBranch(plan)
    : (plan.delivery?.branch ?? plan.selection.branch);
const validatePlanStage = (
  plan: z.infer<typeof hostedOperatorPlanDataSchema>,
  ctx: z.RefinementCtx,
) => {
  if (
    plan.delivery !== undefined &&
    (plan.delivery.projectId !== plan.selection.projectId ||
      plan.delivery.branch !== plannedAppBranch(plan))
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
const validateNormalActorPlan = (
  plan: z.infer<typeof hostedOperatorPlanDataSchema>,
  ctx: z.RefinementCtx,
) => {
  const program = plan.normalActorProgram;
  const participantStage = plan.stage === AUTH_PARTICIPANTS_STAGE;
  if (program === undefined) {
    if (participantStage || plan.normalActorPreparation !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Participant authority requires its approved program.",
      });
    }
    return;
  }
  const sameScope = [
    program.appId === plan.selection.appId,
    program.origin === plan.deploymentBoundary?.verification.publicOrigin,
    plan.publicGateway?.origin === program.origin,
  ].every(Boolean);
  if (!sameScope) {
    ctx.addIssue({
      code: "custom",
      message: "Participant program must bind the selected app and verified native public origin.",
    });
  }
  if (plan.stage === AUTH_BOOTSTRAP_STAGE) {
    if (plan.normalActorPreparation !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Auth bootstrap cannot claim completed participant approval.",
      });
    }
    return;
  }
  if (participantStage) {
    const accountOnly = [
      plan.action === "prepare",
      plan.access.length === 0,
      plan.authMembership === undefined,
      plan.normalActorPreparation === undefined,
    ].every(Boolean);
    if (!accountOnly) {
      ctx.addIssue({
        code: "custom",
        message:
          "Participant preparation authorizes normal accounts only, before the resolved organization and access approval.",
      });
    }
    return;
  }
  const preparation = plan.normalActorPreparation;
  if (
    plan.stage !== "app" ||
    preparation === undefined ||
    preparation.programDigest !== normalActorProgramDigest(program)
  ) {
    ctx.addIssue({
      code: "custom",
      message:
        "Resolved participant plans require their original account approval and unchanged program.",
    });
  }
  const membership = plan.authMembership;
  let organizations: HostedOperatorOwnedOrganizationSpec[] = [];
  if (membership !== undefined) {
    organizations =
      membership.kind === CREATE_OWNED_ORGANIZATION ? [membership] : membership.organizations;
  }
  const approvedOrganizations = organizations.every((organization) =>
    program.organizations.some((approved) =>
      [
        approved.organizationId === organization.organizationId,
        approved.name === organization.name,
        approved.slug === organization.slug,
      ].every(Boolean),
    ),
  );
  const approvedRoles = plan.access.every((grant) =>
    program.appAccess.some(
      (approved) =>
        approved.organizationId === grant.organizationId &&
        grant.roles.every((role) => approved.roles.includes(role)),
    ),
  );
  if (!approvedOrganizations || !approvedRoles) {
    ctx.addIssue({
      code: "custom",
      message:
        "Resolved organization and role effects must remain inside the original participant program.",
    });
  }
};
const validateAuthSignupPolicy = (
  plan: z.infer<typeof hostedOperatorPlanDataSchema>,
  ctx: z.RefinementCtx,
) => {
  const policy = plan.authSignupPolicy;
  if (!policy) {
    return;
  }
  const membership = plan.authMembership;
  let orgs: { organizationId: string }[] = [];
  if (membership !== undefined) {
    orgs = membership.kind === CREATE_OWNED_ORGANIZATION ? [membership] : membership.organizations;
  }
  const policyOrganizationApproved =
    orgs.some((organization) => organization.organizationId === policy.organizationId) ||
    plan.access.some((grant) => grant.organizationId === policy.organizationId);
  const policyTargetApproved =
    policy.authResourceId === plan.authDatabase.resourceId &&
    policy.appId === plan.selection.appId &&
    policy.origin === plan.deploymentBoundary?.verification.publicOrigin;
  const policyEffectsApproved =
    policyOrganizationApproved &&
    policy.appRoles.every((role) => !["owner", "admin"].includes(role));
  if (
    plan.action !== "prepare" ||
    plan.stage !== "app" ||
    !policyTargetApproved ||
    !policyEffectsApproved
  ) {
    ctx.addIssue({
      code: "custom",
      message:
        "App signup policy must remain within the approved Auth resource, app, organization and roles.",
      path: ["authSignupPolicy"],
    });
  }
};
const authorizationPhases = (plan: z.infer<typeof hostedOperatorPlanDataSchema>) => {
  if (plan.stage === AUTH_PARTICIPANTS_STAGE) {
    return ["normal-accounts"];
  }
  let phases = ["revoke", REMOVE_APP_BINDINGS, "retire"];
  if (plan.action === "prepare") {
    phases = ["resources", "install"];
    if (plan.authMembership !== undefined) {
      phases.push("auth-membership");
    }
    if (plan.authSignupPolicy !== undefined) {
      phases.push("auth-signup-policy");
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
    phases.push(GATEWAY_BINDINGS_EFFECT);
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
const validateAppEnvironmentCleanup = (
  plan: z.infer<typeof hostedOperatorPlanDataSchema>,
  ctx: z.RefinementCtx,
) => {
  if (plan.appEnvironmentCleanup !== undefined) {
    const appKey = `${plan.selection.appId.toUpperCase().replaceAll("-", "_")}_DATABASE_URL`;
    const keys = new Set([
      appKey,
      "PLATFORM_ORIGIN",
      "PLATFORM_PUBLIC_ORIGIN",
      "PLATFORM_JWKS_URL",
      "PLATFORM_APP_BOUNDARY",
    ]);
    if (
      plan.action !== "cleanup" ||
      !plan.effects.some((effect) => effect.kind === REMOVE_APP_BINDINGS) ||
      plan.appEnvironmentCleanup.some(
        (row) =>
          row.projectId !== plan.selection.projectId ||
          !keys.has(row.key) ||
          row.comment !== `App Builder protected operator ${row.operationRef}`,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "App environment cleanup must name only the explicitly approved owned app rows.",
      });
    }
  }
};
const validateAppTrustedSources = (
  plan: z.infer<typeof hostedOperatorPlanDataSchema>,
  ctx: z.RefinementCtx,
) => {
  const gatewayPreview = plan.appTrustedSources?.gatewayPreview;
  if (gatewayPreview === undefined) {
    return;
  }

  const boundary = plan.deploymentBoundary;
  const sourceWorkload = plan.gatewayBindings?.sourceWorkload;
  const checks = {
    action: plan.action === "prepare",
    stage: plan.stage === "app",
    bindingEffect: plan.effects.some((effect) => effect.kind === "bindings"),
    deliveryEffect: plan.effects.some((effect) => effect.kind === "delivery"),
    boundary: boundary !== undefined,
    workload: sourceWorkload !== undefined,
    workloadEnvironment: sourceWorkload?.environment === "preview",
    sourceProject: sourceWorkload?.projectId === gatewayPreview.projectId,
    gatewayProject: sourceWorkload?.projectId === boundary?.gateway.projectId,
    team: sourceWorkload?.ownerId === boundary?.teamId,
    gatewayEnvironment: boundary?.gateway.environment === "preview",
    appEnvironment: boundary?.app.environment === "preview",
    appProject: boundary?.app.projectId === plan.selection.projectId,
    deliveryProject: plan.delivery?.projectId === boundary?.app.projectId,
  };
  const valid = Object.values(checks).every(Boolean);
  if (!valid) {
    ctx.addIssue({
      code: "custom",
      message:
        "The app Preview grant must name its configured Gateway Preview workload and selected app deployment.",
      path: ["appTrustedSources", "gatewayPreview"],
    });
  }
};
const validateGatewayAppTrustedSource = (
  plan: z.infer<typeof hostedOperatorPlanDataSchema>,
  ctx: z.RefinementCtx,
) => {
  const appPreview = plan.gatewayBindings?.trustedSources?.appPreview;
  if (appPreview === undefined) {
    return;
  }
  const boundary = plan.deploymentBoundary;
  const sourceWorkload = plan.gatewayBindings?.sourceWorkload;
  const checks = [
    plan.action === "prepare",
    plan.stage === "app",
    plan.effects.some((effect) => effect.kind === GATEWAY_BINDINGS_EFFECT),
    boundary?.app.environment === "preview",
    boundary?.gateway.environment === "preview",
    appPreview.projectId === plan.selection.projectId,
    appPreview.projectId === boundary?.app.projectId,
    plan.publicGateway?.projectId === boundary?.gateway.projectId,
    sourceWorkload?.projectId === boundary?.gateway.projectId,
    sourceWorkload?.ownerId === boundary?.teamId,
  ];
  if (!checks.every(Boolean)) {
    ctx.addIssue({
      code: "custom",
      message:
        "The Gateway JWKS grant must name its selected app Preview caller and Gateway Preview target.",
      path: ["gatewayBindings", "trustedSources", "appPreview"],
    });
  }
};
export const hostedOperatorPlanSchema = hostedOperatorPlanDataSchema.superRefine((plan, ctx) => {
  if (plan.appInstallation !== undefined) {
    const customers = new Set(plan.appInstallation.customerIds);
    if (plan.access.some((grant) => !customers.has(grant.organizationId))) {
      ctx.addIssue({
        code: "custom",
        path: ["appInstallation", "customerIds"],
        message: "Schema installation targets must include every approved app access tenant.",
      });
    }
  }
  if (
    plan.hostProtection !== undefined &&
    (plan.deploymentBoundary === undefined ||
      plan.publicGateway === undefined ||
      !matchesExternalTrustedSources(
        plan.hostProtection,
        plan.deploymentBoundary.teamId,
        plan.selection.projectId,
        plan.publicGateway.projectId,
      ) ||
      plan.appTrustedSources !== undefined ||
      plan.gatewayBindings?.trustedSources !== undefined)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["hostProtection"],
      message:
        "External host policy must name the exact owned team and both Preview project pairs without authorizing policy writes.",
    });
  }
  if (
    plan.appDeliveryReplacement !== undefined &&
    (plan.action !== "prepare" || plan.stage !== "app" || plan.delivery === undefined)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["appDeliveryReplacement"],
      message: "READY replacement requires an explicit full App Preview delivery plan.",
    });
  }
  validateAuthAdoption(plan, ctx);
  validateAppEnvironmentCleanup(plan, ctx);
  validateAppTrustedSources(plan, ctx);
  validateGatewayAppTrustedSource(plan, ctx);

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
      plan.action === "prepare" && plan.stage !== AUTH_PARTICIPANTS_STAGE && !orderedResources,
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
  if (plan.deploymentBoundary !== undefined) {
    const boundary = plan.deploymentBoundary;
    const jwks = new URL(boundary.verification.jwksUrl);
    const invalidBoundary = [
      new Set([boundary.app.projectId, boundary.gateway.projectId, boundary.operator.projectId])
        .size !== 3,
      boundary.app.projectId !== plan.selection.projectId,
      boundary.app.branch !== boundaryAppBranch(plan),
      boundary.gateway.branch !== plan.publicGateway?.branch,
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
  validateNormalActorPlan(plan, ctx);
  validateAuthSignupPolicy(plan, ctx);
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
/** Legacy plans install only their grant tenants; explicit plans retain owned installation tenants. */
export const hostedOperatorInstallationCustomerIds = (
  plan: Pick<HostedOperatorPlan, "access" | "appInstallation">,
): string[] => [
  ...new Set(
    plan.appInstallation?.customerIds ?? plan.access.map((target) => target.organizationId),
  ),
];
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
    browserSession: z
      .strictObject({
        operationRef: z.uuid(),
        participantProgramDigest: digest,
      })
      .optional(),
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
  /** Durable alias intent: true is uncertain, false is a confirmed rejection; never alias authority. */
  gatewayAliasAttempted: z.boolean().optional(),
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
/** Verified native delivery receipt; browser origin is distinct from immutable transport origins. */
export const operatorNativePreviewSchema = z.strictObject({
  app: operatorDeploymentCandidateSchema,
  expiresAt: z.iso.datetime({ offset: true }),
  gateway: operatorDeploymentCandidateSchema,
  operationRef: z.uuid(),
  planDigest: digest,
  publicOrigin: httpsPublicOrigin,
  verifiedAt: z.iso.datetime({ offset: true }),
});
export type OperatorNativePreview = z.infer<typeof operatorNativePreviewSchema>;
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
export const retainedAppDeliverySchema = z.object({
  branch: id,
  delivery: hostedOperatorPlanDataSchema.shape.delivery,
  deliveryCandidates: operatorDeploymentCandidatesSchema,
  managedEnvironment: managedOperatorEnvironmentRowsSchema,
  operationRef: z.uuid(),
  planDigest: digest,
  projectId: id,
});
export type RetainedAppDelivery = z.infer<typeof retainedAppDeliverySchema>;

const hostedOperatorRecordBaseSchema = z.strictObject({
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
  retainedAppDeliveries: z.array(retainedAppDeliverySchema).optional(),
  workerCheckpoints: z.array(workerEffectCheckpointSchema).optional(),
});
export type HostedOperatorRecordBase = z.infer<typeof hostedOperatorRecordBaseSchema>;
const hostedOperatorRecordHistorySchema = hostedOperatorRecordBaseSchema.extend({
  /** Prior build settings and unresolved binding attempts are provenance, never new approval. */
  retainedProjectSettingsOperations: z
    .array(z.strictObject({ approvedByCallId: id, operator: hostedOperatorRecordBaseSchema }))
    .optional(),
  /** Original installer intent and unresolved frames remain evidence, never successor approval. */
  retainedInstallerOperations: z
    .array(
      z.strictObject({
        approvedByCallId: id,
        operator: hostedOperatorRecordBaseSchema,
      }),
    )
    .optional(),
  /** Private provenance for source repair; prior approval never approves the successor. */
  retainedGatewayDeliveries: z
    .array(
      z.strictObject({
        approvedByCallId: id,
        operator: hostedOperatorRecordBaseSchema,
      }),
    )
    .optional(),
  /** The expired approved plan remains evidence; a renewed plan requires a new approval. */
  retainedRenewalOperations: z
    .array(z.strictObject({ approvedByCallId: id, operator: hostedOperatorRecordBaseSchema }))
    .optional(),
});
const hostedOperatorRecordDataSchema = hostedOperatorRecordHistorySchema.extend({
  /** Exact predecessor snapshots, including old unknown attempts and existing histories; never replay authority. */
  retainedReadyDeliveryOperations: z
    .array(
      z.strictObject({
        approvedByCallId: id,
        operator: hostedOperatorRecordHistorySchema,
      }),
    )
    .optional(),
});
const gatewayDeliveryOrigin = (operator: z.infer<typeof hostedOperatorRecordDataSchema>) =>
  operator.gatewayDeliveryCandidates?.find(
    (candidate) =>
      candidate.deploymentId === operator.deliveredGatewayDeploymentId &&
      candidate.readyState === "READY",
  )?.origin;
const renewalGatewaySourceMatches = (prior: HostedOperatorPlan, current: HostedOperatorPlan) =>
  [
    JSON.stringify(prior.publicGateway) === JSON.stringify(current.publicGateway),
    JSON.stringify(prior.gatewayDelivery) === JSON.stringify(current.gatewayDelivery),
    JSON.stringify(prior.gatewayBindings?.sourceWorkload) ===
      JSON.stringify(current.gatewayBindings?.sourceWorkload),
  ].every(Boolean);
const retainedRenewalGatewayDeliveryOrigin = (
  operator: z.infer<typeof hostedOperatorRecordDataSchema>,
): string | undefined => {
  const link = operator.identityLink;
  if (link?.consumedAt === undefined) {
    return undefined;
  }
  const retained = operator.retainedRenewalOperations?.find(
    ({ approvedByCallId, operator: prior }) => {
      const priorPlan = prior.plan;
      const candidate = prior.gatewayDeliveryCandidates?.find(
        (value) => value.deploymentId === prior.deliveredGatewayDeploymentId,
      );
      const priorLink = prior.identityLink;
      return [
        approvedByCallId !== "operator:unapproved-plan",
        prior.approvalId !== undefined,
        prior.operationRef === operator.operationRef,
        prior.planDigest ===
          createHash("sha256")
            .update(JSON.stringify(hostedOperatorPlanSchema.parse(priorPlan)))
            .digest("hex"),
        priorLink !== undefined && JSON.stringify(priorLink) === JSON.stringify(link),
        priorPlan.contextId === operator.plan.contextId,
        JSON.stringify(priorPlan.selection) === JSON.stringify(operator.plan.selection),
        priorPlan.authDatabase.resourceId === operator.plan.authDatabase.resourceId,
        JSON.stringify(priorPlan.deploymentBoundary?.authority) ===
          JSON.stringify(operator.plan.deploymentBoundary?.authority),
        priorPlan.deploymentBoundary?.teamId === operator.plan.deploymentBoundary?.teamId,
        priorPlan.deploymentBoundary?.verification.publicOrigin ===
          operator.plan.deploymentBoundary?.verification.publicOrigin,
        renewalGatewaySourceMatches(priorPlan, operator.plan),
        priorPlan.gatewayBindings?.authBrowserOrigin ===
          operator.plan.gatewayBindings?.authBrowserOrigin,
        candidate !== undefined && candidate.readyState === "READY",
        candidate?.deploymentId === prior.deliveredGatewayDeploymentId,
        candidate?.projectId === priorPlan.publicGateway?.projectId,
        candidate?.branch === priorPlan.publicGateway?.branch,
        candidate?.repoId === priorPlan.gatewayDelivery?.repoId,
        candidate?.origin === link.endpointOrigin,
      ].every(Boolean);
    },
  );
  return retained?.operator.gatewayDeliveryCandidates?.find(
    (candidate) =>
      candidate.deploymentId === retained.operator.deliveredGatewayDeploymentId &&
      candidate.readyState === "READY" &&
      candidate.origin === link.endpointOrigin,
  )?.origin;
};
/** Exact identity scope shared by validation and successor metadata composition. */
export const matchesHostedOperatorIdentityLinkScope = (
  operator: z.infer<typeof hostedOperatorRecordDataSchema>,
): boolean => {
  const link = operator.identityLink;
  return (
    link === undefined ||
    [
      link.authResourceId === operator.plan.authDatabase.resourceId,
      link.browserOrigin === operator.plan.gatewayBindings?.authBrowserOrigin,
      link.ownerSessionId === operator.plan.selection.sessionId,
      link.issuer === operator.plan.deploymentBoundary?.verification.publicOrigin,
      link.endpointOrigin === operator.plan.deploymentBoundary?.verification.gatewayOrigin ||
        gatewayDeliveryOrigin(operator) === link.endpointOrigin ||
        retainedRenewalGatewayDeliveryOrigin(operator) === link.endpointOrigin,
    ].every(Boolean)
  );
};
// oxlint-disable-next-line eslint/complexity, sonarjs/expression-complexity -- Frozen identity link and actual delivered candidate identities require every exact binding.
const validateOperatorMetadata = (
  operator: z.infer<typeof hostedOperatorRecordDataSchema>,
  context: z.RefinementCtx,
) => {
  if (!matchesHostedOperatorIdentityLinkScope(operator)) {
    context.addIssue({
      code: "custom",
      message:
        "Realm identity link must match the owned Auth resource, exact issuer and canonical owner session.",
    });
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
        value.branch !== plannedAppBranch(operator.plan),
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
const validateRetainedAppDeliveries = (
  operator: z.infer<typeof hostedOperatorRecordDataSchema>,
  ownedKeys: Set<string>,
  context: z.RefinementCtx,
) => {
  for (const [index, retained] of (operator.retainedAppDeliveries ?? []).entries()) {
    const invalid = [
      retained.projectId !== operator.plan.selection.projectId,
      retained.delivery !== undefined &&
        (retained.delivery.projectId !== retained.projectId ||
          retained.delivery.branch !== retained.branch),
      retained.deliveryCandidates.some(
        (candidate) =>
          candidate.projectId !== retained.projectId || candidate.branch !== retained.branch,
      ),
      retained.managedEnvironment.some(
        (row) =>
          row.projectId !== retained.projectId ||
          row.branch !== retained.branch ||
          !ownedKeys.has(row.key) ||
          row.comment !== `App Builder protected operator ${row.operationRef}`,
      ),
    ].some(Boolean);
    if (invalid) {
      context.addIssue({
        code: "custom",
        message:
          "Historical app delivery must retain its actual owned project, branch and row lineage.",
        path: ["retainedAppDeliveries", index],
      });
    }
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
          row.branch !== plannedAppBranch(operator.plan) ||
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
    validateRetainedAppDeliveries(operator, ownedKeys, context);
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
    const accessTenants = operator.plan.access.map((target) => target.organizationId);
    const effects = new Map(operator.plan.effects.map((effect) => [effect.id, effect]));
    for (const [index, checkpoint] of (operator.workerCheckpoints ?? []).entries()) {
      const invalidIdentity =
        checkpoint.operationRef !== operator.operationRef ||
        operator.fenceGeneration === undefined ||
        checkpoint.fenceGeneration !== operator.fenceGeneration;
      const parent = effects.get(checkpoint.parentEffectId);
      const tenants = new Set(
        parent?.kind === "install" && checkpoint.resourceId === operator.plan.appDatabase.resourceId
          ? hostedOperatorInstallationCustomerIds(operator.plan)
          : accessTenants,
      );
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
/** Only the planner's generated expiry may differ; every approved effect remains exact. */
export const sameOperatorPlanExceptExpiry = (
  original: HostedOperatorPlan,
  proposed: HostedOperatorPlan,
) =>
  operatorPlanDigest(original) ===
  operatorPlanDigest({
    ...proposed,
    retention: { ...proposed.retention, expiresAt: original.retention.expiresAt },
  });
/** Completed Auth ownership survives replacement of the app's current operation.
 * This is non-secret provenance; current owner and original approval are re-read
 * before the retained encrypted credentials may be used. */
export const retainedOperatorAuthSchema = z
  .strictObject({
    approvalId: id,
    approvedByCallId: id,
    authPreparation: operatorAuthSchemaPreparationSchema,
    fenceGeneration: z.number().int().positive().optional(),
    gatewayEnvironment: managedOperatorEnvironmentRowsSchema.optional(),
    operationRef: z.uuid(),
    plan: hostedOperatorPlanSchema,
    planDigest: digest,
    receipts: z.array(operatorReceiptSchema),
  })
  .superRefine((value, context) => {
    const { approvedByCallId, ...metadata } = value;
    const operator = hostedOperatorRecordSchema.safeParse({
      ...metadata,
      mode: "protected-operator-v1",
    });
    const readiness = value.authPreparation;
    const invalid = [
      value.plan.action !== "prepare",
      approvedByCallId === "operator:unapproved-plan",
      value.planDigest !== operatorPlanDigest(value.plan),
      readiness.database !== value.plan.authDatabase.database,
      readiness.runtimeRole !== value.plan.authDatabase.runtimeRole,
      readiness.targetDigest !== value.plan.authSchema?.targetDigest,
      value.receipts.length !== value.plan.effects.length,
      value.plan.effects.some(
        (effect) => value.receipts.filter((receipt) => receipt.effectId === effect.id).length !== 1,
      ),
      value.receipts.some(
        (receipt) =>
          ["access", "revoke"].includes(
            value.plan.effects.find((effect) => effect.id === receipt.effectId)?.kind ?? "",
          ) && receipt.fenceGeneration !== value.fenceGeneration,
      ),
      !operator.success,
    ].some(Boolean);
    if (invalid) {
      context.addIssue({
        code: "custom",
        message: "Retained Auth requires complete approved preparation and matching readiness.",
      });
    }
  });
export type RetainedOperatorAuth = z.infer<typeof retainedOperatorAuthSchema>;
/** Private server-derived claims; the operator re-reads their durable authority. */
const ownerContextBaseSchema = z.strictObject({
  realmContinuation: z.strictObject({ sealedAuthority: z.string().min(1) }).optional(),
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
    action: z.literal("resolve-preview-target"),
    appId: operatorSelectionSchema.shape.appId,
    sessionId: id,
    ownerContext: operatorOwnerContextSchema.optional(),
  }),
  z.strictObject({
    action: z.literal("neon-authorization"),
    callbackUrl: z.url().optional(),
    ownerContext: operatorOwnerContextSchema.optional(),
    phase: z.enum(["check", "start", "complete"]),
    sessionId: id,
  }),
  z.strictObject({
    action: z.literal("plan"),
    releaseIntent: z.literal("prepared-preview").optional(),
    authSignupPolicy: hostedOperatorAuthSignupPolicyInputSchema.optional(),
    normalActorProgram: normalActorProgramSchema.optional(),
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
const operatorPublicCodeSchema = z.enum([
  "protected_operator_required",
  "auth_identity_required",
  "auth_membership_required",
  "auth_schema_not_ready",
  "authorization_required",
  "resource_mismatch",
  "operation_in_progress",
  "reconciliation_required",
  "gateway_delivery_failed",
  "app_delivery_configuration_changed",
  "app_source_publication_required",
  "export_customer_selection_required",
  "operator_unavailable",
  "legacy_runtime_requires_migration",
  "signup_not_ready",
]);
const operatorPublicStatusSchema = z.enum([
  "planned",
  "pending",
  "prepared",
  "cleaned",
  "blocked",
  "auth-schema-prepared",
  "participants-prepared",
  "waiting_for_signup",
  "ready",
]);
export const operatorExecutionOutcomeSchema = z.strictObject({
  status: operatorPublicStatusSchema,
  code: operatorPublicCodeSchema.optional(),
});
export const operatorExecutionObservationSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("running") }),
  z.strictObject({ state: z.literal("unknown") }),
  z.strictObject({ state: z.literal("settled"), outcome: operatorExecutionOutcomeSchema }),
]);
export const operatorPublicResultSchema = z.strictObject({
  appId: id,
  authenticatedBehavior: z.literal("unassessed"),
  code: operatorPublicCodeSchema.optional(),
  operationRef: z.uuid().optional(),
  plan: hostedOperatorPlanSchema.optional(),
  planDigest: digest.optional(),
  status: operatorPublicStatusSchema,
  execution: operatorExecutionObservationSchema.optional(),
  appUrl: z.url().optional(),
  signupUrl: z.url().optional(),
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

export const assertOperatorNativePreview = (
  preview: OperatorNativePreview,
  plan: HostedOperatorPlan,
  operationRef: string,
  now = Date.now(),
) => {
  const matches = [
    plan.action === "prepare",
    plan.stage !== "auth-bootstrap",
    preview.operationRef === operationRef,
    preview.planDigest === operatorPlanDigest(plan),
    preview.publicOrigin === plan.deploymentBoundary?.verification.publicOrigin,
    preview.expiresAt === plan.retention.expiresAt,
    Date.parse(preview.expiresAt) > now,
    Date.parse(preview.verifiedAt) <= now,
    Date.parse(preview.verifiedAt) < Date.parse(preview.expiresAt),
    preview.app.operationRef === operationRef,
    preview.gateway.operationRef === operationRef,
    preview.app.readyState === "READY",
    preview.gateway.readyState === "READY",
    preview.app.projectId === plan.delivery?.projectId,
    preview.app.branch === plan.delivery?.branch,
    preview.app.repoId === plan.delivery?.repoId,
    preview.gateway.projectId === plan.gatewayDelivery?.projectId,
    preview.gateway.branch === plan.gatewayDelivery?.branch,
    preview.gateway.repoId === plan.gatewayDelivery?.repoId,
  ];
  if (matches.includes(false)) {
    throw new HostedOperatorError("resource_mismatch");
  }
};

export type HostedOperatorRecord = z.infer<typeof hostedOperatorRecordSchema>;
