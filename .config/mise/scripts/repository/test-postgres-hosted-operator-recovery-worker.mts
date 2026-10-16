/* oxlint-disable eslint/no-await-in-loop, unicorn/no-await-expression-member, promise/avoid-new -- Child workers simulate durable process loss at explicit journal boundaries. */
import assert from "node:assert/strict";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
// Drizzle expects the complete exported schema collection.
// oxlint-disable-next-line sonarjs/no-wildcard-import -- This is the Drizzle schema registration object.
import * as schema from "../../../../lib/db/schema";
import { createPostgresHostedRuntimeJournalStore } from "../../../../lib/provisioning/postgres-hosted-runtime-journal";
import { createPostgresHostedOperatorResourceLease } from "../../../../lib/provisioning/postgres-hosted-operator-resource-lease";
import { createProtectedHostedOperatorHandler } from "../../../../lib/provisioning/hosted-operator-service";
import type { ProtectedHostedOperatorDependencies } from "../../../../lib/provisioning/hosted-operator-service";
import {
  HostedOperatorError,
  hostedOperatorPlanSchema,
  operatorReceiptSchema,
  operatorSelectionSchema,
} from "../../../../lib/provisioning/hosted-operator-contract";
import { z } from "zod";

const fixtureConfigSchema = z.strictObject({
  action: z.enum(["plan", "execute"]),
  operation: z.enum(["prepare", "cleanup"]).optional(),
  authority: z.strictObject({
    audience: z.url(),
    issuer: z.url(),
    ownerUserId: z.uuid(),
    workspaceId: z.uuid(),
  }),
  failure: z.string().optional(),
  operationRef: z.uuid().optional(),
  plan: z.unknown(),
  planDigest: z.string().optional(),
  selection: operatorSelectionSchema,
  target: z.strictObject({
    ...operatorSelectionSchema.shape,
    installationId: z.string().min(1),
    scopeId: z.string().min(1),
    scopeType: z.enum(["team", "user"]),
  }),
  dsn: z.url(),
});

const resourceIdentitySchema = z.strictObject({
  appResourceId: z.string(),
  authResourceId: z.string(),
  branchId: z.string(),
  endpoint: z.string(),
  projectId: z.string(),
});

