import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";

import { HostedOperatorError } from "./hosted-operator-contract";
import type { NativeTargetAuthOnlyApproval } from "./native-target-auth-only-dispatch";
import type {
  NativeTargetAuthOnlyAfterGatewayReadyInput,
  NativeTargetAuthOnlyDeliveryKey,
  NativeTargetAuthOnlyDeliveryRow,
  NativeTargetAuthOnlyDeliveryStore,
} from "./native-target-auth-only-delivery-runtime";
import {
  assertNativeTargetAuthOnlyEntryBinding,
  createNativeTargetAuthOnlyEntryPreparation,
  createNativeTargetAuthOnlyOrganizationPreparation,
} from "./native-target-auth-only-entry-preparation";
import type { NativeTargetAuthOnlyEntryPreparationPorts } from "./native-target-auth-only-entry-preparation";
import { nativeTargetAuthOnlyOwnerLinkBindingSchema } from "./native-target-auth-only-owner-link";
import { encodeNativeTargetAuthOnlyEntryPlan } from "./native-target-auth-only-entry-plan-store";
import type {
  createPostgresNativeTargetAuthOnlyEntryPlanStore,
  NativeTargetAuthOnlyEntryApprovalInput,
  NativeTargetAuthOnlyEntryPlanKey,
} from "./native-target-auth-only-entry-plan-store";
import { authOnlyOrganizationPlanSchema } from "./hosted-operator-sandbox-launcher";
import type { authOnlySignupPolicyPlanSchema } from "./hosted-operator-sandbox-launcher";

type HookInput = NativeTargetAuthOnlyAfterGatewayReadyInput;
type Ports = NativeTargetAuthOnlyEntryPreparationPorts;
type Scope = Parameters<Ports["readApprovedOrganization"]>[0];
type Effect = NativeTargetAuthOnlyEntryPlanKey["effect"];
type ChildStore = ReturnType<typeof createPostgresNativeTargetAuthOnlyEntryPlanStore>;
type PlannedScope = Scope & { identity: { actorId: string; realmSessionId: string } };

/** Main supplies current Realm authority, sealed credentials and exact server-owned plan values. */
export type NativeTargetAuthOnlyEntryAuthority = (
  input: HookInput,
  mode: "retained" | "fenced",
) => Promise<
  | (Pick<
      Ports,
      | "ownerLink"
      | "readReadyBinding"
      | "readCredentials"
      | "readCurrentOwnerProof"
      | "readSignupPolicy"
    > & {
      readOrganizationPlan: (
        scope: PlannedScope,
      ) => Promise<z.infer<typeof authOnlyOrganizationPlanSchema> | undefined>;
      readSignupPolicyPlan: (
        scope: PlannedScope,
        organizationId: string,
      ) => Promise<z.infer<typeof authOnlySignupPolicyPlanSchema> | undefined>;
    })
  | undefined
>;

const denied = () => new HostedOperatorError("authorization_required");
const identityRequired = () => new HostedOperatorError("auth_identity_required");
const uncertain = () => new HostedOperatorError("reconciliation_required");
const mismatch = () => new HostedOperatorError("resource_mismatch");

const childKey = (scope: Scope, effect: Effect): NativeTargetAuthOnlyEntryPlanKey => {
  const ownerProofSha256 = scope.captured.proofSha256;
  if (ownerProofSha256 === undefined) {
    throw identityRequired();
  }
  return {
    appId: scope.binding.target.appId,
    authResourceId: scope.binding.authResourceId,
    authority: scope.binding.authority,
    deliveryOperationRef: scope.binding.operationRef,
    deliveryPlanDigest: scope.binding.gatewayDeliveryPlanDigest,
    effect,
    ownerProofSha256,
    resourcePlanDigest: scope.binding.resourcePlanDigest,
    sessionId: scope.binding.target.sessionId,
  };
};

type ResolvedAuthority = NonNullable<Awaited<ReturnType<NativeTargetAuthOnlyEntryAuthority>>>;

const readConsumed = async (ports: ResolvedAuthority, input: HookInput): Promise<PlannedScope> => {
  await input.assertCurrent();
  const ready = await ports.readReadyBinding(input);
  if (ready === undefined) {
    throw new HostedOperatorError("auth_schema_not_ready");
  }
  const binding = nativeTargetAuthOnlyOwnerLinkBindingSchema.parse(ready.binding);
  assertNativeTargetAuthOnlyEntryBinding(input, binding);
  const captured = await ports.ownerLink.readCaptured(binding);
  if (
    captured?.consumedAt === undefined ||
    captured.proofRef === undefined ||
    captured.proofSha256 === undefined
  ) {
    throw identityRequired();
  }
  const scope = { binding, captured, input };
  const live = await ports.readCurrentOwnerProof(scope);
  if (
    live.reference !== captured.proofRef ||
    createHash("sha256").update(live.proof).digest("hex") !== captured.proofSha256
  ) {
    throw identityRequired();
  }
  await input.assertCurrent();
  return { ...scope, identity: { actorId: live.actorId, realmSessionId: live.realmSessionId } };
};

