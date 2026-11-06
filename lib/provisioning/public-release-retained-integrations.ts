import type { PublicReleaseRow } from "./public-release-handler";
import type { AppIntegrationCapabilityRow } from "./app-integration-capability-store";
import type { AppIntegrationReleaseAttachment } from "./app-integration-release-contract";
import { isDeepStrictEqual } from "node:util";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";
import type { OperatorOwnerContext, HostedOperatorPlan } from "./hosted-operator-contract";
import type { OwnedBuilderDestination } from "./owned-builder-runtime";
import type { PublicReleaseRequestAuthority } from "./public-release-dispatcher";
import { createPostgresPublicReleaseStore } from "./public-release-store";
import { createPostgresAppIntegrationCapabilityStore } from "./app-integration-capability-store";
import { createPublicReleaseApprovalAuthority } from "./public-release-approval-authority";
import { createAppIntegrationCapabilityApprovalAuthority } from "./app-integration-capability-approval";
import {
  retainedOptionalIntegrationBindingsSchema,
  appIntegrationOptionalEnvironmentKeys,
} from "./app-integration-release-contract";
import { PublicReleasePrerequisiteError } from "./public-release-prerequisite";

const fail = () =>
  new PublicReleasePrerequisiteError("public_release_integration_capability_required");
export interface RetentionProviderBinding {
  key: string;
  id: string;
  operationRef: string;
  sha256: string;
}
const sourceOperation = (bindings: RetentionProviderBinding[]) => {
  const valid = [
    bindings.length === 2,
    new Set(bindings.map((entry) => entry.key)).size === 2,
    !bindings.some(
      (entry) => !new Set<string>(appIntegrationOptionalEnvironmentKeys).has(entry.key),
    ),
    new Set(bindings.map((entry) => entry.operationRef)).size === 1,
  ];
  if (valid.includes(false)) {
    throw fail();
  }
  const operation = bindings.at(0)?.operationRef;
  if (operation === undefined) {
    throw fail();
  }
  return operation;
};
const requireSourceRelease = (source: PublicReleaseRow | undefined) => {
  if (source === undefined) {
    throw fail();
  }
  const prior = source.record.plan;
  const capPointer = prior.integrationCapability;
  const approvals = source.record.approvalReceipts;
  if (capPointer === undefined || approvals === undefined) {
    throw fail();
  }
  const valid = [
    source.record.observation?.status === "ready",
    prior.purpose === "application",
    approvals.length > 0,
    !Object.values(source.record.effects).some((value) => value !== "applied"),
  ];
  if (valid.includes(false)) {
    throw fail();
  }
  return { approvals, capPointer, prior, source };
};
const requireSourceCapability = (
  cap: AppIntegrationCapabilityRow | undefined,
  pointer: AppIntegrationReleaseAttachment,
) => {
  if (cap === undefined) {
    throw fail();
  }
  const valid = [
    cap.record.prepared !== undefined,
    cap.record.planDigest === pointer.planDigest,
    cap.record.approvalReceipts.length > 0,
    isDeepStrictEqual(cap.record.prepared, pointer.capability),
  ];
  if (valid.includes(false)) {
    throw fail();
  }
  return cap;
};
export interface RetainedIntegrationReadScope {
  owner: OperatorOwnerContext;
  authority: PublicReleaseRequestAuthority;
  owned: {
    purpose: "auth-bootstrap" | "application";
    selection: { appId: string };
    destination: OwnedBuilderDestination;
    operator: { plan: Pick<HostedOperatorPlan, "appDatabase" | "neon"> };
  };
  publicOrigin: string;
  allowApplicationRemoval?: true;
  assertCurrent: () => Promise<void>;
  readSourceOwner?: (target: { appId: string; sessionId: string }) => Promise<OperatorOwnerContext>;
  readProviderBindings: () => Promise<RetentionProviderBinding[]>;
}
export interface RetainedIntegrationReadPorts {
  publicReleases: Pick<ReturnType<typeof createPostgresPublicReleaseStore>, "read">;
  capabilities: Pick<ReturnType<typeof createPostgresAppIntegrationCapabilityStore>, "read">;
  readPublicApproval: (input: {
    plan: PublicReleaseRow["record"]["plan"];
    owner: OperatorOwnerContext;
    callId: string;
    assertCurrent: () => Promise<void>;
  }) => Promise<{ approvalId: string; approvedByCallId: string }>;
  readCapabilityApproval: (input: {
    plan: AppIntegrationCapabilityRow["record"]["plan"];
    owner: OperatorOwnerContext;
    callId: string;
    assertCurrent: () => Promise<void>;
  }) => Promise<{ approvalId: string; approvedByCallId: string }>;
}
/** Read-only service boundary; production always supplies real SQL journals and authenticated native histories. */
export const createOptionalIntegrationRetentionReader =
  (ports: RetainedIntegrationReadPorts) => async (input: RetainedIntegrationReadScope) => {
    await input.assertCurrent();
    const observedBindings = await input.readProviderBindings();
    const first = observedBindings.toSorted((a, b) => a.key.localeCompare(b.key));
    await input.assertCurrent();
    if (first.length === 0) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- No existing optional binding needs retention authority.
      return undefined;
    }
    const { readSourceOwner } = input;
    if (readSourceOwner === undefined) {
      throw fail();
    }
    const operationRef = sourceOperation(first);
    const store = ports.publicReleases;
    const observedSource = await store.read(input.owner.authority, operationRef);
    const { source, prior, capPointer, approvals } = requireSourceRelease(observedSource);
    const capStore = ports.capabilities;
    const observedCapability = await capStore.read(input.owner.authority, capPointer.operationRef);
    const cap = requireSourceCapability(observedCapability, capPointer);
    const old = cap.record.plan;
    const current = input.owned;
    const resource = current.operator.plan.appDatabase;
    const matches = [
      current.purpose === "auth-bootstrap" ||
        (current.purpose === "application" && input.allowApplicationRemoval === true),
      prior.selection.appId === current.selection.appId,
      old.selection.appId === current.selection.appId,
      prior.selection.sessionId === old.selection.sessionId,
      prior.project.projectId === current.destination.projectId,
      old.project.projectId === current.destination.projectId,
      prior.project.teamId === current.destination.teamId,
      old.project.teamId === current.destination.teamId,
      old.project.installationId === current.destination.installationId,
      prior.project.installationId === current.destination.installationId,
      prior.project.provisioningRequestId === current.destination.provisioningRequestId,
      prior.project.provisioningDigest === current.destination.provisioningDigest,
      old.project.provisioningRequestId === current.destination.provisioningRequestId,
      old.project.provisioningDigest === current.destination.provisioningDigest,
      prior.runtime.operationRef === old.runtime.operationRef,
      prior.runtime.planDigest === old.runtime.planDigest,
      prior.runtime.releaseId === old.release.id,
      prior.publicOrigin === input.publicOrigin,
      old.publicOrigin === input.publicOrigin,
      old.runtime.appDatabase.resourceId === resource.resourceId,
      old.runtime.appDatabase.database === resource.database,
      old.runtime.appDatabase.runtimeRole === resource.runtimeRole,
      old.runtime.appDatabase.migratorRole === resource.migratorRole,
      old.runtime.appDatabase.hostname === current.operator.plan.neon.endpoint,
      old.runtime.neon.projectId === current.operator.plan.neon.projectId,
      old.runtime.neon.branchId === current.operator.plan.neon.branchId,
    ];
    if (matches.includes(false)) {
      throw fail();
    }
    const values = first.map((binding) => {
      const planned = prior.environment.find((entry) => entry.key === binding.key);
      const accepted = source.record.bindings[binding.key];
      if (
        planned === undefined ||
        planned.sha256 !== binding.sha256 ||
        accepted?.state !== "applied" ||
        accepted.acceptedEnvId !== binding.id
      ) {
        throw fail();
      }
      return {
        acceptedEnvId: binding.id,
        key: binding.key,
        sha256: binding.sha256,
        sourceOperationRef: operationRef,
        sourcePlanDigest: source.record.planDigest,
      };
    });
    const retained = retainedOptionalIntegrationBindingsSchema.parse(values);
    const sourceOwner = await readSourceOwner({
      appId: prior.selection.appId,
      sessionId: prior.selection.sessionId,
    });
    if (
      sourceOwner.sessionId !== prior.selection.sessionId ||
      !isDeepStrictEqual(sourceOwner.authority, input.owner.authority)
    ) {
      throw fail();
    }
    const assertSource = async () => {
      await input.assertCurrent();
      await input.authority.assertCanonicalAppOwner({
        authority: sourceOwner.authority,
        ownerContext: sourceOwner,
        target: prior.selection,
      });
      await input.assertCurrent();
    };
    await assertSource();
    for (const receipt of approvals) {
      // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- The source owner's single durable native history cursor is read in order.
      const actual = await ports.readPublicApproval({
        assertCurrent: assertSource,
        callId: receipt.approvedByCallId,
        owner: sourceOwner,
        plan: prior,
      });
      if (!isDeepStrictEqual(actual, receipt)) {
        throw fail();
      }
    }
    for (const receipt of cap.record.approvalReceipts) {
      // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- The source owner's single durable native history cursor is read in order.
      const actual = await ports.readCapabilityApproval({
        assertCurrent: assertSource,
        callId: receipt.approvedByCallId,
        owner: sourceOwner,
        plan: old,
      });
      if (!isDeepStrictEqual(actual, receipt)) {
        throw fail();
      }
    }
    const observedSecond = await input.readProviderBindings();
    const second = observedSecond.toSorted((a, b) => a.key.localeCompare(b.key));
    await assertSource();
    const latestSource = await store.read(input.owner.authority, operationRef);
    // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Re-read both retained journals after the provider/approval observations; no mutation authority is inferred.
    const latestCap = await capStore.read(input.owner.authority, capPointer.operationRef);
    if (
      !isDeepStrictEqual(first, second) ||
      !isDeepStrictEqual(latestSource, source) ||
      !isDeepStrictEqual(latestCap, cap)
    ) {
      throw fail();
    }
    return { bindings: retained, sourceCapability: capPointer };
  };