const configText = process.env.A515_FIXTURE_CONFIG;
if (configText === undefined || configText.length === 0) {
  throw new Error("Missing private fixture config");
}
const config = fixtureConfigSchema.parse(JSON.parse(configText));
const plan = hostedOperatorPlanSchema.parse(config.plan);
const sql = postgres(config.dsn, { max: 4 });
const database = drizzle(sql, { schema });
const journal = createPostgresHostedRuntimeJournalStore(database);
type JournalCasInput = Parameters<typeof journal.compareAndSet>[0];
const failIfScenario = (
  condition: boolean,
  currentFailure: string | undefined,
  expectedFailure: string,
  message: string,
) => {
  if (condition && currentFailure === expectedFailure) {
    throw new Error(message);
  }
};
const exitIfScenario = (
  condition: boolean,
  currentFailure: string | undefined,
  expectedFailure: string,
  exitCode: number,
) => {
  if (condition && currentFailure === expectedFailure) {
    process.exit(exitCode);
  }
};
// Each condition is a distinct journal durability boundary in the acceptance matrix.
// oxlint-disable eslint(complexity) -- These two fixture adapters map finite protected CAS fault points.
const failBeforeJournalWrite = (
  input: JournalCasInput,
  fresh: Awaited<ReturnType<typeof journal.read>>,
) => {
  const { operator } = input.record;
  const previousOperator = fresh?.record.operator;
  const priorReceiptIds = new Set(previousOperator?.receipts.map((receipt) => receipt.effectId));
  const addedReceipt = operator?.receipts.find((receipt) => !priorReceiptIds.has(receipt.effectId));
  failIfScenario(
    addedReceipt !== undefined,
    config.failure,
    `receipt-before:${addedReceipt?.effectId ?? ""}`,
    "fixture lost receipt checkpoint before write",
  );
  const committingProof = input.record.status === "prepared" && input.record.proof !== undefined;
  failIfScenario(
    committingProof,
    config.failure,
    "proof-before",
    "fixture lost proof checkpoint before write",
  );
  const settingPendingEffect =
    operator?.pendingEffectId !== undefined &&
    previousOperator?.pendingEffectId !== operator.pendingEffectId;
  failIfScenario(
    settingPendingEffect,
    config.failure,
    `pending-before:${operator?.pendingEffectId ?? ""}`,
    "fixture failed before pending-effect CAS",
  );
  const pendingAttempt = operator?.pendingEffectAttempt;
  const previousAttempt = previousOperator?.pendingEffectAttempt;
  const bindingContext =
    pendingAttempt?.contextDigest !== undefined &&
    pendingAttempt.contextDigest !== previousAttempt?.contextDigest;
  failIfScenario(
    bindingContext,
    config.failure,
    `context-before:${operator?.pendingEffectId ?? ""}`,
    "fixture failed before worker-context binding CAS",
  );
  const previousFrames = previousOperator?.workerCheckpoints ?? [];
  const nextFrames = operator?.workerCheckpoints ?? [];
  const addedWorkerCheckpoint = nextFrames.length > previousFrames.length;
  failIfScenario(
    addedWorkerCheckpoint,
    config.failure,
    `worker-checkpoint-before:${operator?.pendingEffectId ?? ""}`,
    "fixture failed before worker-frame checkpoint CAS",
  );
  const claimingLease = fresh?.record.leaseId === undefined && input.record.leaseId !== undefined;
  failIfScenario(
    claimingLease,
    config.failure,
    "lease-claim-before",
    "fixture failed before lease-claim CAS",
  );
  const releasingLease =
    fresh?.record.leaseId !== undefined &&
    input.record.leaseId === undefined &&
    input.record.status === "prepared";
  failIfScenario(
    releasingLease,
    config.failure,
    "release-before",
    "fixture failed before lease-release CAS",
  );
};
// Each condition represents the response-loss side of a durable CAS boundary.
const processLossAfterJournalWrite = (
  input: JournalCasInput,
  fresh: Awaited<ReturnType<typeof journal.read>>,
) => {
  const { operator } = input.record;
  const previousOperator = fresh?.record.operator;
  const priorReceiptIds = new Set(previousOperator?.receipts.map((receipt) => receipt.effectId));
  const addedReceipt = operator?.receipts.find((receipt) => !priorReceiptIds.has(receipt.effectId));
  failIfScenario(
    addedReceipt !== undefined,
    config.failure,
    `receipt-after:${addedReceipt?.effectId ?? ""}`,
    "fixture lost receipt checkpoint after write",
  );
  const settingPendingEffect =
    operator?.pendingEffectId !== undefined &&
    previousOperator?.pendingEffectId !== operator.pendingEffectId;
  exitIfScenario(
    settingPendingEffect,
    config.failure,
    `pending-after:${operator?.pendingEffectId ?? ""}`,
    92,
  );
  const pendingAttempt = operator?.pendingEffectAttempt;
  const previousAttempt = previousOperator?.pendingEffectAttempt;
  const bindingContext =
    pendingAttempt?.contextDigest !== undefined &&
    pendingAttempt.contextDigest !== previousAttempt?.contextDigest;
  exitIfScenario(
    bindingContext,
    config.failure,
    `context-after:${operator?.pendingEffectId ?? ""}`,
    93,
  );
  const previousFrames = previousOperator?.workerCheckpoints ?? [];
  const nextFrames = operator?.workerCheckpoints ?? [];
  const addedWorkerCheckpoint = nextFrames.length > previousFrames.length;
  exitIfScenario(
    addedWorkerCheckpoint,
    config.failure,
    `worker-checkpoint-after:${operator?.pendingEffectId ?? ""}`,
    94,
  );
  const claimingLease = fresh?.record.leaseId === undefined && input.record.leaseId !== undefined;
  exitIfScenario(claimingLease, config.failure, "lease-claim-after", 89);
  const releasingLease =
    fresh?.record.leaseId !== undefined &&
    input.record.leaseId === undefined &&
    input.record.status === "prepared";
  exitIfScenario(releasingLease, config.failure, "release-after", 91);
  const committingProof = input.record.status === "prepared" && input.record.proof !== undefined;
  exitIfScenario(committingProof, config.failure, "proof-after", 88);
};
// oxlint-enable eslint(complexity)
const store = {
  ...journal,
  async compareAndSet(input: Parameters<typeof journal.compareAndSet>[0]) {
    const fresh = await journal.read(input);
    failBeforeJournalWrite(input, fresh);
    const result = await journal.compareAndSet(input);
    processLossAfterJournalWrite(input, fresh);
    return result;
  },
  async reserveFenceGeneration(input: Parameters<typeof journal.reserveFenceGeneration>[0]) {
    if (config.failure === "fence-before") {
      throw new Error("fixture failed before fence-generation CAS");
    }
    const result = await journal.reserveFenceGeneration(input);
    if (config.failure === "fence-after") {
      process.exit(90);
    }
    return result;
  },
};
const openLockClient = (onConnectionClosed: () => void) =>
  postgres(config.dsn, { max: 1, onclose: onConnectionClosed });