export const canReadNativeTargetAuthOnlyEntryParent = (
  row: NativeTargetAuthOnlyDeliveryRow,
  now = Date.now(),
) => {
  const { phase, lease, app } = row.record;
  if (lease !== undefined && Date.parse(lease.expiresAt) > now) {
    return false;
  }
  return (
    phase === "pending-owner" || phase === "prepared" || (phase === "unknown" && !app.attempted)
  );
};

/** The child shares the saved delivery's exclusion fence but never rewrites its provider receipts. */
export const withNativeTargetAuthOnlyEntryLease = async <T>(input: {
  store: NativeTargetAuthOnlyDeliveryStore;
  key: NativeTargetAuthOnlyDeliveryKey;
  parent: HookInput;
  run: (fenced: HookInput) => Promise<T>;
  now?: () => number;
}) => {
  const now = input.now ?? Date.now;
  const { store, key, parent } = input;
  await parent.assertCurrent();
  const row = await store.read(key);
  if (row === undefined || !canReadNativeTargetAuthOnlyEntryParent(row, now())) {
    throw uncertain();
  }
  if (
    row.record.deliveryPlanDigest !== parent.deliveryPlanDigest ||
    !isDeepStrictEqual(row.record.approval, parent.approval) ||
    !isDeepStrictEqual(row.record.gateway.receipt, parent.gateway)
  ) {
    throw mismatch();
  }
  const lease = { expiresAt: new Date(now() + 10 * 60_000).toISOString(), id: randomUUID() };
  const fenceGeneration = row.record.fenceGeneration + 1;
  const claimed = await store.compareAndSet(key, row.revision, {
    ...row.record,
    fenceGeneration,
    lease,
  });
  if (claimed === undefined) {
    throw uncertain();
  }
  const readClaimed = async () => {
    const current = await store.read(key);
    return current?.record.lease?.id === lease.id &&
      current.record.fenceGeneration === fenceGeneration &&
      current.record.phase === row.record.phase
      ? current
      : undefined;
  };
  const assertCurrent = async () => {
    parent.signal.throwIfAborted();
    await parent.assertCurrent();
    const current = await readClaimed();
    if (current === undefined || Date.parse(lease.expiresAt) <= now()) {
      throw uncertain();
    }
    if (
      current.record.deliveryPlanDigest !== parent.deliveryPlanDigest ||
      !isDeepStrictEqual(current.record.approval, parent.approval) ||
      !isDeepStrictEqual(current.record.gateway.receipt, parent.gateway)
    ) {
      throw mismatch();
    }
  };
  const restore = async () => {
    const current = await readClaimed();
    if (current === undefined) {
      return false;
    }
    return (
      (await store.compareAndSet(key, current.revision, {
        ...current.record,
        lease: undefined,
        phase: row.record.phase,
      })) !== undefined
    );
  };
  let result: T;
  try {
    await assertCurrent();
    result = await input.run({ ...parent, assertCurrent, fenceGeneration });
    await assertCurrent();
  } catch (error) {
    await restore();
    throw error;
  }
  if (!(await restore())) {
    throw uncertain();
  }
  return result;
};

