import { describe, expect, it } from "vitest";
import type { MessageStreamEvent } from "eve/client";
import {
  nativeTargetOnboardingPlanDigest,
  nativeTargetOnboardingPlanSchema,
  nativeTargetOnboardingRegistryId,
} from "../provisioning/native-target-onboarding-contract";
import type { NativeTargetCurrentOwner } from "../provisioning/native-target-onboarding-store";
import {
  createPrivateHostedApprovalCapture,
  privateResourceApprovalSessionId,
} from "./private-hosted-approval";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner_fixture",
  workspaceId: "workspace_fixture",
};
const owner: NativeTargetCurrentOwner = {
  adapterGeneration: 1,
  adapterSessionId: "native-original",
  authority,
  publicSessionId: "public-original",
};
const plan = nativeTargetOnboardingPlanSchema.parse({
  appDatabase: {
    database: "requests_data",
    migratorRole: "requests_migrator",
    resourceId: "requests-resource",
    runtimeRole: "requests_runtime",
  },
  appId: "requests-app",
  branch: "main",
  conflictPolicy: "stop-on-conflict",
  cost: { description: "Separate app target", ownership: "current-owner" },
  nativeNeon: {
    approvalReference: "native-scope-approval",
    nativeStore: {
      configurationId: "store-config",
      resourceId: "store-resource",
      sourceProjectId: "source-project",
    },
    scope: {
      branchId: "neon-branch",
      endpointId: "neon-endpoint",
      hostname: "ep-fixture.neon.tech",
      maintenanceDatabase: "maintenance",
      maintenanceRole: "installer",
      projectId: "neon-project",
    },
  },
  origin: {
    adapterGeneration: 1,
    adapterSessionId: owner.adapterSessionId,
    appSpecDigest: "a".repeat(64),
    publicSessionId: owner.publicSessionId,
    release: {
      artifactRef: "artifact-original",
      id: "release-original",
      manifestSha256: "b".repeat(64),
      schemaSha256: "c".repeat(64),
    },
  },
  productRoles: [],
  project: {
    installationId: "install_fixture",
    name: "requests-app",
    projectSettings: {
      framework: "nextjs",
      rootDirectory: "apps/requests",
      sourceFilesOutsideRootDirectory: true,
    },
    protection: {
      oidcTokenConfig: { enabled: true, issuerMode: "team" },
      ssoProtection: { deploymentType: "all" },
    },
    teamId: "team_fixture",
  },
  retention: { policy: "Until approved cleanup" },
  version: 1,
  worker: {
    executablePath: "/trusted/generic-worker",
    id: "generic-installer",
    operationScope: "generated-app-release-install-v1",
    sha256: "d".repeat(64),
    subcommand: "protected-generated-app-install",
  },
});
const planDigest = nativeTargetOnboardingPlanDigest(plan);
const toolInput = {
  appId: plan.appId,
  operationRef: nativeTargetOnboardingRegistryId(authority, plan.appId),
  plan,
  planDigest,
};
const requested = (
  input: {
    toolName?: string;
    callId?: string;
    toolInput?: typeof toolInput;
    requestId?: string;
  } = {},
): MessageStreamEvent => ({
  data: {
    requests: [
      {
        action: {
          callId: input.callId ?? "prepare-call",
          input: input.toolInput ?? toolInput,
          kind: "tool-call",
          toolName: input.toolName ?? "prepare-app-native-target",
        },
        kind: "tool-approval",
        prompt: "Approve native target",
        requestId: input.requestId ?? "human-request",
      },
    ],
    sequence: 1,
    stepIndex: 0,
    turnId: "turn-native-target",
  },
  meta: { at: "2026-10-21T15:00:00.000Z", id: "requested-event" },
  type: "input.requested",
});
const settled = (
  outcome: "approved" | "cancelled" = "approved",
  responderPrincipalId = authority.ownerUserId,
  requestId = "human-request",
): MessageStreamEvent => ({
  data: {
    outcome,
    requestId,
    responderPrincipalId,
    sequence: 2,
    stepIndex: 0,
    turnId: "turn-native-target",
  },
  meta: { at: "2026-10-21T15:00:01.000Z", id: "settled-event" },
  type: "approval.settled",
});
describe("native target private resource approval capture", () => {
  it("retains exact request and committed settlement across checkpoint hydration", () => {
    const capture = createPrivateHostedApprovalCapture(owner.publicSessionId);
    capture.observe(requested());
    expect(capture.snapshot().pendingRequests).toHaveLength(1);
    const resumed = createPrivateHostedApprovalCapture(owner.publicSessionId, capture.snapshot());
    resumed.observe(settled());
    const [receipt] = resumed.values();
    if (receipt === undefined) {
      throw new Error("Expected the native approval receipt.");
    }
    expect(receipt).toMatchObject({
      callId: "prepare-call",
      outcome: "approved",
      requestId: "human-request",
      responderPrincipalId: authority.ownerUserId,
      toolInput,
      toolName: "prepare-app-native-target",
    });
    expect(privateResourceApprovalSessionId(receipt)).toBe(owner.publicSessionId);
    expect(resumed.snapshot().pendingRequests).toHaveLength(0);
  });
  it("rejects a foreign session and a changed plan digest", () => {
    const capture = createPrivateHostedApprovalCapture("foreign-session");
    expect(() => {
      capture.observe(requested());
    }).toThrow();
    const local = createPrivateHostedApprovalCapture(owner.publicSessionId);
    const input = { ...toolInput, planDigest: "e".repeat(64) };
    expect(() => {
      local.observe(requested({ toolInput: input }));
    }).toThrow();
    expect(local.values()).toEqual([]);
  });
  it("ignores settlements without an authenticated matching request", () => {
    const capture = createPrivateHostedApprovalCapture(owner.publicSessionId);
    capture.observe(settled());
    expect(capture.values()).toEqual([]);
  });
});
