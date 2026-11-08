/* oxlint-disable eslint/require-await -- Controlled authority ports retain the same async interface as the real owner/approval readers. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { openHostedPostgresDatabase } from "../../../../../lib/mcp/hosted-route";
import type { VercelTokenKeyringConfig } from "../../../../../lib/integrations/vercel-installation";
import { createOwnedAppResourceCustody } from "../../../../../lib/provisioning/owned-app-resource-custody";
import { createPostgresHostedRuntimeJournalStore } from "../../../../../lib/provisioning/postgres-hosted-runtime-journal";
import {
  prepareHostedOperatorResourceCredentials,
  readHostedOperatorResourceBindings,
} from "../../../../../lib/provisioning/hosted-operator-resource-credentials";
import {
  hostedOperatorPlanSchema,
  operatorPlanDigest,
} from "../../../../../lib/provisioning/hosted-operator-contract";
import type {
  HostedOperatorPlan,
  RetainedOperatorAuth,
} from "../../../../../lib/provisioning/hosted-operator-contract";
import type { HostedOperatorContext } from "../../../../../lib/provisioning/hosted-operator-service";
import type { HostedOperatorSourceConfiguration } from "../../../../../lib/provisioning/hosted-operator-source-configuration";

/** Actual SQL journal and encryption; controlled approvals are not hosted consent evidence. */
export const proveOwnedAppResourceCustody = async (input: {
  database: ReturnType<typeof openHostedPostgresDatabase>;
  keyring: VercelTokenKeyringConfig;
  context: HostedOperatorContext;
  setup: RetainedOperatorAuth;
}) => {
  const source = input.context;
  const sourceOwner = source.ownerContext;
  assert.ok(sourceOwner);
  const plan = hostedOperatorPlanSchema.parse({
    ...input.setup.plan,
    runtimePreparation: "single-project-resources-v1",
  });
  const sourceDigest = operatorPlanDigest(plan);
  const sourceApprovalId = "local-source-approval";
  const sourceCall = "local-source-call";
  const journal = createPostgresHostedRuntimeJournalStore(input.database);
  const sourceRow = await journal.reserve({
    ...source,
    approvedByCallId: sourceCall,
    now: new Date(),
    operator: {
      mode: "protected-operator-v1",
      approvalId: sourceApprovalId,
      operationRef: randomUUID(),
      plan,
      planDigest: sourceDigest,
      receipts: input.setup.receipts,
      authPreparation: input.setup.authPreparation,
      fenceGeneration: input.setup.fenceGeneration,
    },
  });
  const prepared = prepareHostedOperatorResourceCredentials({
    ...source,
    plan,
    config: input.keyring,
    record: sourceRow.record,
    database: "authDatabase",
  });
  const sourceSaved = await journal.compareAndSet({
    ...source,
    expectedRevision: sourceRow.revision,
    now: new Date(),
    record: { ...sourceRow.record, environmentBound: false, privateState: prepared.privateState },
  });
  assert.ok(sourceSaved);
  const sourceValues = readHostedOperatorResourceBindings({
    ...source,
    plan,
    record: sourceSaved.record,
    config: input.keyring,
  });
  const revision: HostedOperatorContext = {
    ...source,
    ownerContext: {
      ...sourceOwner,
      adapterSessionId: "local-revision-adapter",
      sessionId: "local-revision-session",
    },
    target: {
      ...source.target,
      sessionId: "local-revision-session",
      branch: "builder/local-revision",
    },
  };
  const revisionBase: HostedOperatorPlan = hostedOperatorPlanSchema.parse({
    ...plan,
    selection: {
      ...plan.selection,
      sessionId: revision.target.sessionId,
      branch: revision.target.branch,
    },
    publicGateway: { ...plan.publicGateway, branch: revision.target.branch },
    deploymentBoundary:
      plan.deploymentBoundary === undefined
        ? undefined
        : {
            ...plan.deploymentBoundary,
            app: { ...plan.deploymentBoundary.app, branch: revision.target.branch },
            gateway: { ...plan.deploymentBoundary.gateway, branch: revision.target.branch },
          },
  });
  let originalApproved = true;
  let currentApproved = true;
  let currentDigest = "";
  const currentCall = "local-revision-call";
  const currentApprovalId = "local-revision-approval";
  const configuration: Pick<HostedOperatorSourceConfiguration, "standardRuntime"> = {
    standardRuntime: {
      profileId: "local-dedicated-profile",
      provisioningRequestId: randomUUID(),
      provisioningDigest: "a".repeat(64),
      productionDatabaseIdentity: "ep-production.neon.tech/auth",
      appSpecDigest: plan.contextId,
      capturedReleaseId: plan.release.id,
      authOwnership: { kind: "dedicated-app-development", resource: plan.authDatabase },
      publicRealmWorkload: {
        issuer: "https://oidc.vercel.com/team",
        audience: "https://vercel.com/team",
        projectId: source.target.projectId,
        ownerId: source.target.scopeId,
        environment: "production",
        subject: "local-exact-production-subject",
      },
    },
  };
  const create = () =>
    createOwnedAppResourceCustody({
      database: input.database,
      keyring: input.keyring,
      configuration,
      store: journal,
      assertCurrentOwner: async (context) => {
        if (
          !isDeepStrictEqual(context.authority, source.authority) ||
          context.target.projectId !== source.target.projectId ||
          context.ownerContext?.sessionId !== context.target.sessionId
        ) {
          throw new Error("local_owner_denied");
        }
      },
      sourceContext: async (_current, target) => {
        if (!isDeepStrictEqual(target, source.target)) {
          throw new Error("local_source_denied");
        }
        return source;
      },
      readApproval: async (context) => {
        if (
          context.planDigest === sourceDigest &&
          context.callId === sourceCall &&
          isDeepStrictEqual(context.target, source.target)
        ) {
          return {
            action: "prepare",
            approvalId: sourceApprovalId,
            approved: originalApproved,
            callId: sourceCall,
            planDigest: sourceDigest,
          };
        }
        if (
          context.planDigest === currentDigest &&
          context.callId === currentCall &&
          isDeepStrictEqual(context.target, revision.target)
        ) {
          return {
            action: "prepare",
            approvalId: currentApprovalId,
            approved: currentApproved,
            callId: currentCall,
            planDigest: currentDigest,
          };
        }
        return null;
      },
      isExistingRevision: async (context) => context.target.sessionId === revision.target.sessionId,
    });
  const custody = create();
  await custody.checkpoint(source, plan, input.setup.authPreparation);
  const reference = await custody.readReference(revision, revisionBase);
  assert.ok(reference);
  assert.equal(reference.source.target.sessionId, source.target.sessionId);
  const revisionPlan = hostedOperatorPlanSchema.parse({
    ...revisionBase,
    existingResources: reference,
  });
  currentDigest = operatorPlanDigest(revisionPlan);
  const revisionRow = await journal.reserve({
    ...revision,
    now: new Date(),
    approvedByCallId: currentCall,
    operator: {
      mode: "protected-operator-v1",
      operationRef: randomUUID(),
      approvalId: currentApprovalId,
      plan: revisionPlan,
      planDigest: currentDigest,
      receipts: [],
    },
  });
  currentApproved = false;
  await assert.rejects(custody.rewrap(revision, revisionPlan, revisionRow.record), {
    code: "authorization_required",
  });
  currentApproved = true;
  originalApproved = false;
  await assert.rejects(custody.readReference(revision, revisionPlan), {
    code: "authorization_required",
  });
  await assert.rejects(custody.rewrap(revision, revisionPlan, revisionRow.record), {
    code: "authorization_required",
  });
  originalApproved = true;
  await assert.rejects(
    custody.readReference(
      { ...revision, authority: { ...revision.authority, ownerUserId: "foreign" } },
      revisionPlan,
    ),
  );
  const privateState = await custody.rewrap(revision, revisionPlan, revisionRow.record);
  assert.equal(isDeepStrictEqual(privateState, sourceSaved.record.privateState), false);
  const revised = await journal.compareAndSet({
    ...revision,
    expectedRevision: revisionRow.revision,
    now: new Date(),
    record: { ...revisionRow.record, privateState },
  });
  assert.ok(revised);
  const revisedValues = readHostedOperatorResourceBindings({
    ...revision,
    plan: revisionPlan,
    record: revised.record,
    config: input.keyring,
  });
  assert.equal(isDeepStrictEqual(revisedValues, sourceValues), true);
  // An encrypted checkpoint for the new ordinary approval cannot be opened as the source operation.
  assert.throws(() =>
    readHostedOperatorResourceBindings({
      ...source,
      plan,
      record: { ...sourceSaved.record, privateState },
      config: input.keyring,
    }),
  );
  assert.equal(
    isDeepStrictEqual(await create().readReference(revision, revisionPlan), reference),
    true,
  );
  const unchanged = await journal.read(source);
  assert.equal(
    isDeepStrictEqual(unchanged?.record.privateState, sourceSaved.record.privateState),
    true,
  );
  // Passwords stay inside private decrypted memory; persisted rows hold ciphertext and provenance only.
  const persisted = JSON.stringify([sourceSaved.record, revised.record]);
  for (const resource of [sourceValues.appDatabase, sourceValues.authDatabase]) {
    assert.equal(persisted.includes(new URL(resource.runtimeUrl).password), false);
    assert.equal(persisted.includes(new URL(resource.migrationUrl).password), false);
  }
};
