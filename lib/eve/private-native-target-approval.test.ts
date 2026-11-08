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
      artifactRef: "artifact-original",
      id: "release-original",
      manifestSha256: "b".repeat(64),
      schemaSha256: "c".repeat(64),
    },
  },
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
  branch: "main",
  appDatabase: {
    database: "requests_data",
    migratorRole: "requests_migrator",
    resourceId: "requests-resource",
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
      branchId: "neon-branch",
      endpointId: "neon-endpoint",
      hostname: "ep-fixture.neon.tech",
      maintenanceDatabase: "maintenance",
      maintenanceRole: "installer",
      projectId: "neon-project",
    },
  },
  worker: {
    executablePath: "/trusted/generic-worker",
    id: "generic-installer",
    operationScope: "generated-app-release-install-v1",
    sha256: "d".repeat(64),
    subcommand: "protected-generated-app-install",
  },
  cost: { description: "Separate app target", ownership: "current-owner" },
  retention: { policy: "Until approved cleanup" },
  conflictPolicy: "stop-on-conflict",
});
const planDigest = nativeTargetOnboardingPlanDigest(plan);
const record = nativeTargetOnboardingRecordSchema.parse({
  kind: "native-target-onboarding",
  version: 1,
  stage: "planned",
  appId: plan.appId,
  plan,
  planDigest,
  previousAttempts: [],
});
const toolInput = {
  appId: plan.appId,
  operationRef: nativeTargetOnboardingRegistryId(authority, plan.appId),
  planDigest,
  plan,
};
const historyOwner = operatorOwnerContextSchema.parse({
  kind: "direct",
  authority,
  principal: { ...authority, scopes: ["autograph:send"] },
  sessionId: owner.publicSessionId,
  adapterSessionId: owner.adapterSessionId,
  adapterGeneration: owner.adapterGeneration,
});
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
const capture = () => createPrivateNativeTargetApprovalCapture({ owner, record });

describe("private native target terminal approval", () => {
  it("requires exact requested input and the owner's committed settlement", () => {
    const reader = capture();
    reader.observe(requested());
    expect(reader.read()).toBeNull();
    reader.observe(settled());
    expect(reader.read()).toEqual({
      requestId: "human-request",
      callId: "prepare-call",
      planDigest,
      responderPrincipalId: authority.ownerUserId,
      publicSessionId: plan.origin.publicSessionId,
      outcome: "approved",
      observedAt: "2026-10-21T15:00:01.000Z",
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
            toolName: scenario === "wrong tool" ? "plan-app-native-target" : undefined,
            toolInput: changed,
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
      owner,
      record,
      callId: "call-two",
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
      version: 1,
      native: {
        adapterSessionId: owner.adapterSessionId,
        adapterGeneration: owner.adapterGeneration,
        nextNativeIndex: 3,
        capture: reader.snapshot(),
      },
      terminals: reader.terminalSnapshot(),
    };
    const readHistory = vi.fn((start: number) => {
      expect(start).toBe(3);
      return Promise.resolve({ complete: true, nativeTailIndex: 2, nextNativeIndex: 3 });
    });
    const common = {
      owner,
      record,
      historyOwner,
      observation: { state: saved, save: vi.fn<() => Promise<void>>().mockResolvedValue() },
      readHistory,
      assertOwner: () => Promise.resolve(),
    };
    expect(await readPrivateNativeTargetApproval(common)).toEqual({
      status: "approved",
      proof: {
        requestId: "request-one",
        callId: "call-one",
        planDigest,
        responderPrincipalId: authority.ownerUserId,
        publicSessionId: plan.origin.publicSessionId,
        outcome: "approved",
        observedAt: "2026-10-21T15:00:01.000Z",
      },
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
      publicSessionId: "public-recovered-child",
      adapterSessionId: "native-recovered-child",
      adapterGeneration: 2,
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
      const save = vi.fn((next: PrivateNativeTargetApprovalObservation) => {
        state = structuredClone(next);
        return Promise.resolve();
      });
      const base = {
        owner,
        record,
        historyOwner,
        assertOwner: () => Promise.resolve(),
      };
      await expect(
        readPrivateNativeTargetApproval({
          ...base,
          observation: { save },
          readHistory: (_start, onEvent) => {
            onEvent(requested());
            onEvent(settled(outcome));
            return Promise.resolve({ complete: false, nativeTailIndex: 2, nextNativeIndex: 2 });
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
        observation: { state, save },
        readHistory: (start) => {
          expect(start).toBe(2);
          return Promise.resolve({ complete: true, nativeTailIndex: 1, nextNativeIndex: 2 });
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
    const save = (next: PrivateNativeTargetApprovalObservation) => {
      state = structuredClone(next);
      return Promise.resolve();
    };
    await expect(
      readPrivateNativeTargetApproval({
        owner,
        record,
        historyOwner,
        observation: { save },
        assertOwner: () => Promise.resolve(),
        readHistory: (_start, onEvent) => {
          onEvent(requested());
          return Promise.resolve({ complete: false, nativeTailIndex: 2, nextNativeIndex: 1 });
        },
      }),
    ).rejects.toBeInstanceOf(HostedSessionReadTimeoutError);
    const replacement = operatorOwnerContextSchema.parse({
      ...historyOwner,
      adapterSessionId: "native-replacement",
      adapterGeneration: 2,
    });
    expect(
      await readPrivateNativeTargetApproval({
        owner: { ...owner, adapterSessionId: replacement.adapterSessionId, adapterGeneration: 2 },
        record,
        historyOwner: replacement,
        observation: { state, save },
        assertOwner: () => Promise.resolve(),
        readHistory: (start, onEvent) => {
          expect(start).toBe(0);
          onEvent(settled());
          return Promise.resolve({ complete: true, nativeTailIndex: 0, nextNativeIndex: 1 });
        },
      }),
    ).toEqual({ status: "pending" });
  });
});