export const createNativeTargetAuthOnlyEntryDeployment = (input: {
  authority: NativeTargetAuthOnlyEntryAuthority;
  store: ChildStore;
  readApproval: (
    key: NativeTargetAuthOnlyEntryPlanKey,
    approvalInput: NativeTargetAuthOnlyEntryApprovalInput,
    assertCurrent: () => Promise<void>,
  ) => Promise<NativeTargetAuthOnlyApproval | null>;
}) => {
  const resolveAuthority = async (value: HookInput, mode: "retained" | "fenced") => {
    await value.assertCurrent();
    const current = await input.authority(value, mode);
    if (current === undefined) {
      throw new HostedOperatorError("auth_schema_not_ready");
    }
    return current;
  };
  const preparation = (ports: ResolvedAuthority, allowedWrite?: Effect): Ports => {
    const readApproved = async (scope: Scope, effect: Effect) => {
      const key = childKey(scope, effect);
      const retained = await input.store.read(key);
      const approval = retained?.record.approval;
      if (approval?.outcome !== "approved" || retained === undefined) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- The hook distinguishes absent approval from a denied read.
        return undefined;
      }
      const assertCurrent = async () => {
        await scope.input.assertCurrent();
        const actual = await input.readApproval(
          key,
          retained.approvalInput,
          scope.input.assertCurrent,
        );
        if (!isDeepStrictEqual(actual, approval)) {
          throw denied();
        }
      };
      const opened = await input.store.openApprovedEffect(key, approval, assertCurrent);
      return effect === allowedWrite
        ? opened
        : { ...opened, claimFirstDispatch: async () => Promise.resolve(false) };
    };
    return {
      ...ports,
      readApprovedOrganization: async (scope) => await readApproved(scope, "organization"),
      readApprovedSignupPolicy: async (scope) => await readApproved(scope, "signup-policy"),
    };
  };
  const exactChild = async (scope: Scope, proposal: NativeTargetAuthOnlyEntryApprovalInput) => {
    const key = childKey(scope, proposal.effect);
    const retained = await input.store.read(key);
    if (retained === undefined || !isDeepStrictEqual(retained.approvalInput, proposal)) {
      throw mismatch();
    }
    return { key, retained };
  };
  const buildPlan = async (ports: ResolvedAuthority, scope: PlannedScope, effect: Effect) => {
    if (effect === "organization") {
      const proposed = await ports.readOrganizationPlan(scope);
      if (proposed === undefined) {
        throw mismatch();
      }
      const { identityCapture, actorId } = proposed.authMembership;
      if (
        actorId !== scope.identity.actorId ||
        identityCapture.realmSessionId !== scope.identity.realmSessionId
      ) {
        throw identityRequired();
      }
      return proposed;
    }

    const organization = await input.store.read(childKey(scope, "organization"));
    if (organization === undefined) {
      throw mismatch();
    }
    const specification = authOnlyOrganizationPlanSchema.parse(
      JSON.parse(organization.approvedPlanBytes.toString("utf-8")),
    ).authMembership;
    const proposed = await ports.readSignupPolicyPlan(scope, specification.organizationId);
    if (proposed === undefined) {
      throw mismatch();
    }
    const policy = proposed.authSignupPolicy;
    if (
      policy.organizationId !== specification.organizationId ||
      policy.origin !== scope.binding.issuer ||
      policy.appRoles[0] !== scope.input.plan.appRole
    ) {
      throw mismatch();
    }
    return proposed;
  };
  return {
    async afterGatewayReady(value: HookInput) {
      const ports = await resolveAuthority(value, "fenced");
      return await createNativeTargetAuthOnlyEntryPreparation(preparation(ports))(value);
    },
    async execute(value: HookInput, proposal: NativeTargetAuthOnlyEntryApprovalInput) {
      const ports = await resolveAuthority(value, "fenced");
      const scope = await readConsumed(ports, value);
      const { key } = await exactChild(scope, proposal);
      const approval = await input.readApproval(key, proposal, value.assertCurrent);
      if (approval === null) {
        throw denied();
      }
      await value.assertCurrent();
      await input.store.settle(key, approval);
      if (approval.outcome !== "approved") {
        throw denied();
      }
      if (proposal.effect === "organization") {
        await createNativeTargetAuthOnlyOrganizationPreparation(preparation(ports, "organization"))(
          value,
        );
      } else {
        const observed = await createNativeTargetAuthOnlyEntryPreparation(
          preparation(ports, "signup-policy"),
        )(value);
        if (observed.status !== "ready") {
          throw identityRequired();
        }
      }
      await value.assertCurrent();
      return {
        status: "prepared" as const,
        effect: proposal.effect,
        childOperationRef: proposal.childOperationRef,
        childPlanDigest: proposal.childPlanDigest,
      };
    },
    async plan(value: HookInput, effect: Effect) {
      const ports = await resolveAuthority(value, "retained");
      const scope = await readConsumed(ports, value);
      const key = childKey(scope, effect);
      const retained = await input.store.read(key);
      if (retained !== undefined) {
        return retained.approvalInput;
      }
      const plan = await buildPlan(ports, scope, effect);
      await value.assertCurrent();
      const saved = await input.store.retain(key, encodeNativeTargetAuthOnlyEntryPlan(key, plan));
      await value.assertCurrent();
      return saved.approvalInput;
    },
    async readSettlement(value: HookInput, proposal: NativeTargetAuthOnlyEntryApprovalInput) {
      const ports = await resolveAuthority(value, "retained");
      const scope = await readConsumed(ports, value);
      const { key } = await exactChild(scope, proposal);
      const approval = await input.readApproval(key, proposal, value.assertCurrent);
      if (approval?.outcome === "cancelled") {
        throw denied();
      }
      return approval === null ? ("pending" as const) : ("approved" as const);
    },
  };
};
