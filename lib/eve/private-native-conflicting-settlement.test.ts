import { describe, expect, it } from "vitest";
import type { MessageStreamEvent } from "eve/client";
import {
  nativeTargetOnboardingPlanDigest,
  nativeTargetOnboardingPlanSchema,
  nativeTargetOnboardingRegistryId,
} from "../provisioning/native-target-onboarding-contract";
import type { NativeTargetCurrentOwner } from "../provisioning/native-target-onboarding-store";
import { createPrivateHostedApprovalCapture } from "./private-hosted-approval";

const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace_fixture",
  ownerUserId: "owner_fixture",
};
const owner: NativeTargetCurrentOwner = {
  authority,
  publicSessionId: "public-original",
  adapterSessionId: "native-original",
  adapterGeneration: 1,
};
const plan = nativeTargetOnboardingPlanSchema.parse({
  version: 1,
  appId: "requests-app",
  origin: {
    publicSessionId: owner.publicSessionId,
    adapterSessionId: owner.adapterSessionId,
    adapterGeneration: 1,
    appSpecDigest: "a".repeat(64),
    release: {
      id: "release-original",
      artifactRef: "artifact-original",
      manifestSha256: "b".repeat(64),
      schemaSha256: "c".repeat(64),
    },
  },
  project: {
    protection: {
      ssoProtection: { deploymentType: "all" },
      oidcTokenConfig: { enabled: true, issuerMode: "team" },
    },
    name: "requests-app",
    teamId: "team_fixture",
    installationId: "install_fixture",
    projectSettings: {
      framework: "nextjs",
      rootDirectory: "apps/requests",
      sourceFilesOutsideRootDirectory: true,
    },
  },
  branch: "main",
  appDatabase: {
    resourceId: "requests-resource",
    database: "requests_data",
    migratorRole: "requests_migrator",
    runtimeRole: "requests_runtime",
  },
  productRoles: [],
  nativeNeon: {
    approvalReference: "native-scope-approval",
    nativeStore: {
      configurationId: "store-config",
      resourceId: "store-resource",
      sourceProjectId: "source-project",
    },
    scope: {
      projectId: "neon-project",
      branchId: "neon-branch",
      endpointId: "neon-endpoint",
      hostname: "ep-fixture.neon.tech",
      maintenanceDatabase: "maintenance",
      maintenanceRole: "installer",
    },
  },
  worker: {
    id: "generic-installer",
    executablePath: "/trusted/generic-worker",
    sha256: "d".repeat(64),
    operationScope: "generated-app-release-install-v1",
    subcommand: "protected-generated-app-install",
  },
  cost: { ownership: "current-owner", description: "Separate app target" },
  retention: { policy: "Until approved cleanup" },
  conflictPolicy: "stop-on-conflict",
});
const planDigest = nativeTargetOnboardingPlanDigest(plan);
const toolInput = {
  appId: plan.appId,
  operationRef: nativeTargetOnboardingRegistryId(authority, plan.appId),
  planDigest,
  plan,
};
const requested = (
  input: {
    toolName?: string;
    callId?: string;
    toolInput?: typeof toolInput;
    requestId?: string;
  } = {},
): MessageStreamEvent => ({
  type: "input.requested",
  meta: { at: "2026-10-21T15:00:00.000Z", id: "requested-event" },
  data: {
    sequence: 1,
    stepIndex: 0,
    turnId: "turn-native-target",
    requests: [
      {
        kind: "tool-approval",
        requestId: input.requestId ?? "human-request",
        prompt: "Approve native target",
        action: {
          kind: "tool-call",
          toolName: input.toolName ?? "prepare-app-native-target",
          callId: input.callId ?? "prepare-call",
          input: input.toolInput ?? toolInput,
        },
      },
    ],
  },
});
const settled = (
  outcome: "approved" | "cancelled" = "approved",
  responderPrincipalId = authority.ownerUserId,
  requestId = "human-request",
): MessageStreamEvent => ({
  type: "approval.settled",
  meta: { at: "2026-10-21T15:00:01.000Z", id: "settled-event" },
  data: {
    sequence: 2,
    stepIndex: 0,
    turnId: "turn-native-target",
    requestId,
    responderPrincipalId,
    outcome,
  },
});

describe("conflicting native settlement capture", () => {
  it.each([false, true])(
    "fails closed on cancellation after approval (hydrated: %s)",
    (hydrate) => {
      const first = createPrivateHostedApprovalCapture(owner.publicSessionId);
      first.observe(requested());
      first.observe(settled());
      const capture = hydrate
        ? createPrivateHostedApprovalCapture(owner.publicSessionId, first.snapshot())
        : first;
      capture.observe(settled());
      expect(() => {
        capture.observe(settled("cancelled"));
      }).toThrow("conflicting native approval settlements");
      expect(() => capture.snapshot()).toThrow("conflicting native approval settlements");
      expect(() => capture.values()).toThrow("conflicting native approval settlements");
    },
  );

  it("rejects a conflicting responder and leaves unrelated settlements ignored", () => {
    const capture = createPrivateHostedApprovalCapture(owner.publicSessionId);
    capture.observe(requested());
    capture.observe(settled());
    capture.observe(settled("cancelled", authority.ownerUserId, "unrelated"));
    expect(capture.values()).toHaveLength(1);
    expect(() => {
      capture.observe(settled("approved", "foreign"));
    }).toThrow("conflicting native approval settlements");
  });
});
