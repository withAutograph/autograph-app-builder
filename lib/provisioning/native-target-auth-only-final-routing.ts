import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { builderProvisioningJournals } from "../db/schema";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Drizzle uses the complete schema type.
import type * as databaseSchema from "../db/schema";
import { HostedOperatorError, operatorDeploymentCandidateSchema } from "./hosted-operator-contract";
import type { OperatorDeploymentCandidate } from "./hosted-operator-contract";
import { nativeTargetAuthOnlyApprovalSchema } from "./native-target-auth-only-dispatch";
import type { NativeTargetAuthOnlyApproval } from "./native-target-auth-only-dispatch";
import {
  createNativeTargetAuthOnlyGatewayProjection,
  nativeTargetAuthOnlyGatewayProjectionIntentSchema,
  projectNativeTargetAuthOnlyGatewayBinding,
} from "./native-target-auth-only-gateway-projection";
import {
  createNativeTargetAuthOnlyPreviewDelivery,
  nativeTargetAuthOnlyPreviewDeliveryPlanSchema,
} from "./native-target-auth-only-preview-delivery";
import type { NativeTargetAuthOnlyPreviewDeliveryInput } from "./native-target-auth-only-preview-delivery";
import {
  nativeTargetAuthOnlyDeliveryPlanDigest,
  nativeTargetAuthOnlyDeliveryPlanSchema,
} from "./native-target-auth-only-delivery-plan";
import type { NativeTargetAuthOnlyGatewayProjectionRow } from "./native-target-auth-only-preview-environment-adapter";
import { trustedGatewayProjectProjectionSchema } from "./trusted-gateway-project-projection";

const id = z.string().min(1);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const ready = operatorDeploymentCandidateSchema.extend({ readyState: z.literal("READY") });
type Ready = z.infer<typeof ready>;
const exactHttpsOrigin = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
});
const REFRESH_EFFECT = "auth-only-gateway-routing-refresh";
const API = "https://api.vercel.com";
const mismatch = () => new HostedOperatorError("resource_mismatch");
const denied = () => new HostedOperatorError("authorization_required");
const uncertain = () => new HostedOperatorError("reconciliation_required");

export const nativeTargetAuthOnlyFinalRoutingPlanSchema = z.strictObject({
  app: ready,
  bootstrap: ready,
  deliveryOperationRef: z.uuid(),
  deliveryPlanDigest: sha256,
  gateway: z.strictObject({
    projectId: id,
    repoId: id,
    branch: id,
    gitRef: id,
    gitSha: z.string().regex(/^[a-f0-9]{40}$/u),
    publicOrigin: exactHttpsOrigin,
  }),
  kind: z.literal("native-target-auth-only-final-routing"),
  operationRef: z.uuid(),
  projection: nativeTargetAuthOnlyGatewayProjectionIntentSchema,
  source: trustedGatewayProjectProjectionSchema.shape.source,
  target: nativeTargetAuthOnlyDeliveryPlanSchema.shape.target,
  version: z.literal(1),
});
type RoutingPlan = z.infer<typeof nativeTargetAuthOnlyFinalRoutingPlanSchema>;

export const nativeTargetAuthOnlyFinalRoutingPlanDigest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

export const nativeTargetAuthOnlyFinalRoutingRecordSchema = z.strictObject({
  approval: nativeTargetAuthOnlyApprovalSchema,
  kind: z.literal("native-target-auth-only-final-routing"),
  operationRef: z.uuid(),
  projectionAttempt: nativeTargetAuthOnlyGatewayProjectionIntentSchema.optional(),
  refreshAttempted: z.boolean(),
  refreshCandidates: z.array(operatorDeploymentCandidateSchema),
  refreshReceipt: ready.optional(),
  routingPlanBase64: id,
  routingPlanDigest: sha256,
  version: z.literal(1),
});
type RoutingRecord = z.infer<typeof nativeTargetAuthOnlyFinalRoutingRecordSchema>;
interface RoutingRow {
  revision: number;
  record: RoutingRecord;
}
export interface NativeTargetAuthOnlyFinalRoutingKey {
  authority: z.infer<typeof hostedTenantAuthoritySchema>;
  appId: string;
  sessionId: string;
  operationRef: string;
}
interface RoutingStore {
  /** This instance is bound to the same owner, saved session, and routing operation. */
  read: () => Promise<RoutingRow | undefined>;
  compareAndSet: (revision: number, record: RoutingRecord) => Promise<RoutingRow | undefined>;
}

