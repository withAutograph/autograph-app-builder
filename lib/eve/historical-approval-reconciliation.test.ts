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
const binding = {
  issuer: principal.issuer,
  audience: principal.audience,
  workspaceId: principal.workspaceId,
  ownerUserId: principal.ownerUserId,
  sessionId,
  adapterSessionId: "adapter_1",
  adapterGeneration: 1,
};
const publicEvents: PublicEveEvent[] = [
  { type: "status", index: 0, status: "working" },
  { type: "status", index: 1, status: "input_required" },
];
const stream = async function* stream(events: PublicEveEvent[]) {
  for (const event of events) {
    yield event;
  }
};
const requestEvent = (): MessageStreamEvent => ({
  type: "input.requested",
  meta: { at: "2026-10-21T15:00:00Z", id: "event-1" },
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
});
const settledEvent = (requestId: string): MessageStreamEvent => ({
  type: "approval.settled",
  meta: { at: "2026-10-21T15:01:00Z", id: `settled-${requestId}` },
  data: {
    sequence: 2,
    stepIndex: 0,
    turnId: "turn",
    requestId,
    responderPrincipalId: principal.ownerUserId,
    outcome: "approved",
  },
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
    version: 1,
    binding: {
      principal,
      sessionId,
      approvalSessionId: sessionId,
      adapterSessionId: "adapter_1",
      adapterGeneration: 1,
    },
    sourceCheckpoint: {
      id: "00000000-0000-4000-8000-000000000001",
      digest: `sha256:${"a".repeat(64)}`,
      eventCount: 2,
    },
    events: publicEvents.slice(0, 1),
    nativeObservationState: nativeState,
    privateApprovalCaptureState: capture.snapshot(),
  });
const verify = (replayBinding = binding, replayEvents = publicEvents, complete = true) =>
  verifyHistoricalApprovalReplay({
    trustedBinding: binding,
    replayBinding,
    trustedEventCount: 2,
    trustedEvents: stream(publicEvents),
    replayEvents: stream(replayEvents),
    nativeTail: { complete, nextNativeIndex: 10, nativeTailIndex: 9 },
  });
const response = {
  clientRequestId: "response",
  sessionId,
  responses: ["one", "two"].map((requestId) => ({
    requestId,
    response: { kind: "approve" as const },
  })),
};
const approvals = ["one", "two"].map((requestId) => ({
  requestId,
  callId: `call-${requestId}`,
  toolName: "prepare-app-native-target" as const,
  toolInput,
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
  adapterSessionId: "adapter_1",
  adapterGeneration: 1,
  checkpointDigest: `sha256:${"f".repeat(64)}`,
  request: response,
};
const marker = { adapterSessionId: "adapter_1", adapterGeneration: 1, approvals, batches: [batch] };
const resolved = (ids: string[]) => ({
  version: 1 as const,
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
});
const proves = (capture: ReturnType<typeof createPrivateHostedApprovalCapture>, ids: string[]) =>
  provesResourceApprovalResponse({
    clientRequestId: response.clientRequestId,
    requestDigest: digest({ kind: "respond", request: response, sessionId }),
    sessionId,
    ownerUserId: principal.ownerUserId,
    marker,
    proof,
    state: resolved(ids),
    capture: capture.snapshot(),
    receipts: capture.values(),
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
      verify(binding, [publicEvents[0], { type: "status", index: 1, status: "waiting" }]),
    ).rejects.toThrow("prefix mismatch");
  });
});