const withResourceLease = createPostgresHostedOperatorResourceLease({
  openLockClient,
  store: journal,
});
const receiptIdentity = (input: { plan: typeof plan }) => ({
  appResourceId: input.plan.appDatabase.resourceId,
  authResourceId: input.plan.authDatabase.resourceId,
  branchId: input.plan.neon.branchId,
  endpoint: input.plan.neon.endpoint,
  projectId: input.plan.neon.projectId,
});
const dependencies: ProtectedHostedOperatorDependencies = {
  store,
  authorize(request, selection) {
    if (
      request.headers.get("authorization") !== "Bearer local-fixture" ||
      selection.sessionId !== config.selection.sessionId
    ) {
      throw new HostedOperatorError("authorization_required");
    }
    return Promise.resolve({ authority: config.authority, target: config.target });
  },
  assertAuthorized() {
    return Promise.resolve();
  },
  plan() {
    return Promise.resolve(plan);
  },
  readApproval(input) {
    return Promise.resolve({
      action: input.action,
      approvalId: "owner-approved-local-fixture",
      approved: true,
      callId: input.callId,
      planDigest: input.planDigest,
    });
  },
  withResourceLease,
  async reconcile(input) {
    if (config.failure === "unknown") {
      return { status: "unknown" };
    }
    const [row] = await sql<
      { receipt: unknown; resource_identity: unknown }[]
    >`select receipt, resource_identity from a515_synthetic_effects where operation_ref=${input.operationRef} and effect_id=${input.effect.id} limit 1`;
    if (row === undefined) {
      return { status: "absent" };
    }
    const observedIdentity = resourceIdentitySchema.parse(row.resource_identity);
    const expectedIdentity = receiptIdentity(input);
    assert.deepEqual(
      observedIdentity,
      expectedIdentity,
      "Frozen provider resource IDs changed during recovery",
    );
    return { status: "applied", receipt: operatorReceiptSchema.parse(row.receipt) };
  },
  async executeEffect(input) {
    await input.assertCurrent();
    if (config.failure === `checkpoint-before:${input.effect.id}`) {
      throw new Error("fixture failed before private checkpoint");
    }
    await input.checkpoint({
      encryptedToken: "fixture-ciphertext",
      keyVersion: "fixture-key",
      tokenIv: "fixture-iv",
      tokenTag: "fixture-tag",
    });
    if (config.failure === `checkpoint-after:${input.effect.id}`) {
      throw new Error("fixture failed after private checkpoint");
    }
    if (config.failure === `effect-before:${input.effect.id}`) {
      throw new Error("fixture failed before provider effect");
    }
    const recordWorkerCheckpoint = await input.bindWorkerContext({ contextDigest: "f".repeat(64) });
    const identity = receiptIdentity(input);
    const receipt = {
      effectId: input.effect.id,
      fenceGeneration: input.fenceGeneration,
      observedAt: new Date().toISOString(),
      resourceVersion: `synthetic:${input.effect.id}`,
    };
    await sql`insert into a515_synthetic_effects (operation_ref,effect_id,resource_identity,receipt,attempts) values (${input.operationRef},${input.effect.id},${JSON.stringify(identity)}::jsonb,${JSON.stringify(receipt)}::jsonb,1) on conflict(operation_ref,effect_id) do update set attempts=a515_synthetic_effects.attempts+1`;
    if (config.failure === `effect-crash:${input.effect.id}`) {
      process.exit(86);
    }
    if (config.failure === `effect-after:${input.effect.id}`) {
      throw new DOMException("fixture lost provider response after durable effect", "TimeoutError");
    }
    await recordWorkerCheckpoint({
      contextDigest: "f".repeat(64),
      effectId: input.effect.id,
      fenceGeneration: input.fenceGeneration,
      operationId: input.operationRef,
      receipt: { state: "applied", readbackSha256: "e".repeat(64) },
      resourceId: input.plan.appDatabase.resourceId,
      sequence: 1,
      tenantId: "synthetic-org",
    });
    return receipt;
  },
  verify() {
    if (config.failure === "verify-before") {
      throw new Error("fixture failed before proof read");
    }
    const proof = {
      actors: 1,
      artifactHash: "c".repeat(64),
      authenticatedBehavior: "unassessed" as const,
      manifestSha256: plan.release.sha256,
      releaseId: plan.release.id,
      tenants: 1,
    };
    if (config.failure === "verify-after") {
      process.exit(87);
    }
    return Promise.resolve(proof);
  },
  bindings() {
    return Promise.resolve({
      PLATFORM_ORIGIN: "https://gateway.fixture.test",
      PLATFORM_PUBLIC_ORIGIN: "https://app.fixture.test",
      PLATFORM_JWKS_URL: "https://gateway.fixture.test/_platform/jwks.json",
      PLATFORM_APP_BOUNDARY: "{}",
      SPEND_REVIEW_DATABASE_URL: "postgres://synthetic-only",
    });
  },
};
const handler = createProtectedHostedOperatorHandler(dependencies);
const ownerContext = {
  adapterGeneration: 1,
  adapterSessionId: "fixture-adapter",
  authority: config.authority,
  kind: "direct" as const,
  principal: { ...config.authority, scopes: ["autograph:send"] },
  sessionId: config.selection.sessionId,
};
const body =
  config.action === "plan"
    ? {
        action: "plan",
        operation: config.operation ?? "prepare",
        selection: config.selection,
        ownerContext,
      }
    : {
        action: "execute",
        callId: "fixture-owner-approval",
        operationRef: config.operationRef,
        planDigest: config.planDigest,
        selection: config.selection,
        ownerContext,
      };
try {
  const response = await handler(
    new Request("https://operator.fixture.test/v1/runtime", {
      method: "POST",
      headers: {
        authorization: "Bearer local-fixture",
        "content-type": "application/json",
        "x-vercel-trusted-oidc-idp-token": "local-fixture",
      },
      body: JSON.stringify(body),
    }),
  );
  console.log(`A515_RESULT ${JSON.stringify(await response.json())}`);
} finally {
  try {
    await sql.end({ timeout: 2 });
  } catch (error) {
    process.stderr.write(`Fixture worker SQL shutdown failed: ${String(error)}\n`);
  }
}
