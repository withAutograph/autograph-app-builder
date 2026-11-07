// oxlint-disable eslint/require-await, typescript/promise-function-async -- Terminal async doubles return settled Promises.
import { createHash } from "node:crypto";
import { PgDialect, PgTransaction } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { z } from "zod";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import { createPostgresHostedEveStore } from "./postgres-hosted-store";
import { describe, expect, it, vi } from "vitest";
import { hostedEveOperationScopes } from "./hosted-auth";
import { digest, stableId } from "./hosted-operation-identifiers";
import { privateHostedApprovalReceiptSchema } from "./private-hosted-approval";
import {
  hostedOperatorPlanSchema,
  operatorPlanDigest,
} from "../provisioning/hosted-operator-contract";
import {
  captureResourceApprovalResponse,
  provesResourceApprovalResponse,
  resourceApprovalResponseProofSchema,
} from "./resource-approval-response";
import {
  nativeTargetOnboardingPlanDigest,
  nativeTargetOnboardingPlanSchema,
  nativeTargetRequiredProjectProtection,
} from "../provisioning/native-target-onboarding-contract";
import {
  isProvedResourceApprovalResponse,
  hostedOperationRecordSchema,
  durableHostedSessionRecordSchema,
  InMemoryHostedEveStore,
  withoutHostedOperationError,
} from "./hosted-store";
import type { HostedCheckpointPage, HostedPagedCheckpointMetadata } from "./hosted-store";
import { createHostedEveSessionService } from "./hosted-service";
import { HostedSessionReadTimeoutError } from "./hosted-session-read-timeout-error";
import type { PrivateInputState } from "./session-limit-input";

const principal = {
  audience: "autograph-app-builder",
  issuer: "https://identity.example.test",
  ownerUserId: "owner_1",
  scopes: Object.values(hostedEveOperationScopes),
  workspaceId: "workspace_1",
};
const nativePlan = nativeTargetOnboardingPlanSchema.parse({
  appDatabase: {
    database: "requests_data",
    migratorRole: "requests_owner",
    resourceId: "resource",
    runtimeRole: "requests_runtime",
  },
  appId: "requests-app",
  branch: "preview",
  conflictPolicy: "stop-on-conflict",
  cost: { description: "Preview usage", ownership: "current-owner" },
  nativeNeon: {
    approvalReference: "scope",
    nativeStore: { configurationId: "config", resourceId: "store", sourceProjectId: "source" },
    scope: {
      branchId: "branch",
      endpointId: "endpoint",
      hostname: "ep-fixture.neon.tech",
      maintenanceDatabase: "maintenance",
      maintenanceRole: "installer",
      projectId: "project",
    },
  },
  origin: {
    adapterGeneration: 1,
    adapterSessionId: "adapter_1",
    appSpecDigest: "a".repeat(64),
    publicSessionId: "session_fixture",
    release: {
      artifactRef: "artifact",
      id: "release",
      manifestSha256: "b".repeat(64),
      schemaSha256: "c".repeat(64),
    },
  },
  productRoles: [],
  project: {
    installationId: "installation",
    name: "requests-app",
    projectSettings: {
      framework: "nextjs",
      rootDirectory: "apps/requests",
      sourceFilesOutsideRootDirectory: true,
    },
    protection: nativeTargetRequiredProjectProtection,
    teamId: "team",
  },
  retention: { policy: "Until approved cleanup" },
  version: 1,
  worker: {
    executablePath: "/trusted/worker",
    id: "worker",
    operationScope: "generated-app-release-install-v1",
    sha256: "d".repeat(64),
    subcommand: "protected-generated-app-install",
  },
});

