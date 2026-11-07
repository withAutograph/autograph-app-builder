import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import { HostedOperatorError } from "./hosted-operator-contract";
import {
  authOnlyOrganizationPlanSchema,
  authOnlySignupPolicyPlanSchema,
  runAuthOrganizationFileSpool,
  runAuthSignupPolicyFileSpool,
} from "./hosted-operator-sandbox-launcher";
import type { HostedOperatorSandboxConfiguration } from "./hosted-operator-sandbox-launcher";
import type { HostedOperatorWorkerEffectContext } from "./hosted-operator-service";
import type {
  NativeTargetAuthOnlyAfterGatewayReadyInput,
  NativeTargetAuthOnlyEntryReadiness,
} from "./native-target-auth-only-delivery-runtime";
import { nativeTargetAuthOnlyApprovalSchema } from "./native-target-auth-only-dispatch";
import type { NativeTargetAuthOnlyApproval } from "./native-target-auth-only-dispatch";
import { nativeTargetAuthOnlyOwnerLinkBindingSchema } from "./native-target-auth-only-owner-link";
import type {
  createNativeTargetAuthOnlyOwnerLink,
  NativeTargetAuthOnlyOwnerLinkBinding,
} from "./native-target-auth-only-owner-link";
import { nativeTargetAuthOnlyPlanDigest } from "./native-target-auth-only-plan-schema";

type OwnerLink = ReturnType<typeof createNativeTargetAuthOnlyOwnerLink>;
type Captured = NonNullable<Awaited<ReturnType<OwnerLink["readCaptured"]>>>;
type OrganizationPlan = z.infer<typeof authOnlyOrganizationPlanSchema>;
type SignupPlan = z.infer<typeof authOnlySignupPolicyPlanSchema>;
interface Scope {
  input: NativeTargetAuthOnlyAfterGatewayReadyInput;
  binding: NativeTargetAuthOnlyOwnerLinkBinding;
  captured: Captured;
}
interface ApprovedEffect {
  approval: NativeTargetAuthOnlyApproval;
  approvedPlanBytes: Buffer;
  operationRef: string;
  workerAttemptId: string;
  fenceGeneration: number;
  /** Recheck canonical ownership, exact approval/bytes and the durable lease for this attempt. */
  assertCurrent: () => Promise<void>;
  /** CAS a never-dispatched operation to dispatched. Any prior intent, including unknown, returns false. */
  claimFirstDispatch: () => Promise<boolean>;
  bindWorkerContext: HostedOperatorWorkerEffectContext["bindWorkerContext"];
}
type PolicyCatalogObservation =
  | { status: "absent" }
  | { status: "unknown" }
  | { status: "applied"; policyDigest: string; readbackSha256?: string };

export interface NativeTargetAuthOnlyEntryPreparationPorts {
  /** Re-read the canonical saved operation, retained READY Gateway and isolated Auth schema. */
  readReadyBinding: (input: Scope["input"]) => Promise<
    | {
        binding: Scope["binding"];
        sandbox: HostedOperatorSandboxConfiguration;
      }
    | undefined
  >;
  ownerLink: Pick<OwnerLink, "prepare" | "readCaptured">;
  /** Independently verify the exact signed proof and live user/session in the bound Auth Realm. */
  readCurrentOwnerProof: (scope: Scope) => Promise<{
    reference: string;
    proof: string;
    oidcToken: string;
    actorId: string;
    realmSessionId: string;
  }>;
  /** Read the existing sealed migrator binding for the exact isolated Auth resource. */
  readCredentials: (scope: Scope) => Promise<{ migrationUrl: string }>;
  readApprovedOrganization: (scope: Scope) => Promise<ApprovedEffect | undefined>;
  readApprovedSignupPolicy: (
    scope: Scope,
    organizationId: string,
  ) => Promise<ApprovedEffect | undefined>;
  /**
   * Catalog lookup on the verified physical Auth DB. Return absence only when neither the policy
   * ID nor its app/origin/path selector exists. Other conflicts and failed reads are unknown.
   */
  readSignupPolicy: (input: {
    scope: Scope;
    policy: SignupPlan["authSignupPolicy"];
    operationRef: string;
    approvalDigest: string;
    fenceGeneration: number;
    assertCurrent: () => Promise<void>;
  }) => Promise<PolicyCatalogObservation>;
}