const routingRequestId = (key: NativeTargetAuthOnlyFinalRoutingKey) => {
  const hex = createHash("sha256")
    .update(
      JSON.stringify([
        "native-target-auth-only-final-routing-v1",
        key.authority.issuer,
        key.authority.audience,
        key.authority.workspaceId,
        key.authority.ownerUserId,
        key.appId,
        key.sessionId,
        key.operationRef,
      ]),
    )
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const routingRowState = (record: RoutingRecord) =>
  record.refreshReceipt === undefined ? "pending" : "settled";

const validateCandidate = (candidate: OperatorDeploymentCandidate, plan: RoutingPlan) => {
  if (
    candidate.operationRef !== plan.operationRef ||
    candidate.projectId !== plan.gateway.projectId ||
    candidate.branch !== plan.gateway.branch ||
    candidate.repoId !== plan.gateway.repoId
  ) {
    throw mismatch();
  }
  if (
    candidate.deploymentId === plan.bootstrap.deploymentId ||
    candidate.deploymentId === plan.app.deploymentId ||
    candidate.origin === plan.bootstrap.origin
  ) {
    throw mismatch();
  }
};

/** Store the exact separately approved routing plan and its retry journal in the constrained owner journal. */
export const createPostgresNativeTargetAuthOnlyFinalRoutingStore = (
  database: PostgresJsDatabase<typeof databaseSchema>,
) => {
  const predicate = (key: NativeTargetAuthOnlyFinalRoutingKey) =>
    and(
      eq(builderProvisioningJournals.issuer, key.authority.issuer),
      eq(builderProvisioningJournals.audience, key.authority.audience),
      eq(builderProvisioningJournals.workspaceId, key.authority.workspaceId),
      eq(builderProvisioningJournals.ownerUserId, key.authority.ownerUserId),
      eq(builderProvisioningJournals.requestId, routingRequestId(key)),
    );
  const validateKeyRecord = (key: NativeTargetAuthOnlyFinalRoutingKey, record: RoutingRecord) => {
    const bytes = Buffer.from(record.routingPlanBase64, "base64");
    const plan = nativeTargetAuthOnlyFinalRoutingPlanSchema.parse(
      JSON.parse(bytes.toString("utf-8")),
    );
    const exactRecord = [
      bytes.toString("base64") === record.routingPlanBase64,
      nativeTargetAuthOnlyFinalRoutingPlanDigest(bytes) === record.routingPlanDigest,
      record.operationRef === key.operationRef,
      plan.operationRef === key.operationRef,
      plan.target.appId === key.appId,
      plan.target.sessionId === key.sessionId,
      plan.app.operationRef === plan.deliveryOperationRef,
      record.approval.planDigest === record.routingPlanDigest,
      record.approval.sourceDigest === record.routingPlanDigest,
      record.approval.outcome === "approved",
      record.approval.publicSessionId === key.sessionId,
      record.approval.responderPrincipalId === key.authority.ownerUserId,
    ].every(Boolean);
    if (!exactRecord) {
      throw mismatch();
    }
    for (const candidate of record.refreshCandidates) {
      validateCandidate(candidate, plan);
    }
    if (
      record.refreshReceipt !== undefined &&
      !record.refreshCandidates.some((candidate) =>
        isDeepStrictEqual(candidate, record.refreshReceipt),
      )
    ) {
      throw mismatch();
    }
    // Projection intent is claimed before refresh is attempted. A refresh
    // attempt requires that intent, while an intent without a refresh attempt
    // is the valid durable intermediate state.
    if (record.refreshAttempted && record.projectionAttempt === undefined) {
      throw mismatch();
    }
    if (
      record.projectionAttempt !== undefined &&
      !isDeepStrictEqual(record.projectionAttempt, plan.projection)
    ) {
      throw mismatch();
    }
    return record;
  };
  const parse = (
    key: NativeTargetAuthOnlyFinalRoutingKey,
    row: typeof builderProvisioningJournals.$inferSelect,
  ) => {
    const record = validateKeyRecord(
      key,
      nativeTargetAuthOnlyFinalRoutingRecordSchema.parse(row.record),
    );
    if (
      row.requestId !== routingRequestId(key) ||
      row.requestDigest !== record.routingPlanDigest ||
      row.state !== routingRowState(record)
    ) {
      throw mismatch();
    }
    return { record, revision: row.revision };
  };
  const read: (
    key: NativeTargetAuthOnlyFinalRoutingKey,
  ) => Promise<RoutingRow | undefined> = async (key) => {
    const [row] = await database
      .select()
      .from(builderProvisioningJournals)
      .where(predicate(key))
      .limit(1);
    return row === undefined ? undefined : parse(key, row);
  };
  return {
    async compareAndSet(
      key: NativeTargetAuthOnlyFinalRoutingKey,
      revision: number,
      rawRecord: RoutingRecord,
    ) {
      const record = validateKeyRecord(
        key,
        nativeTargetAuthOnlyFinalRoutingRecordSchema.parse(rawRecord),
      );
      const [row] = await database
        .update(builderProvisioningJournals)
        .set({
          record,
          revision: revision + 1,
          state: routingRowState(record),
          updatedAt: new Date(),
        })
        .where(
          and(
            predicate(key),
            eq(builderProvisioningJournals.revision, revision),
            eq(builderProvisioningJournals.requestDigest, record.routingPlanDigest),
          ),
        )
        .returning();
      return row === undefined ? undefined : parse(key, row);
    },
    read,
    async retain(
      key: NativeTargetAuthOnlyFinalRoutingKey,
      bytes: Buffer,
      rawApproval: NativeTargetAuthOnlyApproval,
    ) {
      const approval = nativeTargetAuthOnlyApprovalSchema.parse(rawApproval);
      const plan = nativeTargetAuthOnlyFinalRoutingPlanSchema.parse(
        JSON.parse(bytes.toString("utf-8")),
      );
      const routingPlanDigest = nativeTargetAuthOnlyFinalRoutingPlanDigest(bytes);
      if (
        ![
          plan.operationRef === key.operationRef,
          plan.target.appId === key.appId,
          plan.target.sessionId === key.sessionId,
          approval.planDigest === routingPlanDigest,
          approval.sourceDigest === routingPlanDigest,
          approval.outcome === "approved",
          approval.publicSessionId === key.sessionId,
          approval.responderPrincipalId === key.authority.ownerUserId,
        ].every(Boolean)
      ) {
        throw denied();
      }
      const record = nativeTargetAuthOnlyFinalRoutingRecordSchema.parse({
        kind: "native-target-auth-only-final-routing",
        version: 1,
        operationRef: key.operationRef,
        routingPlanDigest,
        routingPlanBase64: bytes.toString("base64"),
        approval,
        refreshAttempted: false,
        refreshCandidates: [],
      });
      validateKeyRecord(key, record);
      const now = new Date();
      await database
        .insert(builderProvisioningJournals)
        .values({
          ...key.authority,
          requestId: routingRequestId(key),
          requestDigest: routingPlanDigest,
          record,
          revision: 1,
          state: "pending",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
      const retained = await read(key);
      if (
        retained === undefined ||
        retained.record.routingPlanBase64 !== record.routingPlanBase64 ||
        !isDeepStrictEqual(retained.record.approval, approval)
      ) {
        throw mismatch();
      }
      return retained;
    },
  };
};

type ProjectionDeps = Parameters<typeof createNativeTargetAuthOnlyGatewayProjection>[0];
type ProjectionProviders = Parameters<typeof createNativeTargetAuthOnlyGatewayProjection>[1];
type ProjectionInput = Parameters<
  ReturnType<typeof createNativeTargetAuthOnlyGatewayProjection>
>[0];
interface RoutingInput {
  projection: ProjectionInput;
  routingPlanBytes: Buffer;
  approval: NativeTargetAuthOnlyApproval;
  fenceGeneration: number;
  /** Re-read the original routing settlement and current exclusive Gateway lease. */
  assertCurrent: () => Promise<void>;
}
interface RetainedParent {
  bootstrap: Ready;
  app: Ready;
}

const matchesReceiptSource = (
  candidate: Ready,
  source: { projectId: string; branch: string; repoId: string },
  operationRef: string,
) =>
  isDeepStrictEqual(
    {
      branch: candidate.branch,
      operationRef: candidate.operationRef,
      projectId: candidate.projectId,
      repoId: candidate.repoId,
    },
    { branch: source.branch, operationRef, projectId: source.projectId, repoId: source.repoId },
  );

const checkProjectionScope = (plan: RoutingPlan, ownerId: string) => {
  const projectionScope = {
    appDeploymentId: plan.projection.appDeploymentId,
    deliveryPlanDigest: plan.projection.deliveryPlanDigest,
    gatewayProjectId: plan.projection.gatewayProjectId,
    operationRef: plan.projection.operationRef,
  };
  if (
    !isDeepStrictEqual(projectionScope, {
      appDeploymentId: plan.app.deploymentId,
      deliveryPlanDigest: plan.deliveryPlanDigest,
      gatewayProjectId: plan.gateway.projectId,
      operationRef: plan.deliveryOperationRef,
    })
  ) {
    throw mismatch();
  }
  if (
    plan.source.projectId !== plan.gateway.projectId ||
    plan.source.publicOrigin !== plan.gateway.publicOrigin ||
    plan.source.ownerId !== ownerId
  ) {
    throw mismatch();
  }
};

const assertParentApproval = (
  environment: ProjectionInput["environment"],
  parentDigest: string,
) => {
  const { approval, authority, target } = environment;
  if (
    approval.outcome !== "approved" ||
    approval.planDigest !== parentDigest ||
    approval.sourceDigest !== parentDigest
  ) {
    throw denied();
  }
  if (
    approval.responderPrincipalId !== authority.ownerUserId ||
    approval.publicSessionId !== target.sessionId ||
    environment.effect !== "gateway"
  ) {
    throw denied();
  }
};

/** Freeze a read-only plan for the final alias refresh after both parent deployments are READY. */
export const buildNativeTargetAuthOnlyFinalRoutingPlanBytes = (input: {
  operationRef: string;
  environment: ProjectionInput["environment"];
  bootstrap: Ready;
  app: Ready;
  source: RoutingPlan["source"];
  projectionRow: NativeTargetAuthOnlyGatewayProjectionRow;
}) => {
  const operationRef = z.uuid().parse(input.operationRef);
  const { environment, bootstrap, app, source, projectionRow } = input;
  const { deliveryPlan, target, operationRef: deliveryOperationRef } = environment;
  const { gatewayDelivery, publicGateway } = deliveryPlan.delivery;
  const appSource = deliveryPlan.delivery.delivery;
  if (
    gatewayDelivery === undefined ||
    publicGateway === undefined ||
    appSource === undefined ||
    operationRef === deliveryOperationRef
  ) {
    throw mismatch();
  }
  const parentBytes = Buffer.from(JSON.stringify(deliveryPlan));
  const deliveryPlanDigest = nativeTargetAuthOnlyDeliveryPlanDigest(parentBytes);
  assertParentApproval(environment, deliveryPlanDigest);
  const exactGateway = {
    branch: gatewayDelivery.branch,
    gitRef: gatewayDelivery.gitRef ?? gatewayDelivery.branch,
    gitSha: gatewayDelivery.gitSha,
    projectId: gatewayDelivery.projectId,
    publicOrigin: publicGateway.origin,
    repoId: gatewayDelivery.repoId,
  };
  if (
    !matchesReceiptSource(bootstrap, exactGateway, deliveryOperationRef) ||
    !matchesReceiptSource(app, { ...appSource, projectId: target.projectId }, deliveryOperationRef)
  ) {
    throw mismatch();
  }
  const nextProjection = projectNativeTargetAuthOnlyGatewayBinding(
    { appReceipt: app, environment, source },
    projectionRow.value,
    app,
  );
  const plan = nativeTargetAuthOnlyFinalRoutingPlanSchema.parse({
    app,
    bootstrap,
    deliveryOperationRef,
    deliveryPlanDigest,
    gateway: exactGateway,
    kind: "native-target-auth-only-final-routing",
    operationRef,
    projection: {
      appDeploymentId: app.deploymentId,
      deliveryPlanDigest,
      gatewayProjectId: projectionRow.projectId,
      nextSha256: createHash("sha256").update(nextProjection).digest("hex"),
      operationRef: deliveryOperationRef,
      physicalBranch: projectionRow.physicalBranch,
      priorSha256: createHash("sha256").update(projectionRow.value).digest("hex"),
      rowId: projectionRow.rowId,
    },
    source,
    target,
    version: 1,
  });
  return Buffer.from(JSON.stringify(plan));
};

const checkParent = (input: RoutingInput, plan: RoutingPlan, parent: RetainedParent) => {
  const { environment, appReceipt, source } = input.projection;
  const { deliveryPlan, target, operationRef } = environment;
  const { publicGateway, gatewayDelivery, delivery } = deliveryPlan.delivery;
  if (publicGateway === undefined || gatewayDelivery === undefined || delivery === undefined) {
    throw mismatch();
  }
  const { bootstrap, app } = parent;
  if (
    ![
      isDeepStrictEqual(plan.bootstrap, bootstrap),
      isDeepStrictEqual(plan.app, app),
      isDeepStrictEqual(plan.target, target),
      isDeepStrictEqual(appReceipt, app),
      isDeepStrictEqual(source, plan.source),
    ].every(Boolean)
  ) {
    throw mismatch();
  }
  const parentDigest = nativeTargetAuthOnlyDeliveryPlanDigest(
    Buffer.from(JSON.stringify(deliveryPlan)),
  );
  assertParentApproval(environment, parentDigest);
  if (
    operationRef !== plan.deliveryOperationRef ||
    plan.operationRef === operationRef ||
    plan.deliveryPlanDigest !== parentDigest
  ) {
    throw mismatch();
  }
  const exactGateway = {
    branch: gatewayDelivery.branch,
    gitRef: gatewayDelivery.gitRef ?? gatewayDelivery.branch,
    gitSha: gatewayDelivery.gitSha,
    projectId: gatewayDelivery.projectId,
    publicOrigin: publicGateway.origin,
    repoId: gatewayDelivery.repoId,
  };
  if (!isDeepStrictEqual(plan.gateway, exactGateway)) {
    throw mismatch();
  }
  if (
    !matchesReceiptSource(bootstrap, exactGateway, operationRef) ||
    !matchesReceiptSource(app, { ...delivery, projectId: target.projectId }, operationRef)
  ) {
    throw mismatch();
  }
  checkProjectionScope(plan, target.scopeId);
  return nativeTargetAuthOnlyPreviewDeliveryPlanSchema.parse({
    action: "prepare",
    effects: [{ id: REFRESH_EFFECT, kind: "gateway-delivery" }],
    gatewayDelivery: { ...gatewayDelivery, gitRef: exactGateway.gitRef },
    publicGateway,
    stage: "app",
  });
};

const requestMethod = (raw: URL | Request | string, init?: RequestInit) =>
  init?.method ?? (raw instanceof Request ? raw.method : "GET");
const requestUrl = (raw: URL | Request | string) =>
  new URL(raw instanceof Request ? raw.url : String(raw));

const deploymentBodySchema = z.object({
  gitSource: z.strictObject({ type: z.literal("github"), ref: id, repoId: id, sha: id }),
  meta: z.strictObject({
    autograph_operator_effect: z.literal(REFRESH_EFFECT),
    autograph_operator_operation: z.uuid(),
    autograph_operator_plan: sha256,
  }),
  project: id,
});
const aliasSchema = z.object({
  alias: id,
  deploymentId: id,
  projectId: id,
  redirect: z.string().nullable().optional(),
});

const readApprovedRouting = (input: RoutingInput) => {
  const { environment } = input.projection;
  const planBytes = Buffer.from(input.routingPlanBytes);
  const plan = nativeTargetAuthOnlyFinalRoutingPlanSchema.parse(
    JSON.parse(planBytes.toString("utf-8")),
  );
  const planDigest = nativeTargetAuthOnlyFinalRoutingPlanDigest(planBytes);
  const approval = nativeTargetAuthOnlyApprovalSchema.parse(input.approval);
  if (
    approval.planDigest !== planDigest ||
    approval.sourceDigest !== planDigest ||
    approval.outcome !== "approved"
  ) {
    throw denied();
  }
  if (
    approval.responderPrincipalId !== environment.authority.ownerUserId ||
    approval.publicSessionId !== environment.target.sessionId ||
    !Number.isSafeInteger(input.fenceGeneration) ||
    input.fenceGeneration <= 0
  ) {
    throw denied();
  }
  if (
    approval.callId === environment.approval.callId ||
    approval.requestId === environment.approval.requestId
  ) {
    throw denied();
  }
  return { approval, environment, plan, planBytes, planDigest };
};

/** Publish only the approved projection and separately reconcile a refreshed Gateway and stable alias. */
export const createNativeTargetAuthOnlyFinalRouting =
  (
    deps: Pick<ProjectionDeps, "readCredential" | "fetch" | "assertCatalogApp"> & {
      store: RoutingStore;
      readRetainedParent: () => Promise<RetainedParent | undefined>;
      wait?: Parameters<typeof createNativeTargetAuthOnlyPreviewDelivery>[0]["wait"];
    },
    projectionProviders?: ProjectionProviders,
  ) =>
  async (input: RoutingInput) => {
    const { environment, planBytes, plan, planDigest, approval } = readApprovedRouting(input);
    const assertCurrent = async () => {
      environment.signal.throwIfAborted();
      await input.assertCurrent();
      await environment.assertCurrent();
    };
    const readCurrent = async () => {
      await assertCurrent();
      const row = await deps.store.read();
      if (row === undefined) {
        throw mismatch();
      }
      const record = nativeTargetAuthOnlyFinalRoutingRecordSchema.parse(row.record);
      if (
        record.operationRef !== plan.operationRef ||
        record.routingPlanDigest !== planDigest ||
        record.routingPlanBase64 !== planBytes.toString("base64") ||
        !isDeepStrictEqual(record.approval, approval)
      ) {
        throw mismatch();
      }
      if (
        record.projectionAttempt !== undefined &&
        !isDeepStrictEqual(record.projectionAttempt, plan.projection)
      ) {
        throw mismatch();
      }
      if (record.refreshAttempted && record.projectionAttempt === undefined) {
        throw mismatch();
      }
      if (!record.refreshAttempted && record.refreshCandidates.length !== 0) {
        throw mismatch();
      }
      for (const candidate of record.refreshCandidates) {
        validateCandidate(candidate, plan);
      }
      if (record.refreshReceipt !== undefined) {
        validateCandidate(record.refreshReceipt, plan);
        if (
          !record.refreshCandidates.some((candidate) =>
            isDeepStrictEqual(candidate, record.refreshReceipt),
          )
        ) {
          throw mismatch();
        }
      }
      await assertCurrent();
      return { record, revision: row.revision };
    };
    const readParent = async () => {
      await assertCurrent();
      const retained = await deps.readRetainedParent();
      if (retained === undefined) {
        throw mismatch();
      }
      return checkParent(input, plan, retained);
    };
    const refreshPlan = await readParent();
    const assertChange = async (revision: number, record: RoutingRecord) => {
      await assertCurrent();
      if ((await deps.store.compareAndSet(revision, record)) === undefined) {
        throw uncertain();
      }
      await assertCurrent();
    };
    const { target } = environment;
    const aliasHost = new URL(plan.gateway.publicOrigin).hostname;
    const providerFetch = deps.fetch ?? fetch;
    const readAlias = async () => {
      await assertCurrent();
      const credential = await deps.readCredential(environment.authority, target.installationId);
      if (
        credential === undefined ||
        !credential.binding.active ||
        credential.binding.scopeType !== "team" ||
        credential.token.length === 0
      ) {
        throw denied();
      }
      if (
        credential.binding.scopeId !== target.scopeId ||
        credential.binding.installationId !== target.installationId
      ) {
        throw denied();
      }
      const url = new URL(`/v4/aliases/${encodeURIComponent(aliasHost)}`, API);
      url.searchParams.set("teamId", target.scopeId);
      const response = await providerFetch(url, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${credential.token}` },
        redirect: "error",
        signal: AbortSignal.any([environment.signal, AbortSignal.timeout(20_000)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw uncertain();
      }
      const alias = aliasSchema.parse(await response.json());
      const redirected =
        alias.redirect !== undefined && alias.redirect !== null && alias.redirect !== "";
      if (
        alias.alias.toLowerCase() !== aliasHost ||
        alias.projectId !== plan.gateway.projectId ||
        redirected
      ) {
        throw uncertain();
      }
      await assertCurrent();
      return alias.deploymentId;
    };
    const assertProjection = async (intent: RoutingPlan["projection"]) => {
      await readParent();
      await readCurrent();
      if (!isDeepStrictEqual(intent, plan.projection)) {
        throw denied();
      }
    };
    const project = createNativeTargetAuthOnlyGatewayProjection(
      {
        readCredential: deps.readCredential,
        assertCatalogApp: deps.assertCatalogApp,
        ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
        assertAuthorized: assertProjection,
        journal: {
          claim: async (intent) => {
            await assertProjection(intent);
            const current = await readCurrent();
            if (current.record.projectionAttempt !== undefined) {
              return false;
            }
            await assertChange(current.revision, { ...current.record, projectionAttempt: intent });
            return true;
          },
          read: async () => {
            const current = await readCurrent();
            return current.record.projectionAttempt;
          },
        },
      },
      projectionProviders,
    );
    const verifyProjection = async () => {
      const result = await project(input.projection);
      if (
        result.projectionDigest !== plan.projection.nextSha256 ||
        result.appDeploymentId !== plan.app.deploymentId
      ) {
        throw mismatch();
      }
    };
    const checkpoint: NativeTargetAuthOnlyPreviewDeliveryInput["checkpointDelivery"] = async (
      candidates,
    ) => {
      const current = await readCurrent();
      for (const candidate of candidates) {
        validateCandidate(candidate, plan);
      }
      await assertChange(current.revision, {
        ...current.record,
        refreshCandidates: [...candidates],
      });
    };
    const assertBootstrapAlias = async () => {
      if ((await readAlias()) !== plan.bootstrap.deploymentId) {
        throw uncertain();
      }
    };
    const claimCreate = async (init?: RequestInit) => {
      const payload = z.string().safeParse(init?.body);
      if (!payload.success) {
        throw mismatch();
      }
      const body = deploymentBodySchema.parse(JSON.parse(payload.data));
      const expectedSource = {
        ref: plan.gateway.gitRef,
        repoId: plan.gateway.repoId,
        sha: plan.gateway.gitSha,
        type: "github",
      };
      if (
        body.project !== plan.gateway.projectId ||
        !isDeepStrictEqual(body.gitSource, expectedSource)
      ) {
        throw mismatch();
      }
      if (
        body.meta.autograph_operator_operation !== plan.operationRef ||
        body.meta.autograph_operator_plan !== planDigest
      ) {
        throw mismatch();
      }
      await assertBootstrapAlias();
      await verifyProjection();
      const current = await readCurrent();
      if (current.record.refreshAttempted || current.record.refreshCandidates.length !== 0) {
        throw uncertain();
      }
      await assertChange(current.revision, { ...current.record, refreshAttempted: true });
    };
    const assertAliasWrite = async (path: string, init?: RequestInit) => {
      const current = await readCurrent();
      const candidate = current.record.refreshCandidates.find(
        (entry) => path === `/v2/deployments/${encodeURIComponent(entry.deploymentId)}/aliases`,
      );
      const payload = z.string().safeParse(init?.body);
      if (
        candidate?.readyState !== "READY" ||
        candidate.gatewayAliasAttempted !== true ||
        !payload.success
      ) {
        throw uncertain();
      }
      z.strictObject({ alias: z.literal(aliasHost) }).parse(JSON.parse(payload.data));
      await verifyProjection();
      await assertBootstrapAlias();
    };
    const refreshFetch: typeof fetch = async (raw, init) => {
      const url = requestUrl(raw);
      const method = requestMethod(raw, init);
      if (url.origin !== API || url.searchParams.get("teamId") !== target.scopeId) {
        throw mismatch();
      }
      if (method === "GET") {
        return await providerFetch(raw, init);
      }
      if (method !== "POST") {
        throw mismatch();
      }
      await (url.pathname === "/v13/deployments"
        ? claimCreate(init)
        : assertAliasWrite(url.pathname, init));
      await assertCurrent();
      return await providerFetch(raw, init);
    };
    const adapter = createNativeTargetAuthOnlyPreviewDelivery({
      readCredential: deps.readCredential,
      target: "gateway",
      fetch: refreshFetch,
      ...(deps.wait === undefined ? {} : { wait: deps.wait }),
      assertEnvironment: verifyProjection,
      beforeAliasWrite: async (context, candidate) => {
        validateCandidate(candidate, plan);
        const readyCount = context.deliveryCandidates?.filter(
          (entry) => entry.readyState === "READY",
        ).length;
        if (readyCount !== 1) {
          return "unknown";
        }
        const alias = await readAlias();
        if (alias === candidate.deploymentId) {
          return "applied";
        }
        return alias === plan.bootstrap.deploymentId ? "write" : "unknown";
      },
    });
    const [current, alias] = await Promise.all([readCurrent(), readAlias()]);
    if (
      alias !== plan.bootstrap.deploymentId &&
      !current.record.refreshCandidates.some(
        (candidate) => candidate.deploymentId === alias && candidate.readyState === "READY",
      )
    ) {
      throw uncertain();
    }
    await verifyProjection();
    const refreshInput: NativeTargetAuthOnlyPreviewDeliveryInput = {
      approval,
      approvedPlanDigest: planDigest,
      assertCurrent,
      authority: environment.authority,
      checkpointDelivery: checkpoint,
      deliveryCandidates: current.record.refreshCandidates,
      effectId: REFRESH_EFFECT,
      fenceGeneration: input.fenceGeneration,
      operationRef: plan.operationRef,
      plan: refreshPlan,
      signal: environment.signal,
      target,
    };
    const observed = await adapter.reconcile(refreshInput);
    // Prepared replays verify current provider READY metadata and the alias,
    // while retaining the original refresh receipt and never writing an alias.
    if (current.record.refreshReceipt !== undefined) {
      if (
        observed.status !== "applied" ||
        !isDeepStrictEqual(observed.selected, current.record.refreshReceipt) ||
        alias !== current.record.refreshReceipt.deploymentId
      ) {
        throw uncertain();
      }
      await verifyProjection();
      await readParent();
      return {
        app: plan.app,
        gateway: current.record.refreshReceipt,
        projectionDigest: plan.projection.nextSha256,
        status: "prepared" as const,
      };
    }
    const result =
      observed.status === "retryable"
        ? await adapter.deliver({ ...refreshInput, deliveryCandidates: observed.candidates })
        : observed;
    if (result.status !== "applied") {
      throw uncertain();
    }
    const gateway = ready.parse(result.selected);
    validateCandidate(gateway, plan);
    if (result.candidates.filter((entry) => entry.readyState === "READY").length !== 1) {
      throw uncertain();
    }
    await readParent();
    await verifyProjection();
    if ((await readAlias()) !== gateway.deploymentId) {
      throw uncertain();
    }
    const final = await readCurrent();
    if (
      final.record.refreshReceipt !== undefined &&
      !isDeepStrictEqual(final.record.refreshReceipt, gateway)
    ) {
      throw uncertain();
    }
    if (final.record.refreshReceipt === undefined) {
      await assertChange(final.revision, { ...final.record, refreshReceipt: gateway });
    }
    return {
      app: plan.app,
      gateway,
      projectionDigest: plan.projection.nextSha256,
      status: "prepared" as const,
    };
  };