describe("native target response reconciliation", () => {
  it("requires every exact request in a batch to have an owner settlement", () => {
    const input = {
      appId: nativePlan.appId,
      operationRef: "a3f06690-718f-41c7-a67f-c6c1c0ecdbf3",
      plan: nativePlan,
      planDigest: nativeTargetOnboardingPlanDigest(nativePlan),
    };
    const approvals = ["one", "two"].map((id) => ({
      callId: `call-${id}`,
      requestId: id,
      toolInput: input,
      toolName: "prepare-app-native-target" as const,
    }));
    const nativeBatch = {
      requests: approvals.map(({ requestId, toolName }) => ({
        kind: "tool-approval" as const,
        optionIds: ["approve", "deny"],
        requestId,
        toolName,
      })),
      sequence: 1,
      stepIndex: 1,
      turnId: "turn",
    };
    const nativeRequest = {
      clientRequestId: "native-response",
      responses: approvals.map(({ requestId }) => ({
        requestId,
        response: { kind: "approve" as const },
      })),
      sessionId: "session_fixture",
    };
    const nativeReceipts = approvals.map((approval, sequence) => ({
      ...approval,
      format: "autograph-hosted-approval-v1" as const,
      outcome: "approved" as const,
      responderPrincipalId: principal.ownerUserId,
      sequence,
      turnId: "",
    }));
    const proof = {
      adapterGeneration: 1,
      adapterSessionId: "adapter_1",
      checkpointDigest: `sha256:${"f".repeat(64)}`,
      request: nativeRequest,
    };
    const marker = {
      adapterGeneration: 1,
      adapterSessionId: "adapter_1",
      approvals,
      batches: [nativeBatch],
    };
    const complete = {
      pending: [],
      resolved: [
        {
          batch: nativeBatch,
          resolutions: approvals.map(({ requestId }) => ({
            kind: "tool-approval" as const,
            outcome: "approved" as const,
            requestId,
          })),
        },
      ],
      version: 1 as const,
    };
    const capture = {
      pendingRequests: [],
      receipts: nativeReceipts,
      sessionId: nativeRequest.sessionId,
      version: 1 as const,
    };
    const args = {
      capture,
      clientRequestId: nativeRequest.clientRequestId,
      marker,
      ownerUserId: principal.ownerUserId,
      proof,
      receipts: nativeReceipts,
      requestDigest: digest({
        kind: "respond",
        request: nativeRequest,
        sessionId: nativeRequest.sessionId,
      }),
      sessionId: nativeRequest.sessionId,
      state: complete,
    };
    expect(provesResourceApprovalResponse(args)).toBe(true);
    expect(provesResourceApprovalResponse({ ...args, receipts: nativeReceipts.slice(0, 1) })).toBe(
      false,
    );
    expect(provesResourceApprovalResponse({ ...args, ownerUserId: "foreign-owner" })).toBe(false);
    expect(provesResourceApprovalResponse({ ...args, state: { ...complete, resolved: [] } })).toBe(
      false,
    );
  });
});
const sessionId = "session_fixture";
const selection = {
  appId: "spend-review",
  branch: "preview",
  environment: "preview" as const,
  projectId: "prj_fixture",
  sessionId,
};
const plan = hostedOperatorPlanSchema.parse({
  access: [{ actorId: "reviewer", organizationId: "org", roles: ["reviewer"] }],
  action: "prepare",
  appDatabase: {
    database: "spend",
    migratorRole: "spend_owner",
    resourceId: "app-resource",
    runtimeRole: "spend_runtime",
  },
  authDatabase: {
    database: "shared_auth",
    migratorRole: "auth_owner",
    resourceId: "auth-resource",
    runtimeRole: "auth_runtime",
  },
  contextId: "context",
  cost: { class: "shared-recovery-group", description: "fixture", owner: "owner" },
  effects: [
    { description: "verify resources", id: "resources", kind: "resources" },
    { description: "install release", id: "install", kind: "install" },
    { description: "grant access", id: "access", kind: "access" },
    { description: "bind runtime", id: "bindings", kind: "bindings" },
  ],
  installer: { reference: "installer", sha256: "a".repeat(64) },
  neon: {
    branchId: "br_synthetic",
    connectionRef: "owner-connection",
    endpoint: "ep-fixture.us-east-1.aws.neon.tech",
    projectId: "neon-project",
    source: "synthetic-only",
  },
  publicGateway: {
    branch: selection.branch,
    origin: "https://apps-preview.example.test",
    projectId: selection.projectId,
  },
  release: { artifactRef: "artifact", id: "release", sha256: "b".repeat(64) },
  retention: { expiresAt: "2027-01-01T00:00:00.000Z", policy: "retain" },
  selection,
  version: 1,
});
const toolInput = {
  appId: selection.appId,
  branch: selection.branch,
  environment: selection.environment,
  operationRef: "a3f06690-718f-41c7-a67f-c6c1c0ecdbf3",
  plan,
  planDigest: operatorPlanDigest(plan),
  projectId: selection.projectId,
};

