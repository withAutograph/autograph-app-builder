import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
// Spying on the module factory requires its namespace object.
// oxlint-disable-next-line sonarjs/no-wildcard-import
import * as historyModule from "./postgres-hosted-checkpoint-history";
import { createPostgresHostedEveStore } from "./postgres-hosted-store";
import { hostedEveOperationScopes } from "./hosted-auth";
import { toDurableHostedSessionRecord } from "./hosted-store";
import {
  nativeTargetOnboardingPlanDigest,
  nativeTargetOnboardingPlanSchema,
  nativeTargetRequiredProjectProtection,
} from "../provisioning/native-target-onboarding-contract";

const principal = {
  audience: "builder",
  issuer: "https://identity.example.test",
  ownerUserId: "owner",
  workspaceId: "workspace",
  scopes: Object.values(hostedEveOperationScopes),
};
const sessionId = "session_fixture";
const plan = nativeTargetOnboardingPlanSchema.parse({
  version: 1,
  appId: "requests-app",
  origin: {
    publicSessionId: sessionId,
    adapterSessionId: "adapter_1",
    adapterGeneration: 1,
    appSpecDigest: "a".repeat(64),
    release: {
      id: "release",
      artifactRef: "artifact",
      manifestSha256: "b".repeat(64),
      schemaSha256: "c".repeat(64),
    },
  },
  project: {
    name: "requests-app",
    teamId: "team",
    installationId: "installation",
    projectSettings: {
      framework: "nextjs",
      rootDirectory: "apps/requests",
      sourceFilesOutsideRootDirectory: true,
    },
    protection: nativeTargetRequiredProjectProtection,
  },
  branch: "preview",
  appDatabase: {
    resourceId: "resource",
    database: "requests_data",
    migratorRole: "requests_owner",
    runtimeRole: "requests_runtime",
  },
  productRoles: [],
  nativeNeon: {
    approvalReference: "scope",
    nativeStore: { configurationId: "config", resourceId: "store", sourceProjectId: "source" },
    scope: {
      projectId: "project",
      branchId: "branch",
      endpointId: "endpoint",
      hostname: "ep-fixture.neon.tech",
      maintenanceDatabase: "maintenance",
      maintenanceRole: "installer",
    },
  },
  worker: {
    id: "worker",
    executablePath: "/trusted/worker",
    sha256: "d".repeat(64),
    operationScope: "generated-app-release-install-v1",
    subcommand: "protected-generated-app-install",
  },
  cost: { ownership: "current-owner", description: "Preview usage" },
  retention: { policy: "Until approved cleanup" },
  conflictPolicy: "stop-on-conflict",
});
const receipt = {
  callId: "call",
  requestId: "request",
  format: "autograph-hosted-approval-v1" as const,
  outcome: "approved" as const,
  responderPrincipalId: principal.ownerUserId,
  sequence: 1,
  turnId: "",
  toolName: "prepare-app-native-target" as const,
  toolInput: {
    appId: plan.appId,
    operationRef: "a3f06690-718f-41c7-a67f-c6c1c0ecdbf3",
    plan,
    planDigest: nativeTargetOnboardingPlanDigest(plan),
  },
};
const oldDigest = `sha256:${"a".repeat(64)}`;
const oldRef = { id: "123e4567-e89b-42d3-a456-426614174001", digest: oldDigest, eventCount: 0 };
const session = {
  ...toDurableHostedSessionRecord({
    version: 1,
    principal,
    sessionId,
    adapterSessionId: "adapter_1",
    status: "waiting",
    createdAtEpochMs: 1000,
    updatedAtEpochMs: 1000,
  }),
  checkpointDigest: oldDigest,
  checkpointProgressDigest: oldDigest,
  checkpointRef: oldRef,
};
const row = {
  issuer: principal.issuer,
  audience: principal.audience,
  workspaceId: principal.workspaceId,
  ownerUserId: principal.ownerUserId,
  sessionId,
  adapterSessionId: session.adapterSessionId,
  adapterGeneration: session.adapterGeneration,
  checkpointDigest: oldDigest,
  checkpointId: oldRef.id,
  checkpointProgressDigest: oldDigest,
  record: session,
  createdAt: new Date(1000),
  updatedAt: new Date(1000),
  lastProgressAt: new Date(session.lastProgressAtEpochMs),
  resumabilityState: session.resumability,
  stage: session.stage,
  title: session.title,
  parentSessionId: null,
};
const replayBinding = {
  adapterSessionId: "adapter_1",
  adapterGeneration: 1,
  cancellationRevision: 0,
};
const metadata = {
  capturedAtEpochMs: 2000,
  status: "waiting" as const,
  version: 1 as const,
  privateApprovalCaptureState: {
    pendingRequests: [],
    receipts: [receipt],
    sessionId,
    version: 1 as const,
  },
};

