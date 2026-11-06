import { describe, expect, it } from "vitest";
import type { MessageStreamEvent } from "eve/client";
import type { PublicEveEvent } from "../mcp/contracts";
import { hostedEveOperationScopes } from "./hosted-auth";
import { digest } from "./hosted-operation-identifiers";
import { createPrivateHostedApprovalCapture } from "./private-hosted-approval";
import { provesResourceApprovalResponse } from "./resource-approval-response";
import { approvalReplayProgressSchema } from "./postgres-hosted-checkpoint-history";
import { verifyHistoricalApprovalReplay } from "./historical-approval-replay";
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

const sessionId = "session_fixture";
const toolInput = {
  appId: nativePlan.appId,
  operationRef: "a3f06690-718f-41c7-a67f-c6c1c0ecdbf3",
  plan: nativePlan,
  planDigest: nativeTargetOnboardingPlanDigest(nativePlan),
};
const binding = {
  adapterGeneration: 1,
  adapterSessionId: "adapter_1",
  audience: principal.audience,
  issuer: principal.issuer,
  ownerUserId: principal.ownerUserId,
  sessionId,
  workspaceId: principal.workspaceId,
};
const publicEvents: PublicEveEvent[] = [
  { index: 0, status: "working", type: "status" },
  { index: 1, status: "input_required", type: "status" },
];
const stream = async function* stream(events: PublicEveEvent[]) {
  for (const event of events) {
    yield event;
  }
};
const requestEvent = (): MessageStreamEvent => ({
  data: {
    requests: ["one", "two"].map((requestId) => ({
      action: {
        callId: `call-${requestId}`,
        input: toolInput,
        kind: "tool-call" as const,
        toolName: "prepare-app-native-target",
      },
      kind: "tool-approval" as const,
      prompt: "Approve",
      requestId,
    })),
    sequence: 1,
    stepIndex: 0,
    turnId: "turn",
  },
  meta: { at: "2026-10-21T15:00:00Z", id: "event-1" },
  type: "input.requested",
});
const settledEvent = (requestId: string): MessageStreamEvent => ({
  data: {
    outcome: "approved",
    requestId,
    responderPrincipalId: principal.ownerUserId,
    sequence: 2,
    stepIndex: 0,
    turnId: "turn",
  },
  meta: { at: "2026-10-21T15:01:00Z", id: `settled-${requestId}` },
  type: "approval.settled",
});
const nativeState = {
  adapterSessionId: "adapter_1",
  artifactReadback: {
    incompleteArtifacts: [],
    incompleteUiPreviews: [],
    legacy: false,
    markdownCalls: [],
    pending: [],
    references: { requested: [], requestedUiPreview: [] },
  },
  boundary: "working" as const,
  invalidInput: false,
  nextNativeIndex: 4,
  pendingRequests: [],
  prototypeProjector: { artifactReadRequests: [], readChunks: [], requested: [], transfers: [] },
  prototypeReference: { requested: [], requestedUiPreview: [] },
  publicEventCount: 1,
  version: 1 as const,
};
const replayProgress = (capture: ReturnType<typeof createPrivateHostedApprovalCapture>) =>
  approvalReplayProgressSchema.parse({
    binding: {
      adapterGeneration: 1,
      adapterSessionId: "adapter_1",
      approvalSessionId: sessionId,
      principal,
      sessionId,
    },
    events: publicEvents.slice(0, 1),
    nativeObservationState: nativeState,
    privateApprovalCaptureState: capture.snapshot(),
    sourceCheckpoint: {
      digest: `sha256:${"a".repeat(64)}`,
      eventCount: 2,
      id: "00000000-0000-4000-8000-000000000001",
    },
    version: 1,
  });
const verify = async (replayBinding = binding, replayEvents = publicEvents, complete = true) =>
  await verifyHistoricalApprovalReplay({
    nativeTail: { complete, nativeTailIndex: 9, nextNativeIndex: 10 },
    replayBinding,
    replayEvents: stream(replayEvents),
    trustedBinding: binding,
    trustedEventCount: 2,
    trustedEvents: stream(publicEvents),
  });
const response = {
  clientRequestId: "response",
  responses: ["one", "two"].map((requestId) => ({
    requestId,
    response: { kind: "approve" as const },
  })),
  sessionId,
};
const approvals = ["one", "two"].map((requestId) => ({
  callId: `call-${requestId}`,
  requestId,
  toolInput,
  toolName: "prepare-app-native-target" as const,
}));
const batch = {
  requests: approvals.map(({ requestId, toolName }) => ({
    kind: "tool-approval" as const,
    optionIds: ["approve", "deny"],
    requestId,
    toolName,
  })),
  sequence: 1,
  stepIndex: 0,
  turnId: "turn",
};
const proof = {
  adapterGeneration: 1,
  adapterSessionId: "adapter_1",
  checkpointDigest: `sha256:${"f".repeat(64)}`,
  request: response,
};
const marker = { adapterGeneration: 1, adapterSessionId: "adapter_1", approvals, batches: [batch] };
const resolved = (ids: string[]) => ({
  pending: [],
  resolved: [
    {
      batch,
      resolutions: ids.map((requestId) => ({
        kind: "tool-approval" as const,
        outcome: "approved" as const,
        requestId,
      })),
    },
  ],
  version: 1 as const,
});
const proves = (capture: ReturnType<typeof createPrivateHostedApprovalCapture>, ids: string[]) =>
  provesResourceApprovalResponse({
    capture: capture.snapshot(),
    clientRequestId: response.clientRequestId,
    marker,
    ownerUserId: principal.ownerUserId,
    proof,
    receipts: capture.values(),
    requestDigest: digest({ kind: "respond", request: response, sessionId }),
    sessionId,
    state: resolved(ids),
  });

describe("historical native approval reconciliation contracts", () => {
  it("resumes an incomplete replay without treating a partial batch as settled", async () => {
    const first = createPrivateHostedApprovalCapture(sessionId);
    first.observe(requestEvent());
    first.observe(settledEvent("one"));
    const saved = replayProgress(first);
    await expect(verify(binding, publicEvents, false)).rejects.toThrow("incomplete");
    const resumed = createPrivateHostedApprovalCapture(
      sessionId,
      saved.privateApprovalCaptureState,
    );
    expect(proves(resumed, ["one"])).toBe(false);
    resumed.observe(settledEvent("two"));
    await expect(verify()).resolves.toEqual({ replayEventCount: 2 });
    expect(proves(resumed, ["one", "two"])).toBe(true);
  });
  it("rejects owner and adapter drift even with settled approvals", async () => {
    for (const changed of [
      { ...binding, ownerUserId: "other" },
      { ...binding, adapterSessionId: "other" },
      { ...binding, adapterGeneration: 2 },
    ]) {
      // Validate each distinct binding drift independently.
      // oxlint-disable-next-line eslint/no-await-in-loop
      await expect(verify(changed)).rejects.toThrow("binding mismatch");
    }
  });
  it("rejects rewritten public prefix before accepting replayed proof", async () => {
    await expect(
      verify(binding, [publicEvents[0], { index: 1, status: "waiting", type: "status" }]),
    ).rejects.toThrow("prefix mismatch");
  });
});