const request = {
  clientRequestId: "original-response",
  responses: [{ requestId: "request_fixture", response: { kind: "approve" as const } }],
  sessionId,
};
const receipt = privateHostedApprovalReceiptSchema.parse({
  callId: "call_fixture",
  format: "autograph-hosted-approval-v1",
  outcome: "approved",
  requestId: "request_fixture",
  responderPrincipalId: principal.ownerUserId,
  sequence: 35,
  toolInput,
  toolName: "prepare-app-hosted-runtime",
  turnId: "",
});
const batch = {
  requests: [
    {
      kind: "tool-approval" as const,
      optionIds: ["approve", "deny"],
      requestId: "request_fixture",
      toolName: "prepare-app-hosted-runtime",
    },
  ],
  sequence: 4,
  stepIndex: 2,
  turnId: "original-turn",
};
const state: PrivateInputState = {
  pending: [],
  resolved: [
    {
      batch,
      resolutions: [{ kind: "tool-approval", outcome: "approved", requestId: "request_fixture" }],
    },
  ],
  version: 1,
};
const metadata: HostedPagedCheckpointMetadata = {
  capturedAtEpochMs: 4000,
  nativeObservationState: {
    adapterSessionId: "adapter_1",
    artifactReadback: {
      incompleteArtifacts: [],
      incompleteUiPreviews: [],
      legacy: false,
      markdownCalls: [],
      pending: [],
      references: { requested: [], requestedUiPreview: [] },
    },
    boundary: "waiting",
    invalidInput: false,
    nextNativeIndex: 10,
    pendingRequests: [],
    privateInputState: state,
    prototypeProjector: { artifactReadRequests: [], readChunks: [], requested: [], transfers: [] },
    prototypeReference: { requested: [], requestedUiPreview: [] },
    publicEventCount: 0,
    version: 1,
  },
  privateApprovalCaptureState: { pendingRequests: [], receipts: [receipt], sessionId, version: 1 },
  status: "waiting",
  version: 1,
};
const session = durableHostedSessionRecordSchema.parse({
  adapterGeneration: 1,
  adapterSessionId: "adapter_1",
  checkpointDigest: `sha256:${"c".repeat(64)}`,
  checkpointProgressDigest: `sha256:${"d".repeat(64)}`,
  checkpointRef: {
    digest: `sha256:${"c".repeat(64)}`,
    eventCount: 0,
    id: "123e4567-e89b-42d3-a456-426614174001",
  },
  createdAtEpochMs: 1000,
  lastProgressAtEpochMs: 4000,
  originAdapterSessionId: "adapter_1",
  principal,
  privateApprovalReceipts: [receipt],
  resumability: "live",
  sessionId,
  stage: "ready",
  status: "waiting",
  title: "App",
  updatedAtEpochMs: 4000,
  version: 2,
});
const operation = hostedOperationRecordSchema.parse({
  clientRequestId: request.clientRequestId,
  createdAtEpochMs: 2000,
  kind: "respond",
  operationId: stableId("op", {
    clientRequestId: request.clientRequestId,
    kind: "respond",
    tenant: [principal.issuer, principal.audience, principal.workspaceId, principal.ownerUserId],
  }),
  principal,
  requestDigest: digest({ kind: "respond", request, sessionId }),
  safeErrorCode: "submission_unknown",
  sessionId,
  state: "submission_unknown",
  updatedAtEpochMs: 3000,
  version: 1,
});
const proof = resourceApprovalResponseProofSchema.parse({
  adapterGeneration: session.adapterGeneration,
  adapterSessionId: session.adapterSessionId,
  checkpointDigest: session.checkpointDigest,
  request,
});
const result = { cursor: 0, events: [], sessionId, status: "waiting" as const };
const required = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("Required fixture value is missing");
  }
  return value;
};
const page = (actualMetadata = metadata): HostedCheckpointPage => ({
  checkpointDigest: required(session.checkpointDigest),
  cursor: 0,
  events: [],
  metadata: actualMetadata,
  totalEvents: 0,
});
const privateInputs = (value: HostedPagedCheckpointMetadata) =>
  required(required(value.nativeObservationState).privateInputState);
