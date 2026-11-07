import { describe, expect, it, vi } from "vitest";
import type { MessageStreamEvent } from "eve/client";

import {
  nativeTargetOnboardingPlanDigest,
  nativeTargetOnboardingPlanSchema,
  nativeTargetOnboardingRecordSchema,
  nativeTargetOnboardingRegistryId,
} from "../provisioning/native-target-onboarding-contract";
import type { NativeTargetCurrentOwner } from "../provisioning/native-target-onboarding-store";
import { operatorOwnerContextSchema } from "../provisioning/hosted-operator-contract";
import { HostedSessionReadTimeoutError } from "./hosted-session-read-timeout-error";
import {
  createPrivateNativeTargetApprovalCapture,
  readPrivateNativeTargetApproval,
} from "./private-native-target-approval";
import type { PrivateNativeTargetApprovalObservation } from "./private-native-target-approval";

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
const record = nativeTargetOnboardingRecordSchema.parse({
  appId: plan.appId,
  kind: "native-target-onboarding",
  plan,
  planDigest,
  previousAttempts: [],
  stage: "planned",
  version: 1,
});
const toolInput = {
  appId: plan.appId,
  operationRef: nativeTargetOnboardingRegistryId(authority, plan.appId),
  plan,
  planDigest,
};
const historyOwner = operatorOwnerContextSchema.parse({
  adapterGeneration: owner.adapterGeneration,
  adapterSessionId: owner.adapterSessionId,
  authority,
  kind: "direct",
  principal: { ...authority, scopes: ["autograph:send"] },
  sessionId: owner.publicSessionId,
});
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
const capture = () => createPrivateNativeTargetApprovalCapture({ owner, record });

