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
  branch: "preview",
  appDatabase: {
    database: "requests_data",
    migratorRole: "requests_owner",
    resourceId: "resource",
    runtimeRole: "requests_runtime",
  },
  productRoles: [],
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
  worker: {
    executablePath: "/trusted/worker",
    id: "worker",
    operationScope: "generated-app-release-install-v1",
    sha256: "d".repeat(64),
    subcommand: "protected-generated-app-install",
  },
  cost: { description: "Preview usage", ownership: "current-owner" },
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