const resolvedInput = (value: HostedPagedCheckpointMetadata) =>
  required(privateInputs(value).resolved[0]);
const capture = (value: HostedPagedCheckpointMetadata) =>
  required(value.privateApprovalCaptureState);
const settledReceipt = (value: HostedPagedCheckpointMetadata) =>
  required(capture(value).receipts[0]);
const marker = required(
  captureResourceApprovalResponse(
    session,
    { ...state, pending: [batch], resolved: [] },
    {
      pendingRequests: [
        {
          callId: receipt.callId,
          requestId: receipt.requestId,
          toolInput,
          toolName: receipt.toolName,
        },
      ],
      receipts: [],
      sessionId,
      version: 1,
    },
    request,
  ),
);

describe("resource approval response acknowledgement", () => {
  it("recovers an original never-replaced historical approval from complete native settlement", () => {
    expect(isProvedResourceApprovalResponse(operation, session, proof, metadata)).toBe(true);
    expect(
      isProvedResourceApprovalResponse(
        { ...operation, resourceApprovalResponse: marker },
        session,
        proof,
        metadata,
      ),
    ).toBe(true);
  });
  it("requires the saved original marker for a later adapter generation", () => {
    const current = { ...session, adapterGeneration: 2 };
    const laterProof = { ...proof, adapterGeneration: 2 };
    expect(isProvedResourceApprovalResponse(operation, current, laterProof, metadata)).toBe(false);
    expect(
      isProvedResourceApprovalResponse(
        { ...operation, resourceApprovalResponse: { ...marker, adapterGeneration: 2 } },
        current,
        laterProof,
        metadata,
      ),
    ).toBe(true);
  });
  it("reconciles a denied native resource approval only with its matching cancelled receipt", () => {
    const deniedRequest = {
      ...request,
      responses: [{ requestId: receipt.requestId, response: { kind: "deny" as const } }],
    };
    const cancelled = { ...receipt, outcome: "cancelled" as const };
    const actual = structuredClone(metadata);
    capture(actual).receipts = [cancelled];
    required(resolvedInput(actual).resolutions[0]).outcome = "denied";
    const deniedOperation = {
      ...operation,
      requestDigest: digest({ kind: "respond", request: deniedRequest, sessionId }),
    };
    const deniedProof = { ...proof, request: deniedRequest };
    expect(
      isProvedResourceApprovalResponse(
        deniedOperation,
        { ...session, privateApprovalReceipts: [cancelled] },
        deniedProof,
        actual,
      ),
    ).toBe(true);
    expect(isProvedResourceApprovalResponse(deniedOperation, session, deniedProof, actual)).toBe(
      false,
    );
  });
  it.each([
    [
      "missing native batch",
      (value: HostedPagedCheckpointMetadata) => {
        privateInputs(value).resolved = [];
      },
    ],
    [
      "missing native resolution",
      (value: HostedPagedCheckpointMetadata) => {
        resolvedInput(value).resolutions = [];
      },
    ],
    [
      "different native outcome",
      (value: HostedPagedCheckpointMetadata) => {
        required(resolvedInput(value).resolutions[0]).outcome = "denied";
      },
    ],
    [
      "missing private settlement",
      (value: HostedPagedCheckpointMetadata) => {
        capture(value).receipts = [];
      },
    ],
    [
      "foreign responder",
      (value: HostedPagedCheckpointMetadata) => {
        settledReceipt(value).responderPrincipalId = "foreign-owner";
      },
    ],
    [
      "uncompleted cold read",
      (value: HostedPagedCheckpointMetadata) => {
        value.coldReadProgress = {
          events: [],
          nativeObservationState: required(value.nativeObservationState),
          privateApprovalCaptureState: capture(value),
          version: 1,
        };
      },
    ],
    [
      "extra native request",
      (value: HostedPagedCheckpointMetadata) => {
        resolvedInput(value).batch.requests.push({
          ...required(batch.requests[0]),
          requestId: "other-request",
        });
      },
    ],
    [
      "question input",
      (value: HostedPagedCheckpointMetadata) => {
        required(resolvedInput(value).batch.requests[0]).kind = "question";
      },
    ],
  ] as const)("retains unknown for %s", (_name, change) => {
    const changed = structuredClone(metadata);
    change(changed);
    expect(isProvedResourceApprovalResponse(operation, session, proof, changed)).toBe(false);
  });
  it("rejects replacement, request-digest and original plan mismatches", () => {
    expect(
      isProvedResourceApprovalResponse(
        operation,
        { ...session, adapterGeneration: 2 },
        { ...proof, adapterGeneration: 2 },
        metadata,
      ),
    ).toBe(false);
    expect(
      isProvedResourceApprovalResponse(
        operation,
        session,
        {
          ...proof,
          request: {
            ...request,
            responses: [{ requestId: receipt.requestId, response: { kind: "deny" } }],
          },
        },
        metadata,
      ),
    ).toBe(false);
    expect(
      isProvedResourceApprovalResponse(
        {
          ...operation,
          resourceApprovalResponse: {
            ...marker,
            approvals: [{ ...required(marker.approvals[0]), callId: "different-call" }],
          },
        },
        session,
        proof,
        metadata,
      ),
    ).toBe(false);
    expect(
      isProvedResourceApprovalResponse(
        operation,
        { ...session, principal: { ...principal, ownerUserId: "foreign-owner" } },
        proof,
        metadata,
      ),
    ).toBe(false);
  });
  it("settles a historical response through the service without POST or redispatch", async () => {
    const store = new InMemoryHostedEveStore();
    store.readCheckpointPage = vi.fn(async () => page());
    const startOperation = hostedOperationRecordSchema.parse({
      clientRequestId: "start",
      createdAtEpochMs: 1000,
      kind: "start",
      operationId: "start",
      principal,
      requestDigest: `sha256:${"a".repeat(64)}`,
      state: "reserved",
      updatedAtEpochMs: 1000,
      version: 1,
    });
    await store.reserveOperation(principal, startOperation);
    await store.settleSucceeded({
      nowEpochMs: 2000,
      operationId: "start",
      principal,
      requestDigest: startOperation.requestDigest,
      result,
      session,
    });
    const reserved = withoutHostedOperationError(operation);
    await store.reserveOperation(
      principal,
      hostedOperationRecordSchema.parse({ ...reserved, state: "reserved" }),
    );
    await store.settleUnsuccessful({
      nowEpochMs: 3000,
      operationId: operation.operationId,
      principal,
      requestDigest: operation.requestDigest,
      safeErrorCode: "submission_unknown",
      state: "submission_unknown",
    });
    const respond = vi.fn();
    const service = createHostedEveSessionService({
      assertSendDeliveryOwner: vi.fn<() => Promise<void>>().mockResolvedValue(),
      now: () => 4000,
      principal,
      store,
      transport: {
        cancel: vi.fn(),
        get: vi.fn(async () => {
          throw new HostedSessionReadTimeoutError();
        }),
        respond,
        send: vi.fn(),
        start: vi.fn(),
      },
    });
    const recovered = await service.respond(request);
    expect(recovered).toMatchObject({
      cursor: 0,
      error: { code: "session_read_delayed" },
      events: [],
      sessionId,
      status: "working",
    });
    expect(respond).not.toHaveBeenCalled();
    const retry = await service.respond(request);
    expect(retry).toEqual(recovered);
    const reservedAgain = await store.reserveOperation(
      principal,
      hostedOperationRecordSchema.parse({ ...reserved, state: "reserved" }),
    );
    if (reservedAgain.disposition !== "existing") {
      throw new Error("Expected saved operation");
    }
    expect(reservedAgain.operation.state).toBe("succeeded");
  });
});

