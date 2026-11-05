import { describe, expect, it } from "vitest";
import { hostedEveOperationScopes } from "./hosted-auth";
import type { PrivateInputState } from "./session-limit-input";
import { digest } from "./hosted-operation-identifiers";
import {
  nativeTargetOnboardingPlanDigest,
  nativeTargetOnboardingPlanSchema,
  nativeTargetRequiredProjectProtection,
} from "../provisioning/native-target-onboarding-contract";
import { reconstructNativeApprovalResponse } from "./reconstruct-native-approval-response";

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
const receipts = ["one", "two"].map((requestId, sequence) => ({
  requestId,
  callId: `call-${requestId}`,
  toolName: "prepare-app-native-target" as const,
  toolInput,
  format: "autograph-hosted-approval-v1" as const,
  outcome: "approved" as const,
  responderPrincipalId: principal.ownerUserId,
  sequence,
  turnId: "",
}));
const batches = receipts.map((receipt, index) => ({
  batch: {
    sequence: index + 1,
    stepIndex: 0,
    turnId: `turn-${index}`,
    requests: [
      {
        kind: "tool-approval" as const,
        optionIds: ["approve", "deny"],
        requestId: receipt.requestId,
        toolName: receipt.toolName,
      },
    ],
  },
  resolutions: [
    { kind: "tool-approval" as const, outcome: "approved" as const, requestId: receipt.requestId },
  ],
}));
const request = {
  clientRequestId: "response",
  sessionId,
  responses: ["one", "two"].map((requestId) => ({
    requestId,
    response: { kind: "approve" as const },
  })),
};
const fixture = () => ({
  clientRequestId: request.clientRequestId,
  sessionId,
  ownerUserId: principal.ownerUserId,
  adapterSessionId: "adapter_1",
  adapterGeneration: 1,
  checkpointDigest: `sha256:${"f".repeat(64)}`,
  requestDigest: digest({ kind: "respond", request, sessionId }),
  target: {
    appId: toolInput.appId,
    operationRef: toolInput.operationRef,
    planDigest: toolInput.planDigest,
  },
  // SAFETY: The fixture uses the same validated resolved-batch shape as the capture contract.
  state: { version: 1, pending: [], resolved: structuredClone(batches) } as PrivateInputState,
  capture: {
    version: 1 as const,
    sessionId,
    pendingRequests: [],
    receipts: structuredClone(receipts),
  },
  receipts: structuredClone(receipts),
});

describe("reconstruct native approval response", () => {
  it("reconstructs every exact owner-settled batch without guessing", () => {
    expect(reconstructNativeApprovalResponse(fixture())).toEqual(request);
  });
  it("leaves incomplete batches and foreign owners unresolved", () => {
    const partial = fixture();
    partial.state.resolved.pop();
    expect(reconstructNativeApprovalResponse(partial)).toBeUndefined();
    const foreign = fixture();
    foreign.receipts[0].responderPrincipalId = "other";
    expect(reconstructNativeApprovalResponse(foreign)).toBeUndefined();
  });
  it("rejects changed order or digest rather than guessing subsets", () => {
    const wrong = fixture();
    wrong.requestDigest = digest({
      kind: "respond",
      request: { ...request, responses: request.responses.toReversed() },
      sessionId,
    });
    expect(reconstructNativeApprovalResponse(wrong)).toBeUndefined();
    const bad = fixture();
    bad.requestDigest = `sha256:${"a".repeat(64)}`;
    expect(reconstructNativeApprovalResponse(bad)).toBeUndefined();
  });
  it("rejects mixed questions, duplicates and conflicting settlements", () => {
    const mixed = fixture();
    mixed.state.resolved[0].batch.requests.push({
      kind: "question",
      optionIds: [],
      requestId: "q",
      toolName: "question",
    });
    expect(reconstructNativeApprovalResponse(mixed)).toBeUndefined();
    const duplicate = fixture();
    duplicate.receipts.push(duplicate.receipts[0]);
    expect(reconstructNativeApprovalResponse(duplicate)).toBeUndefined();
    const conflict = fixture();
    conflict.state.resolved[0].resolutions[0].outcome = "denied";
    expect(reconstructNativeApprovalResponse(conflict)).toBeUndefined();
  });
  it("ignores unrelated non-native batches without guessing", () => {
    const other = fixture();
    other.state.resolved.unshift({
      batch: {
        sequence: 0,
        stepIndex: 0,
        turnId: "other",
        requests: [
          {
            kind: "question",
            optionIds: [],
            requestId: "q",
            toolName: "question",
          },
        ],
      },
      resolutions: [{ kind: "question", outcome: "answered", requestId: "q" }],
    });
    expect(reconstructNativeApprovalResponse(other)).toEqual(request);
  });
});