export const createRetainedOptionalIntegrationReader = (ports: RetainedIntegrationReadPorts) => {
  const read = createOptionalIntegrationRetentionReader(ports);
  return async (input: RetainedIntegrationReadScope) => {
    const value = await read(input);
    return value?.bindings;
  };
};

/** Provider-owned row IDs select exact previous journals; no history election and no effect writes. */
export const readOptionalIntegrationRetention = async (
  input: RetainedIntegrationReadScope & {
    database: ReturnType<typeof openHostedPostgresDatabase>;
    request: Request;
    builderOrigin: string;
    fetch?: typeof fetch;
  },
) => {
  const reader = createOptionalIntegrationRetentionReader({
    capabilities: createPostgresAppIntegrationCapabilityStore(input.database),
    publicReleases: createPostgresPublicReleaseStore(input.database),
    readCapabilityApproval: async ({ plan, owner, callId, assertCurrent }) =>
      await createAppIntegrationCapabilityApprovalAuthority({
        assertCurrentOwner: assertCurrent,
        authority: input.authority,
        builderOrigin: input.builderOrigin,
        database: input.database,
        fetch: input.fetch,
        owner,
        request: input.request,
      })(plan, callId),
    readPublicApproval: async ({ plan, owner, callId, assertCurrent }) =>
      await createPublicReleaseApprovalAuthority({
        assertCurrentOwner: assertCurrent,
        authority: input.authority,
        builderOrigin: input.builderOrigin,
        database: input.database,
        fetch: input.fetch,
        owner,
        request: input.request,
      })(plan, callId),
  });
  return await reader(input);
};

export const readRetainedOptionalIntegrationBindings = async (
  input: Parameters<typeof readOptionalIntegrationRetention>[0],
) => {
  const value = await readOptionalIntegrationRetention(input);
  return value?.bindings;
};