// oxlint-disable sonarjs/no-nested-functions, promise/prefer-await-to-callbacks -- Terminal builders and transaction callbacks model the actual Drizzle API.
const postgresSettlementFixture = (changedSession = session, changedMetadata = metadata) => {
  const queries: { table: string; params: unknown[] }[] = [];
  const locks: string[] = [];
  const update = vi.fn();
  const sessionRow = {
    adapterGeneration: changedSession.adapterGeneration,
    adapterSessionId: changedSession.adapterSessionId,
    audience: principal.audience,
    checkpointDigest: changedSession.checkpointDigest,
    checkpointId: required(changedSession.checkpointRef).id,
    checkpointProgressDigest: changedSession.checkpointProgressDigest,
    createdAt: new Date(changedSession.createdAtEpochMs),
    issuer: principal.issuer,
    lastProgressAt: new Date(changedSession.lastProgressAtEpochMs),
    ownerUserId: principal.ownerUserId,
    parentSessionId: null,
    record: changedSession,
    resumabilityState: changedSession.resumability,
    sessionId,
    stage: changedSession.stage,
    title: changedSession.title,
    updatedAt: new Date(changedSession.updatedAtEpochMs),
    workspaceId: principal.workspaceId,
  };
  const operationRow = {
    audience: principal.audience,
    clientRequestId: operation.clientRequestId,
    createdAt: new Date(operation.createdAtEpochMs),
    issuer: principal.issuer,
    kind: operation.kind,
    operationId: operation.operationId,
    ownerUserId: principal.ownerUserId,
    record: operation,
    requestDigest: operation.requestDigest,
    sendCancellationRevisionAtDispatch: null,
    sessionId,
    state: operation.state,
    updatedAt: new Date(operation.updatedAtEpochMs),
    workspaceId: principal.workspaceId,
  };
  const bytes = Buffer.from(JSON.stringify(changedMetadata));
  const itemDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const rows = new Map<string, unknown[]>([
    ["agent_operation", [operationRow]],
    ["agent_session", [sessionRow]],
    [
      "agent_session_checkpoint_manifest",
      [
        {
          checkpointDigest: required(changedSession.checkpointRef).digest,
          eventCount: 0,
          publishedAt: new Date(4000),
        },
      ],
    ],
    [
      "agent_session_checkpoint_item",
      [{ byteLength: bytes.byteLength, digest: itemDigest, itemIndex: -1, partCount: 1 }],
    ],
    [
      "agent_session_checkpoint_chunk",
      [{ chunkDigest: itemDigest, itemIndex: -1, partIndex: 0, payload: bytes.toString("base64") }],
    ],
  ]);
  const dialect = new PgDialect();
  type DatabaseSchema = Parameters<typeof createPostgresHostedEveStore>[0]["_"]["fullSchema"];
  const database = drizzle.mock<DatabaseSchema>();
  const { session: drizzleSession } = database._;
  const prepareQuery = drizzleSession.prepareQuery.bind(drizzleSession);
  vi.spyOn(drizzleSession, "prepareQuery").mockImplementation((query) => {
    const prepared = prepareQuery(query, undefined, undefined, false);
    vi.spyOn(prepared, "execute").mockImplementation(async () => {
      const table = /(?:from|update) "(?<table>agent_[a-z_]+)"/u.exec(query.sql)?.groups?.table;
      if (table === undefined) {
        throw new Error("Unexpected fixture query.");
      }
      if (query.sql.startsWith("update ")) {
        const record = z
          .string()
          .parse(query.params.find((value) => z.string().startsWith("{").safeParse(value).success));
        const settled = hostedOperationRecordSchema.parse(JSON.parse(record));
        update(table, query.params);
        return [
          {
            ...operationRow,
            record: settled,
            state: settled.state,
            updatedAt: new Date(settled.updatedAtEpochMs),
          },
        ];
      }
      queries.push({ params: query.params, table });
      if (query.sql.endsWith("for update")) {
        locks.push(table);
      }
      return rows.get(table) ?? [];
    });
    return prepared;
  });
  class FixtureTransaction extends PgTransaction<
    PostgresJsQueryResultHKT,
    DatabaseSchema,
    ExtractTablesWithRelations<DatabaseSchema>
  > {
    async transaction<T>(callback: (transaction: FixtureTransaction) => Promise<T>): Promise<T> {
      return await callback(this);
    }
  }
  const transaction = new FixtureTransaction(dialect, database._.session, undefined);
  vi.spyOn(database, "transaction").mockImplementation(
    async (callback) => await callback(transaction),
  );
  vi.spyOn(database, "select").mockImplementation(() => {
    throw new Error("Proof read escaped the locked transaction");
  });
  const store = createPostgresHostedEveStore(database);
  return { locks, queries, store, update };
};