interface EntrySpools {
  organization: typeof runAuthOrganizationFileSpool;
  signupPolicy: typeof runAuthSignupPolicyFileSpool;
}
const pinnedSpools: EntrySpools = {
  organization: runAuthOrganizationFileSpool,
  signupPolicy: runAuthSignupPolicyFileSpool,
};

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const mismatch = () => new HostedOperatorError("resource_mismatch");
const identityRequired = () => new HostedOperatorError("auth_identity_required");
const uncertain = () => new HostedOperatorError("reconciliation_required");
const ownerApprovalRequired = () => new HostedOperatorError("authorization_required");

export const assertNativeTargetAuthOnlyEntryBinding = (
  input: Scope["input"],
  binding: Scope["binding"],
) => {
  const { deliveryPlan, plan } = input;
  const gateway = deliveryPlan.delivery.publicGateway;
  if (
    !isDeepStrictEqual(binding.authority, input.authority) ||
    !isDeepStrictEqual(binding.target, input.target) ||
    !isDeepStrictEqual(binding.gateway, input.gateway) ||
    binding.operationRef !== input.operationRef
  ) {
    throw mismatch();
  }
  if (
    binding.authOnlyPlanDigest !== nativeTargetAuthOnlyPlanDigest(plan) ||
    binding.authOnlyPlanDigest !== deliveryPlan.authOnlyPlanDigest ||
    binding.resourcePlanDigest !== deliveryPlan.resourcePlanDigest ||
    binding.gatewayDeliveryPlanDigest !== input.deliveryPlanDigest
  ) {
    throw mismatch();
  }
  if (
    binding.authResourceId !== plan.authResource.resourceId ||
    binding.bootstrapResource.database !== plan.authResource.database ||
    binding.bootstrapResource.hostname !== plan.authResource.hostname
  ) {
    throw mismatch();
  }
  if (binding.browserOrigin !== gateway?.authBrowserOrigin || binding.issuer !== gateway.origin) {
    throw mismatch();
  }
};

const validateEffectPlan = (binding: Scope["binding"], plan: OrganizationPlan | SignupPlan) => {
  const resource = binding.bootstrapResource;
  const { verification } = plan.deploymentBoundary;
  const expectedDatabase = {
    resourceId: binding.authResourceId,
    database: resource.database,
    migratorRole: resource.migratorRole,
    runtimeRole: resource.runtimeRole,
  };
  const expectedNeon = { ...resource.neon, endpoint: resource.hostname };
  const expectedVerification = {
    publicOrigin: binding.issuer,
    gatewayOrigin: binding.gateway.origin,
    jwksUrl: new URL("/_platform/jwks.json", binding.gateway.origin).href,
  };
  if (
    plan.selection.sessionId !== binding.target.sessionId ||
    plan.selection.workspaceId !== binding.authority.workspaceId ||
    plan.effects[0].resourceId !== binding.authResourceId
  ) {
    throw mismatch();
  }
  if (
    !isDeepStrictEqual(plan.authDatabase, expectedDatabase) ||
    !isDeepStrictEqual(plan.neon, expectedNeon)
  ) {
    throw mismatch();
  }
  if (
    plan.deploymentBoundary.teamId !== binding.target.scopeId ||
    plan.deploymentBoundary.operator.environment !== "preview" ||
    !isDeepStrictEqual(verification, expectedVerification)
  ) {
    throw mismatch();
  }
};

const readExactEffect = <T extends OrganizationPlan | SignupPlan>(
  scope: Scope,
  effect: ApprovedEffect | undefined,
  schema: z.ZodType<T>,
) => {
  if (effect === undefined) {
    throw ownerApprovalRequired();
  }
  const approval = nativeTargetAuthOnlyApprovalSchema.safeParse(effect.approval);
  const approvedPlanBytes = Buffer.from(effect.approvedPlanBytes);
  const approvalDigest = sha256(approvedPlanBytes);
  if (
    !approval.success ||
    approval.data.outcome !== "approved" ||
    approval.data.planDigest !== scope.input.deliveryPlanDigest ||
    approval.data.sourceDigest !== approvalDigest
  ) {
    throw ownerApprovalRequired();
  }
  if (
    approval.data.publicSessionId !== scope.binding.target.sessionId ||
    approval.data.responderPrincipalId !== scope.binding.authority.ownerUserId
  ) {
    throw ownerApprovalRequired();
  }
  if (
    !z.uuid().safeParse(effect.operationRef).success ||
    !z.uuid().safeParse(effect.workerAttemptId).success ||
    !Number.isSafeInteger(effect.fenceGeneration) ||
    effect.fenceGeneration <= 0
  ) {
    throw mismatch();
  }

  let plan: T;
  try {
    plan = schema.parse(JSON.parse(approvedPlanBytes.toString("utf-8")));
  } catch {
    throw mismatch();
  }
  validateEffectPlan(scope.binding, plan);
  return {
    plan,
    worker: {
      approvedPlanBytes,
      approvalDigest,
      operationRef: effect.operationRef,
      workerAttemptId: effect.workerAttemptId,
      fenceGeneration: effect.fenceGeneration,
      effectId: plan.effects[0].id,
      signal: scope.input.signal,
    },
    async assertCurrent() {
      scope.input.signal.throwIfAborted();
      await scope.input.assertCurrent();
      await effect.assertCurrent();
    },
    async claimFirstDispatch() {
      if (!(await effect.claimFirstDispatch())) {
        throw uncertain();
      }
    },
    bindWorkerContext: effect.bindWorkerContext,
  };
};