describe("private native target terminal approval", () => {
  it("requires exact requested input and the owner's committed settlement", () => {
    const reader = capture();
    reader.observe(requested());
    expect(reader.read()).toBeNull();
    reader.observe(settled());
    expect(reader.read()).toEqual({
      callId: "prepare-call",
      observedAt: "2026-10-21T15:00:01.000Z",
      outcome: "approved",
      planDigest,
      publicSessionId: plan.origin.publicSessionId,
      requestId: "human-request",
      responderPrincipalId: authority.ownerUserId,
    });
  });

  it.each(["wrong tool", "wrong operation", "changed plan", "unmatched settlement"])(
    "keeps %s pending",
    (scenario) => {
      const reader = capture();
      if (scenario !== "unmatched settlement") {
        const changed = structuredClone(toolInput);
        if (scenario === "wrong operation") {
          changed.operationRef = "00000000-0000-4000-8000-000000000000";
        }
        if (scenario === "changed plan") {
          changed.plan.project.name = "other-project";
        }
        reader.observe(
          requested({
            toolInput: changed,
            toolName: scenario === "wrong tool" ? "plan-app-native-target" : undefined,
          }),
        );
      }
      reader.observe(settled());
      expect(reader.read()).toBeNull();
    },
  );

  it("does not reuse one invocation's approval for a different pending invocation", () => {
    const first = createPrivateNativeTargetApprovalCapture({ callId: "call-one", owner, record });
    const second = createPrivateNativeTargetApprovalCapture({ callId: "call-two", owner, record });
    for (const reader of [first, second]) {
      reader.observe(requested({ callId: "call-one", requestId: "request-one" }));
      reader.observe(requested({ callId: "call-two", requestId: "request-two" }));
      reader.observe(settled("approved", authority.ownerUserId, "request-one"));
    }
    expect(first.read()).toMatchObject({ outcome: "approved", requestId: "request-one" });
    expect(second.read()).toBeNull();
  });

  it("selects the current invocation from two approved calls without discarding either receipt", () => {
    const all = capture();
    for (const [requestId, callId] of [
      ["request-one", "call-one"],
      ["request-two", "call-two"],
    ]) {
      all.observe(requested({ callId, requestId }));
      all.observe(settled("approved", authority.ownerUserId, requestId));
    }
    all.proveComplete();
    expect(() => all.read()).toThrow("ambiguous");
    const current = createPrivateNativeTargetApprovalCapture({
      callId: "call-two",
      owner,
      record,
      state: all.snapshot(),
      terminals: all.terminalSnapshot(),
    });
    expect(current.read()).toMatchObject({ callId: "call-two", requestId: "request-two" });
    expect(current.snapshot().entries).toHaveLength(2);
  });

  it("keeps a prior invocation's cancellation dominant over a fresh approved invocation", () => {
    const current = createPrivateNativeTargetApprovalCapture({ callId: "call-two", owner, record });
    current.observe(requested({ callId: "call-one", requestId: "request-one" }));
    current.observe(settled("cancelled", authority.ownerUserId, "request-one"));
    current.observe(requested({ callId: "call-two", requestId: "request-two" }));
    current.observe(settled("approved", authority.ownerUserId, "request-two"));
    expect(current.read()).toMatchObject({
      callId: "call-one",
      outcome: "cancelled",
      requestId: "request-one",
    });
  });

  it("still rejects two approved requests for the same invocation", () => {
    const current = createPrivateNativeTargetApprovalCapture({ callId: "call-one", owner, record });
    for (const requestId of ["request-one", "request-two"]) {
      current.observe(requested({ callId: "call-one", requestId }));
      current.observe(settled("approved", authority.ownerUserId, requestId));
    }
    expect(() => current.read()).toThrow("ambiguous");
  });

  it("reads a saved partial batch as approved for the plan and pending for its unanswered call", async () => {
    const reader = capture();
    reader.observe(requested({ callId: "call-one", requestId: "request-one" }));
    reader.observe(requested({ callId: "call-two", requestId: "request-two" }));
    reader.observe(settled("approved", authority.ownerUserId, "request-one"));
    reader.proveComplete();
    const saved: PrivateNativeTargetApprovalObservation = {
      native: {
        adapterGeneration: owner.adapterGeneration,
        adapterSessionId: owner.adapterSessionId,
        capture: reader.snapshot(),
        nextNativeIndex: 3,
      },
      terminals: reader.terminalSnapshot(),
      version: 1,
    };
    const readHistory = vi.fn(async (start: number) => {
      expect(start).toBe(3);
      return { complete: true, nativeTailIndex: 2, nextNativeIndex: 3 };
    });
    const common = {
      assertOwner: async () => {},
      historyOwner,
      observation: { save: vi.fn(async () => {}), state: saved },
      owner,
      readHistory,
      record,
    };
    expect(await readPrivateNativeTargetApproval(common)).toEqual({
      proof: {
        callId: "call-one",
        observedAt: "2026-10-21T15:00:01.000Z",
        outcome: "approved",
        planDigest,
        publicSessionId: plan.origin.publicSessionId,
        requestId: "request-one",
        responderPrincipalId: authority.ownerUserId,
      },
      status: "approved",
    });
    expect(await readPrivateNativeTargetApproval({ ...common, callId: "call-two" })).toEqual({
      status: "pending",
    });
  });

  it("returns the original cancelled settlement proof, and never promotes a later approval", () => {
    const reader = capture();
    reader.observe(requested());
    reader.observe(settled("cancelled"));
    reader.observe(settled("approved"));
    expect(reader.read()).toMatchObject({
      observedAt: "2026-10-21T15:00:01.000Z",
      outcome: "cancelled",
      requestId: "human-request",
    });
  });

  it("refuses a foreign responder as terminal authority", () => {
    const reader = capture();
    reader.observe(requested());
    reader.observe(settled("approved", "foreign-user"));
    expect(() => reader.read()).toThrow("terminal proof is unavailable");
  });

  it("keeps the original public plan identity when the native stream belongs to a recovered child", () => {
    const childOwner = {
      ...owner,
      adapterGeneration: 2,
      adapterSessionId: "native-recovered-child",
      publicSessionId: "public-recovered-child",
    };
    const reader = createPrivateNativeTargetApprovalCapture({ owner: childOwner, record });
    reader.observe(requested());
    reader.observe(settled());
    expect(reader.read()?.publicSessionId).toBe(plan.origin.publicSessionId);
  });

  it.each(["approved", "cancelled"] as const)(
    "saves partial %s terminal proof and resumes with the original timestamp",
    async (outcome) => {
      let state: PrivateNativeTargetApprovalObservation | undefined;
      const save = vi.fn(async (next: PrivateNativeTargetApprovalObservation) => {
        state = structuredClone(next);
      });
      const base = {
        assertOwner: async () => {},
        historyOwner,
        owner,
        record,
      };
      await expect(
        readPrivateNativeTargetApproval({
          ...base,
          observation: { save },
          readHistory: async (_start, onEvent) => {
            onEvent(requested());
            onEvent(settled(outcome));
            return { complete: false, nativeTailIndex: 2, nextNativeIndex: 2 };
          },
        }),
      ).rejects.toBeInstanceOf(HostedSessionReadTimeoutError);
      expect(state?.terminals).toMatchObject([
        {
          observedAt: "2026-10-21T15:00:01.000Z",
          requestId: "human-request",
        },
      ]);
      expect(state?.native.capture.entries).toMatchObject([
        outcome === "approved"
          ? { approved: true, completedApproved: false }
          : { cancelled: true, completedCancelled: false },
      ]);
      const result = await readPrivateNativeTargetApproval({
        ...base,
        observation: { save, state },
        readHistory: async (start) => {
          expect(start).toBe(2);
          return { complete: true, nativeTailIndex: 1, nextNativeIndex: 2 };
        },
      });
      expect(result).toMatchObject({
        proof: { observedAt: "2026-10-21T15:00:01.000Z", outcome, requestId: "human-request" },
        status: outcome,
      });
    },
  );

  it("does not pair an old unproved request with a new adapter settlement", async () => {
    let state: PrivateNativeTargetApprovalObservation | undefined;
    const save = async (next: PrivateNativeTargetApprovalObservation) => {
      state = structuredClone(next);
    };
    await expect(
      readPrivateNativeTargetApproval({
        assertOwner: async () => {},
        historyOwner,
        observation: { save },
        owner,
        readHistory: async (_start, onEvent) => {
          onEvent(requested());
          return { complete: false, nativeTailIndex: 2, nextNativeIndex: 1 };
        },
        record,
      }),
    ).rejects.toBeInstanceOf(HostedSessionReadTimeoutError);
    const replacement = operatorOwnerContextSchema.parse({
      ...historyOwner,
      adapterGeneration: 2,
      adapterSessionId: "native-replacement",
    });
    expect(
      await readPrivateNativeTargetApproval({
        assertOwner: async () => {},
        historyOwner: replacement,
        observation: { save, state },
        owner: { ...owner, adapterGeneration: 2, adapterSessionId: replacement.adapterSessionId },
        readHistory: async (start, onEvent) => {
          expect(start).toBe(0);
          onEvent(settled());
          return { complete: true, nativeTailIndex: 0, nextNativeIndex: 1 };
        },
        record,
      }),
    ).toEqual({ status: "pending" });
  });
});