const fixture = () => {
  let current = { ...row };
  const update = vi.fn();
  const rows = () => Promise.resolve([current]);
  const limit = () => ({ for: rows });
  const selectWhere = () => ({ limit });
  const selectFrom = () => ({ where: selectWhere });
  const returning = (values: typeof row) => () => {
    update(values);
    current = { ...current, ...values };
    return Promise.resolve([current]);
  };
  const transaction = {
    select: () => ({ from: selectFrom }),
    update: () => ({
      set: (values: typeof row) => ({
        where: () => ({
          returning: returning(values),
        }),
      }),
    }),
  };
  const database = {
    // The transaction API receives a callback and returns its result unchanged.
    // oxlint-disable-next-line promise/prefer-await-to-callbacks, anti-slop/no-unknown-returns
    transaction: async <T>(callback: (tx: typeof transaction) => Promise<T>): Promise<T> =>
      // oxlint-disable-next-line promise/prefer-await-to-callbacks
      await callback(transaction),
  };
  // SAFETY: This test double supplies the exact transaction methods exercised by this test.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion
  const db = database as unknown as Parameters<typeof createPostgresHostedEveStore>[0];
  const history = historyModule.createPostgresHostedCheckpointHistory(db);
  const staged = {
    checkpointDigest: `sha256:${"b".repeat(64)}`,
    checkpointId: randomUUID(),
    checkpointProgressDigest: `sha256:${"c".repeat(64)}`,
    eventCount: 0,
    itemCount: 1,
  };
  const stage = vi.fn<typeof history.stage>().mockResolvedValue(staged);
  const discardStage = vi.fn<typeof history.discardStage>().mockResolvedValue(true);
  const publish = vi.fn<typeof history.publishInTransaction>().mockResolvedValue({
    ...principal,
    sessionId,
    checkpointId: staged.checkpointId,
    checkpointDigest: staged.checkpointDigest,
    eventCount: staged.eventCount,
    itemCount: staged.itemCount,
    createdAt: new Date(2000),
    updatedAt: new Date(2000),
    publishedAt: new Date(2000),
  });
  const spy = vi
    .spyOn(historyModule, "createPostgresHostedCheckpointHistory")
    .mockReturnValue({ ...history, stage, discardStage, publishInTransaction: publish });
  const store = createPostgresHostedEveStore(db);
  const observe = store.observeSessionPaged;
  if (observe === undefined) {
    throw new Error("Paged observation unavailable");
  }
  const submit = (override: Partial<Parameters<typeof observe>[0]> = {}) =>
    observe({
      principal,
      sessionId,
      expectedCheckpointDigest: oldDigest,
      replayBinding,
      verifiedReplayReceipts: [receipt],
      metadata,
      events: (async function* events() {})(),
      stage: session.stage,
      resumability: session.resumability,
      nowEpochMs: 2000,
      ...override,
    });
  return { submit, publish, update, discardStage, spy, transaction };
};

describe("atomic verified replay publication", () => {
  it("publishes the checkpoint and merged receipt in the same locked transaction", async () => {
    const f = fixture();
    try {
      const observed = await f.submit();
      expect(observed.version).toBe(2);
      if (observed.version === 2) {
        expect(observed.privateApprovalReceipts).toEqual([receipt]);
      }
      expect(f.publish).toHaveBeenCalledOnce();
      expect(f.publish.mock.calls[0]?.[0]).toBe(f.transaction);
      expect(f.update).toHaveBeenCalledOnce();
    } finally {
      f.spy.mockRestore();
    }
  });
  it.each([
    ["digest", { expectedCheckpointDigest: `sha256:${"f".repeat(64)}` }],
    ["adapter", { replayBinding: { ...replayBinding, adapterSessionId: "other" } }],
    ["generation", { replayBinding: { ...replayBinding, adapterGeneration: 2 } }],
    ["cancellation", { replayBinding: { ...replayBinding, cancellationRevision: 1 } }],
    ["missing binding", { replayBinding: undefined }],
    [
      "receipt absent from capture",
      {
        metadata: {
          ...metadata,
          privateApprovalCaptureState: { ...metadata.privateApprovalCaptureState, receipts: [] },
        },
      },
    ],
  ])("rejects %s before publication", async (_name, override) => {
    const f = fixture();
    try {
      await expect(f.submit(override)).rejects.toThrow();
      expect(f.publish).not.toHaveBeenCalled();
      expect(f.update).not.toHaveBeenCalled();
      expect(f.discardStage).toHaveBeenCalledOnce();
    } finally {
      f.spy.mockRestore();
    }
  });
});