const prepareOrganization = async (
  ports: NativeTargetAuthOnlyEntryPreparationPorts,
  sandbox: HostedOperatorSandboxConfiguration,
  spool: EntrySpools["organization"],
  scope: Scope,
) => {
  const { binding, captured } = scope;
  const organization = readExactEffect(
    scope,
    await ports.readApprovedOrganization(scope),
    authOnlyOrganizationPlanSchema,
  );
  const spec = organization.plan.authMembership;
  const organizationId = spec.organizationId;
  if (
    spec.bootstrapPlanDigest !== binding.resourcePlanDigest ||
    spec.identityNonceSha256 !== captured.nonceSha256 ||
    spec.identityCapture.capturedAt !== captured.consumedAt ||
    !isDeepStrictEqual(spec.identityProof, {
      reference: captured.proofRef,
      sha256: captured.proofSha256,
    })
  ) {
    throw identityRequired();
  }
  if (
    spec.identityVerification.audience !== binding.audience ||
    spec.identityVerification.issuer !== binding.issuer ||
    spec.identityVerification.jwksUrl !== organization.plan.deploymentBoundary.verification.jwksUrl
  ) {
    throw identityRequired();
  }

  const checkOwnerProof = async () => {
    const current = await ports.ownerLink.readCaptured(binding);
    if (!isDeepStrictEqual(current, captured)) {
      throw identityRequired();
    }
    const live = await ports.readCurrentOwnerProof(scope);
    if (
      live.reference !== captured.proofRef ||
      sha256(live.proof) !== captured.proofSha256 ||
      live.actorId !== spec.actorId ||
      live.realmSessionId !== spec.identityCapture.realmSessionId
    ) {
      throw identityRequired();
    }
    return live;
  };
  await organization.assertCurrent();
  const ownerProof = await checkOwnerProof();
  const credentials = await ports.readCredentials(scope);
  const organizationWorker = {
    ...organization.worker,
    credentials,
    ownerProof: {
      reference: ownerProof.reference,
      proof: ownerProof.proof,
      oidcToken: ownerProof.oidcToken,
    },
    assertCurrentOwnerProof: async () => {
      await organization.assertCurrent();
      await checkOwnerProof();
    },
  };
  let observedOrganization = await spool(sandbox, {
    ...organizationWorker,
    readbackOnly: true,
  });
  if (observedOrganization?.status === "absent") {
    await organizationWorker.assertCurrentOwnerProof();
    await organization.claimFirstDispatch();
    await spool(sandbox, {
      ...organizationWorker,
      bindWorkerContext: organization.bindWorkerContext,
    });
    observedOrganization = await spool(sandbox, {
      ...organizationWorker,
      readbackOnly: true,
    });
  }
  if (observedOrganization?.status !== "applied") {
    throw uncertain();
  }
  await organizationWorker.assertCurrentOwnerProof();

  return {
    organizationId,
    credentials,
    assertCurrentOwnerProof: organizationWorker.assertCurrentOwnerProof,
  };
};