// oxlint-enable sonarjs/no-nested-functions, promise/prefer-await-to-callbacks

describe("atomic PostgreSQL resource approval acknowledgement", () => {
  it("reads independently verified checkpoint bytes under operation and session locks", async () => {
    const fixture = postgresSettlementFixture();
    const settled = await fixture.store.settleSucceeded({
      nowEpochMs: 5000,
      operationId: operation.operationId,
      principal,
      requestDigest: operation.requestDigest,
      resourceApprovalResolution: proof,
      result,
    });
    expect(settled.state).toBe("succeeded");
    expect(fixture.locks).toEqual(["agent_operation", "agent_session"]);
    expect(fixture.update).toHaveBeenCalledOnce();
    expect(fixture.queries.map(({ table }) => table)).toEqual(
      expect.arrayContaining([
        "agent_operation",
        "agent_session",
        "agent_session_checkpoint_manifest",
        "agent_session_checkpoint_item",
        "agent_session_checkpoint_chunk",
      ]),
    );
    for (const query of fixture.queries) {
      expect(query.params.slice(0, 4)).toEqual([
        principal.issuer,
        principal.audience,
        principal.workspaceId,
        principal.ownerUserId,
      ]);
    }
  });
  it.each([
    "replaced adapter",
    "new checkpoint",
    "missing authoritative receipt",
    "missing native resolution",
  ] as const)("leaves unknown when locked state has %s", async (change) => {
    const current = structuredClone(session);
    const actual = structuredClone(metadata);
    if (change === "replaced adapter") {
      current.adapterGeneration = 2;
    }
    if (change === "new checkpoint") {
      current.checkpointDigest = `sha256:${"e".repeat(64)}`;
      required(current.checkpointRef).digest = current.checkpointDigest;
    }
    if (change === "missing authoritative receipt") {
      current.privateApprovalReceipts = [];
    }
    if (change === "missing native resolution") {
      resolvedInput(actual).resolutions = [];
    }
    const fixture = postgresSettlementFixture(current, actual);
    await expect(
      fixture.store.settleSucceeded({
        nowEpochMs: 5000,
        operationId: operation.operationId,
        principal,
        requestDigest: operation.requestDigest,
        resourceApprovalResolution: proof,
        result,
      }),
    ).rejects.toThrow("not proved");
    expect(fixture.update).not.toHaveBeenCalled();
  });
});
