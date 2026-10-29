import { describe, expect, it, vi } from "vitest";
import type { MessageStreamEvent } from "eve/client";
import { hostedEveOperationScopes } from "./hosted-auth";
import { digest, stableId } from "./hosted-operation-identifiers";
import { createHostedEveSessionService } from "./hosted-service";
import { createPrivateHostedApprovalCapture } from "./private-hosted-approval";
import {
  InMemoryHostedEveStore,
  durableHostedSessionRecordSchema,
  hostedOperationRecordSchema,
  withoutHostedOperationError,
} from "./hosted-store";
import type { HostedEveStore, HostedPagedCheckpointMetadata } from "./hosted-store";
import {
  nativeTargetOnboardingPlanDigest,
  nativeTargetOnboardingPlanSchema,
  nativeTargetRequiredProjectProtection,
} from "../provisioning/native-target-onboarding-contract";

const principal = {
  audience: "autograph-app-builder",
  issuer: "https://identity.example.test",
  ownerUserId: "owner_1",
  scopes: Object.values(hostedEveOperationScopes),
  workspaceId: "workspace_1",
};
const nativePlan = nativeTargetOnboardingPlanSchema.parse({
  version: 1,
  appId: "requests-app",
  origin: {
    publicSessionId: "session_fixture",
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

const sessionId = "session_fixture";
const toolInput = {
  appId: nativePlan.appId,
  operationRef: "a3f06690-718f-41c7-a67f-c6c1c0ecdbf3",
  plan: nativePlan,
  planDigest: nativeTargetOnboardingPlanDigest(nativePlan),
};
const batch = {
  requests: ["one", "two"].map((requestId) => ({
    kind: "tool-approval" as const,
    optionIds: ["approve", "deny"],
    requestId,
    toolName: "prepare-app-native-target",
  })),
  sequence: 1,
  stepIndex: 0,
  turnId: "turn",
};
const request = {
  clientRequestId: "original-response",
  sessionId,
  responses: ["one", "two"].map((requestId) => ({
    requestId,
    response: { kind: "approve" as const },
  })),
};
const state = {
  version: 1 as const,
  pending: [],
  resolved: [
    {
      batch,
      resolutions: ["one", "two"].map((requestId) => ({
        kind: "tool-approval" as const,
        outcome: "approved" as const,
        requestId,
      })),
    },
  ],
};
const nativeState = (nextNativeIndex: number) => ({
  adapterSessionId: "adapter_1",
  artifactReadback: {
    incompleteArtifacts: [],
    incompleteUiPreviews: [],
    legacy: false,
    markdownCalls: [],
    pending: [],
    references: { requested: [], requestedUiPreview: [] },
  },
  boundary: "waiting" as const,
  invalidInput: false,
  nextNativeIndex,
  pendingRequests: [],
  privateInputState: state,
  prototypeProjector: { artifactReadRequests: [], readChunks: [], requested: [], transfers: [] },
  prototypeReference: { requested: [], requestedUiPreview: [] },
  publicEventCount: 0,
  version: 1 as const,
});
const requested: MessageStreamEvent = {
  type: "input.requested",
  meta: { at: "2026-10-21T15:00:00Z", id: "requested" },
  data: {
    sequence: 1,
    stepIndex: 0,
    turnId: "turn",
    requests: ["one", "two"].map((requestId) => ({
      kind: "tool-approval" as const,
      requestId,
      prompt: "Approve",
      action: {
        kind: "tool-call" as const,
        toolName: "prepare-app-native-target",
        callId: `call-${requestId}`,
        input: toolInput,
      },
    })),
  },
};
const settled: MessageStreamEvent = {
  type: "approval.settled",
  meta: { at: "2026-10-21T15:00:01Z", id: "settled" },
  data: {
    sequence: 2,
    stepIndex: 0,
    turnId: "turn",
    requestId: "one",
    responderPrincipalId: principal.ownerUserId,
    outcome: "approved",
  },
};

describe("service recovery of historical native approval", () => {
  it.each([false, true])(
    "does not settle a partial replay with stale receipts: %s",
    async (stale) => {
      const previousCapture = createPrivateHostedApprovalCapture(sessionId);
      previousCapture.observe(requested);
      previousCapture.observe(settled);
      previousCapture.observe({
        ...settled,
        data: { ...settled.data, requestId: "two", sequence: 3 },
      });
      const staleCapture = previousCapture.snapshot();
      const base = new InMemoryHostedEveStore();
      let current = durableHostedSessionRecordSchema.parse({
        adapterSessionId: "adapter_1",
        adapterGeneration: 1,
        originAdapterSessionId: "adapter_1",
        createdAtEpochMs: 1,
        updatedAtEpochMs: 1,
        lastProgressAtEpochMs: 1,
        principal,
        sessionId,
        status: "waiting",
        resumability: "live",
        stage: "ready",
        title: "App",
        version: 2,
        checkpointDigest: `sha256:${"c".repeat(64)}`,
        checkpointProgressDigest: `sha256:${"d".repeat(64)}`,
        checkpointRef: {
          id: "123e4567-e89b-42d3-a456-426614174001",
          digest: `sha256:${"c".repeat(64)}`,
          eventCount: 0,
        },
        privateApprovalReceipts: stale ? staleCapture.receipts : [],
      });
      let metadata: HostedPagedCheckpointMetadata = {
        version: 1,
        capturedAtEpochMs: 1,
        status: "waiting",
        nativeObservationState: nativeState(10),
        privateApprovalCaptureState: stale
          ? staleCapture
          : { version: 1, sessionId, pendingRequests: [], receipts: [] },
      };
      const operation = hostedOperationRecordSchema.parse({
        clientRequestId: request.clientRequestId,
        createdAtEpochMs: 1,
        updatedAtEpochMs: 1,
        kind: "respond",
        operationId: stableId("op", {
          clientRequestId: request.clientRequestId,
          kind: "respond",
          tenant: [
            principal.issuer,
            principal.audience,
            principal.workspaceId,
            principal.ownerUserId,
          ],
        }),
        principal,
        requestDigest: digest({ kind: "respond", request, sessionId }),
        sessionId,
        state: "submission_unknown",
        safeErrorCode: "submission_unknown",
        version: 1,
      });
      const respond = vi.fn();
      let call = 0;
      let revision = 0;
      const observe = vi.fn(
        async (
          input: Parameters<
            NonNullable<Parameters<typeof createHostedEveSessionService>[0]["transport"]["observe"]>
          >[0],
        ) => {
          call += 1;
          if (input.nativeObservationState === undefined) {
            await input.onPrivateEvent?.(requested);
            await input.onPrivateEvent?.(settled);
            return {
              artifactProjectionRequiresLegacyReadback: false,
              installedEventCount: 0,
              observationComplete: false,
              nativeTailIndex: 8,
              nextNativeIndex: 3,
              nativeObservationState: nativeState(3),
              publicEventCount: 0,
              pendingRequests: [],
              status: "waiting" as const,
            };
          }
          if (input.nativeObservationState.nextNativeIndex === 3) {
            await input.onPrivateEvent?.({
              ...settled,
              data: { ...settled.data, requestId: "two", sequence: 3 },
            });
          }
          return {
            artifactProjectionRequiresLegacyReadback: false,
            installedEventCount: 0,
            observationComplete: true,
            nativeTailIndex: 9,
            nextNativeIndex: 10,
            nativeObservationState: nativeState(10),
            publicEventCount: 0,
            pendingRequests: [],
            status: "waiting" as const,
          };
        },
      );
      const getSession = vi.fn(() => Promise.resolve(current));
      const observeSessionPaged = vi.fn<NonNullable<HostedEveStore["observeSessionPaged"]>>(
        async (input) => {
          expect(input.expectedCheckpointDigest).toBe(current.checkpointDigest);
          if (input.replayBinding !== undefined) {
            expect(input.replayBinding.adapterSessionId).toBe("adapter_1");
          }
          let eventCount = 0;
          for await (const event of input.events) {
            expect(event.index).toBe(eventCount);
            eventCount += 1;
          }
          expect(eventCount).toBe(0);
          metadata = input.metadata;
          revision += 1;
          const next = `sha256:${revision.toString(16).padStart(64, "0")}`;
          current = durableHostedSessionRecordSchema.parse({
            ...current,
            ...(input.verifiedReplayReceipts === undefined
              ? {}
              : { privateApprovalReceipts: input.verifiedReplayReceipts }),
            checkpointDigest: next,
            checkpointRef: { ...current.checkpointRef, digest: next },
            updatedAtEpochMs: input.nowEpochMs,
          });
          return current;
        },
      );
      const readCheckpointPage = vi.fn<NonNullable<HostedEveStore["readCheckpointPage"]>>((input) =>
        Promise.resolve({
          checkpointDigest: input.checkpointRef.digest,
          cursor: 0,
          events: [],
          metadata,
          totalEvents: 0,
        }),
      );
      const store: HostedEveStore = {
        getSession,
        listSessions: base.listSessions.bind(base),
        reserveOperation: vi.fn(() =>
          Promise.resolve({ disposition: "existing" as const, operation }),
        ),
        settleSucceeded: vi.fn<HostedEveStore["settleSucceeded"]>((input) =>
          Promise.resolve(
            hostedOperationRecordSchema.parse({
              ...withoutHostedOperationError(operation),
              state: "succeeded",
              result: input.result,
            }),
          ),
        ),
        settleUnsuccessful: vi.fn(),
        observeSessionPaged,
        readCheckpointPage,
      };
      const service = createHostedEveSessionService({
        principal,
        store,
        now: () => 50,
        assertSendDeliveryOwner: () => Promise.resolve(),
        transport: {
          observe,
          get: vi.fn(),
          start: vi.fn(),
          send: vi.fn(),
          respond,
          cancel: vi.fn(),
        },
      });
      await expect(service.respond(request)).rejects.toThrow();
      expect(call).toBeGreaterThanOrEqual(2);
      expect(respond).not.toHaveBeenCalled();
      expect(store.settleSucceeded).not.toHaveBeenCalled();
      expect(metadata.approvalReplayProgress?.nativeObservationState.nextNativeIndex).toBe(3);
      expect(metadata.approvalReplayProgress?.privateApprovalCaptureState.receipts).toHaveLength(1);
      expect(
        metadata.approvalReplayProgress?.privateApprovalCaptureState.pendingRequests,
      ).toHaveLength(1);
      await expect(service.respond(request)).resolves.toMatchObject({ sessionId });
      expect(respond).not.toHaveBeenCalled();
      expect(store.settleSucceeded).toHaveBeenCalledOnce();
      expect(metadata.approvalReplayProgress).toBeUndefined();
      expect(metadata.privateApprovalCaptureState?.receipts).toHaveLength(2);
    },
  );
});