const prepareSignupPolicy = async (
  ports: NativeTargetAuthOnlyEntryPreparationPorts,
  sandbox: HostedOperatorSandboxConfiguration,
  spool: EntrySpools["signupPolicy"],
  scope: Scope,
  organization: Awaited<ReturnType<typeof prepareOrganization>>,
) => {
  const { binding, input } = scope;
  const { organizationId, credentials } = organization;
  const signup = readExactEffect(
    scope,
    await ports.readApprovedSignupPolicy(scope, organizationId),
    authOnlySignupPolicyPlanSchema,
  );
  const policy = signup.plan.authSignupPolicy;
  if (
    policy.appId !== binding.target.appId ||
    policy.organizationId !== organizationId ||
    policy.origin !== binding.issuer ||
    policy.appRoles[0] !== input.plan.appRole
  ) {
    throw mismatch();
  }
  const assertCurrent = async () => {
    await signup.assertCurrent();
    await organization.assertCurrentOwnerProof();
  };
  const policyWorker = { ...signup.worker, credentials, assertCurrent };
  const readPolicy = async () => {
    await assertCurrent();
    return await ports.readSignupPolicy({
      scope,
      policy,
      operationRef: signup.worker.operationRef,
      approvalDigest: signup.worker.approvalDigest,
      fenceGeneration: signup.worker.fenceGeneration,
      assertCurrent,
    });
  };
  let observedPolicy = await readPolicy();
  if (observedPolicy.status === "absent") {
    await assertCurrent();
    await signup.claimFirstDispatch();
    await spool(sandbox, {
      ...policyWorker,
      bindWorkerContext: signup.bindWorkerContext,
    });
    observedPolicy = await readPolicy();
  }
  if (
    observedPolicy.status !== "applied" ||
    !digest.safeParse(observedPolicy.policyDigest).success
  ) {
    throw uncertain();
  }

  const pinnedPolicy = await spool(sandbox, {
    ...policyWorker,
    readbackOnly: true,
  });
  const signupPolicyDigest = observedPolicy.policyDigest;
  // The pinned policy readback hashes these three fields in canonical (key-sorted) order.
  const attestation =
    observedPolicy.readbackSha256 ??
    sha256(
      JSON.stringify({ appId: policy.appId, organizationId, policyDigest: signupPolicyDigest }),
    );
  if (
    pinnedPolicy?.status !== "applied" ||
    !("readback_sha256" in pinnedPolicy) ||
    pinnedPolicy.readback_sha256 !== attestation
  ) {
    throw uncertain();
  }
  await assertCurrent();
  return signupPolicyDigest;
};

const resolveEntryOwner = async (
  ports: NativeTargetAuthOnlyEntryPreparationPorts,
  input: Scope["input"],
) => {
  input.signal.throwIfAborted();
  await input.assertCurrent();
  const ready = await ports.readReadyBinding(input);
  if (ready === undefined) {
    throw new HostedOperatorError("auth_schema_not_ready");
  }
  const binding = nativeTargetAuthOnlyOwnerLinkBindingSchema.parse(ready.binding);
  assertNativeTargetAuthOnlyEntryBinding(input, binding);
  await input.assertCurrent();
  const link = await ports.ownerLink.prepare(binding);
  if (link.status === "waiting-for-owner") {
    await input.assertCurrent();
    return {
      status: "pending-owner" as const,
      authIdentityLink: link.browserUrl,
      authIdentityLinkExpiresAt: link.expiresAt,
    };
  }
  const captured = await ports.ownerLink.readCaptured(binding);
  if (
    captured?.consumedAt === undefined ||
    captured.proofRef === undefined ||
    captured.proofSha256 === undefined
  ) {
    throw identityRequired();
  }
  return { status: "linked" as const, scope: { input, binding, captured }, sandbox: ready.sandbox };
};

/** Execute only the approved organization effect and its independent readback. */
export const createNativeTargetAuthOnlyOrganizationPreparation =
  (ports: NativeTargetAuthOnlyEntryPreparationPorts, spool = pinnedSpools.organization) =>
  async (input: Scope["input"]) => {
    const owner = await resolveEntryOwner(ports, input);
    if (owner.status !== "linked") {
      throw identityRequired();
    }
    const organization = await prepareOrganization(ports, owner.sandbox, spool, owner.scope);
    return organization.organizationId;
  };

/** Resume the saved Auth-only operation. Return readiness only after the two Auth effects are observed. */
export const createNativeTargetAuthOnlyEntryPreparation =
  (ports: NativeTargetAuthOnlyEntryPreparationPorts, spools: EntrySpools = pinnedSpools) =>
  async (input: Scope["input"]): Promise<NativeTargetAuthOnlyEntryReadiness> => {
    const owner = await resolveEntryOwner(ports, input);
    if (owner.status !== "linked") {
      return owner;
    }
    const organization = await prepareOrganization(
      ports,
      owner.sandbox,
      spools.organization,
      owner.scope,
    );
    const signupPolicyDigest = await prepareSignupPolicy(
      ports,
      owner.sandbox,
      spools.signupPolicy,
      owner.scope,
      organization,
    );
    return { status: "ready", organizationId: organization.organizationId, signupPolicyDigest };
  };
