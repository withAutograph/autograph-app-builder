import { readPrivateOperatorApproval } from "./private-operator-approval-observation";
import { operatorOwnerContextSchema } from "../provisioning/hosted-operator-contract";
import { HostedSessionReadTimeoutError } from "./hosted-session-read-timeout-error";
import type { PrivateOperatorApprovalObservation } from "./private-operator-approval-observation";
import type { MessageStreamEvent } from "eve/client";
import { describe, expect, it, vi } from "vitest";
import {
  createPrivateTenantExportApprovalCapture,
  tenantExportApprovalInputSchema,
} from "./private-export-approval";
import {
  hostedTenantExportPlanSchema,
  tenantExportPlanDigest,
  tenantExportWireFixtureSchema,
} from "../provisioning/hosted-operator-export-contract";
import wire from "../provisioning/fixtures/tenant-export-wire-v1.json";
import { publicApprovalDescription } from "../agent/approval-receipt";

const fixture = tenantExportWireFixtureSchema.parse(wire);
const authority = {
  audience: "https://builder.test/mcp",
  issuer: "https://builder.test/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const plan = hostedTenantExportPlanSchema.parse({
  authority,
  destination: {
    artifactPrefix: `_protected-operator/artifacts/tenant-export/${fixture.worker.exportId}`,
    kind: "owner-private-builder-artifact",
  },
  exportId: fixture.worker.exportId,
  format: fixture.worker.format,
  kind: "tenant-export-plan",
  originalSetup: {
    approvalId: "setup-approval",
    approvedByCallId: "setup-call",
    operationRef: "40000000-0000-4000-8000-000000000004",
    planDigest: "a".repeat(64),
  },
  planRef: `_protected-operator/export-plans/${fixture.worker.exportId}`,
  release: fixture.worker.release,
  resource: fixture.worker.resource,
  scope: fixture.worker.scope,
  selection: fixture.worker.selection,
  target: {
    appId: fixture.worker.scope.appId,
    branch: "preview",
    projectId: "project",
    sessionId: "session",
  },
  version: 1,
});
const request = {
  action: "export" as const,
  idempotencyKey: "original-request",
  planDigest: tenantExportPlanDigest(plan),
  planRef: plan.planRef,
};
const input = { ...request, plan };
const requested = (
  options: { toolName?: string; callId?: string; toolInput?: typeof input } = {},
): MessageStreamEvent => ({
  data: {
    requests: [
      {
        action: {
          callId: options.callId ?? "export-call",
          input: options.toolInput ?? input,
          kind: "tool-call",
          toolName: options.toolName ?? "export-app-hosted-data",
        },
        kind: "tool-approval",
        prompt: "Approve this export",
        requestId: "human-request",
      },
    ],
    sequence: 1,
    stepIndex: 0,
    turnId: "turn",
  },
  meta: { at: "2026-10-20T00:00:00Z", id: "request-event" },
  type: "input.requested",
});
const settled = (
  owner = "owner",
  outcome: "approved" | "cancelled" = "approved",
): MessageStreamEvent => ({
  data: {
    outcome,
    requestId: "human-request",
    responderPrincipalId: owner,
    sequence: 2,
    stepIndex: 0,
    turnId: "turn",
  },
  meta: { at: "2026-10-20T00:00:01Z", id: "settled-event" },
  type: "approval.settled",
});
const capture = () =>
  createPrivateTenantExportApprovalCapture({
    callId: "export-call",
    plan,
    principal: { ...authority, scopes: ["autograph:send"] },
    request,
  });
describe("native private tenant export approval", () => {
  it("requires the exact authored request plus authenticated human settlement", () => {
    const reader = capture();
    reader.observe(requested());
    expect(reader.read()).toBeNull();
    reader.observe(settled());
    expect(reader.read()).toEqual({
      ...request,
      approvalId: "human-request",
      approvedByCallId: "export-call",
    });
  });
  it.each([
    "foreign owner",
    "cancelled",
    "wrong tool",
    "wrong call",
    "changed scope",
    "changed destination",
  ])("refuses %s", (failure) => {
    const reader = capture();
    const changed = structuredClone(input);
    if (failure === "changed scope") {
      changed.plan.scope.customerId = "other";
    }
    if (failure === "changed destination") {
      changed.plan.destination.artifactPrefix += "/other";
    }
    reader.observe(
      requested({
        callId: failure === "wrong call" ? "other-call" : undefined,
        toolInput: changed,
        toolName: failure === "wrong tool" ? "prepare-app-hosted-runtime" : undefined,
      }),
    );
    reader.observe(
      settled(
        failure === "foreign owner" ? "foreign" : "owner",
        failure === "cancelled" ? "cancelled" : "approved",
      ),
    );
    expect(reader.read()).toBeNull();
  });
  it("does not infer authority from an unmatched settlement", () => {
    const reader = capture();
    reader.observe(settled());
    expect(reader.read()).toBeNull();
  });
  it("names exact scope and destination on the ordinary human card", () => {
    expect(tenantExportApprovalInputSchema.parse(input)).toEqual(input);
    const description = publicApprovalDescription(input, "export-app-hosted-data");
    expect(description).toContain("private review");
    expect(description).toContain(plan.scope.customerId);
    expect(description).toContain("private to you in this session");
  });
});

describe("resumable export approval capture", () => {
  const options = { plan, principal: { ...authority, scopes: ["autograph:send"] }, request };
  it("retains a pending exact-intent pair across readers and filters the requested call", () => {
    const prefix = createPrivateTenantExportApprovalCapture(options);
    prefix.observe(requested());
    const resumed = createPrivateTenantExportApprovalCapture({
      ...options,
      callId: "export-call",
      state: prefix.snapshot(),
    });
    resumed.observe(settled());
    expect(resumed.read()).toMatchObject({
      approvalId: "human-request",
      approvedByCallId: "export-call",
    });
    expect(
      createPrivateTenantExportApprovalCapture({
        ...options,
        callId: "another-call",
        state: resumed.snapshot(),
      }).read(),
    ).toBeNull();
  });
  it("preserves cancellation across hydration and rejects a different owner/intent", () => {
    const prefix = createPrivateTenantExportApprovalCapture(options);
    prefix.observe(requested());
    const resumed = createPrivateTenantExportApprovalCapture({
      ...options,
      state: prefix.snapshot(),
    });
    resumed.observe(settled("owner", "cancelled"));
    const cancelled = createPrivateTenantExportApprovalCapture({
      ...options,
      state: resumed.snapshot(),
    });
    cancelled.observe(settled());
    expect(cancelled.read()).toBeNull();
    expect(() =>
      createPrivateTenantExportApprovalCapture({
        ...options,
        principal: { ...options.principal, ownerUserId: "foreign" },
        state: resumed.snapshot(),
      }),
    ).toThrow();
    expect(() =>
      createPrivateTenantExportApprovalCapture({
        ...options,
        request: { ...request, idempotencyKey: "different" },
        state: resumed.snapshot(),
      }),
    ).toThrow();
    expect(() =>
      createPrivateTenantExportApprovalCapture({
        ...options,
        plan: { ...plan, scope: { ...plan.scope, customerId: "foreign-customer" } },
        state: resumed.snapshot(),
      }),
    ).toThrow();
  });
});

describe("approval history binding and cancellation", () => {
  const owner = operatorOwnerContextSchema.parse({
    adapterGeneration: 1,
    adapterSessionId: "native-original",
    authority,
    kind: "direct",
    principal: { ...authority, scopes: ["autograph:send"] },
    sessionId: plan.target.sessionId,
  });
  const options = { plan, principal: owner.principal, request };
  const binding = {
    adapterGeneration: owner.adapterGeneration,
    adapterSessionId: owner.adapterSessionId,
  };
  it.each([false, true])(
    "restarts a replacement adapter without pairing old pending requests, preserving proved settlement=%s",
    async (proved) => {
      const prefix = createPrivateTenantExportApprovalCapture(options);
      prefix.observe(requested());
      if (proved) {
        prefix.observe(settled());
        prefix.proveComplete();
      }
      const save = vi.fn(async () => {});
      const history = vi.fn(
        async (startIndex: number, onEvent: (event: MessageStreamEvent) => void) => {
          expect(startIndex).toBe(0);
          onEvent(settled());
          return { complete: true, nativeTailIndex: 0, nextNativeIndex: 1 };
        },
      );
      const receipt = await readPrivateOperatorApproval({
        assertOwner: async () => {},
        capture: (state) => createPrivateTenantExportApprovalCapture({ ...options, state }),
        observation: {
          save,
          state: { ...binding, capture: prefix.snapshot(), nextNativeIndex: 500 },
        },
        owner: { ...owner, adapterGeneration: 2, adapterSessionId: "native-replacement" },
        readHistory: history,
      });
      expect(receipt?.approvalId ?? null).toBe(proved ? "human-request" : null);
      expect(save).toHaveBeenCalledTimes(proved ? 0 : 1);
    },
  );
  it("does not promote a partial approval when replacement hides the unread old cancellation", async () => {
    const oldTail = [requested(), settled(), settled("owner", "cancelled")];
    let checkpoint: PrivateOperatorApprovalObservation | undefined;
    const save = async (value: PrivateOperatorApprovalObservation) => {
      checkpoint = structuredClone(value);
      return;
    };
    const shared = {
      assertOwner: async () => {},
      capture: (state?: Parameters<typeof createPrivateTenantExportApprovalCapture>[0]["state"]) =>
        createPrivateTenantExportApprovalCapture({ ...options, state }),
      owner,
    };
    await expect(
      readPrivateOperatorApproval({
        ...shared,
        observation: { save },
        readHistory: async (start, onEvent) => {
          expect(start).toBe(0);
          for (const event of oldTail.slice(0, 2)) {
            onEvent(event);
          }
          return {
            complete: false,
            nativeTailIndex: oldTail.length - 1,
            nextNativeIndex: 2,
          };
        },
      }),
    ).rejects.toBeInstanceOf(HostedSessionReadTimeoutError);
    expect(checkpoint?.capture.entries[0]).toMatchObject({
      approved: true,
      completedApproved: false,
    });
    const result = await readPrivateOperatorApproval({
      ...shared,
      observation: { save, state: checkpoint },
      owner: { ...owner, adapterGeneration: 2, adapterSessionId: "replacement" },
      readHistory: async (start) => {
        expect(start).toBe(0);
        return { complete: true, nativeTailIndex: -1, nextNativeIndex: 0 };
      },
    });
    expect(result).toBeNull();
    expect(checkpoint?.capture.entries).toEqual([]);
  });
  it("retains a prior complete cancellation through a later partial read and replacement", async () => {
    let checkpoint: PrivateOperatorApprovalObservation | undefined;
    const save = async (value: PrivateOperatorApprovalObservation) => {
      checkpoint = structuredClone(value);
      return;
    };
    const shared = {
      assertOwner: async () => {},
      capture: (state?: Parameters<typeof createPrivateTenantExportApprovalCapture>[0]["state"]) =>
        createPrivateTenantExportApprovalCapture({ ...options, state }),
      owner,
    };
    await readPrivateOperatorApproval({
      ...shared,
      observation: { save },
      readHistory: async (_start, onEvent) => {
        onEvent(requested());
        onEvent(settled("owner", "cancelled"));
        return { complete: true, nativeTailIndex: 1, nextNativeIndex: 2 };
      },
    });
    expect(checkpoint?.capture.entries[0]?.completedCancelled).toBe(true);
    const pending = requested({ callId: "second-call" });
    if (pending.type === "input.requested") {
      for (const item of pending.data.requests) {
        item.requestId = "second-request";
      }
    }
    const approved = settled();
    if (approved.type === "approval.settled") {
      approved.data.requestId = "second-request";
    }
    await expect(
      readPrivateOperatorApproval({
        ...shared,
        observation: { save, state: checkpoint },
        readHistory: async (start, onEvent) => {
          expect(start).toBe(2);
          onEvent(pending);
          onEvent(approved);
          return { complete: false, nativeTailIndex: 4, nextNativeIndex: 4 };
        },
      }),
    ).rejects.toBeInstanceOf(HostedSessionReadTimeoutError);
    await expect(
      readPrivateOperatorApproval({
        ...shared,
        observation: { save, state: checkpoint },
        readHistory: async (start, onEvent) => {
          expect(start).toBe(4);
          onEvent(requested({ toolName: "unrelated-tool" }));
          return { complete: false, nativeTailIndex: 5, nextNativeIndex: 5 };
        },
      }),
    ).rejects.toBeInstanceOf(HostedSessionReadTimeoutError);
    const result = await readPrivateOperatorApproval({
      ...shared,
      observation: { save, state: checkpoint },
      owner: { ...owner, adapterGeneration: 2, adapterSessionId: "replacement" },
      readHistory: async (start) => {
        expect(start).toBe(0);
        return { complete: true, nativeTailIndex: -1, nextNativeIndex: 0 };
      },
    });
    expect(result).toBeNull();
    expect(checkpoint?.capture.entries).toHaveLength(1);
    expect(checkpoint?.capture.entries[0]).toMatchObject({
      cancelled: true,
      completedCancelled: true,
      requestId: "human-request",
    });
  });
  it.each([false, true])(
    "keeps partial cancellation sticky after a prior completed approval and replacement, other request=%s",
    async (otherRequest) => {
      let checkpoint: PrivateOperatorApprovalObservation | undefined;
      const save = async (value: PrivateOperatorApprovalObservation) => {
        checkpoint = structuredClone(value);
        return;
      };
      const shared = {
        assertOwner: async () => {},
        capture: (
          state?: Parameters<typeof createPrivateTenantExportApprovalCapture>[0]["state"],
        ) =>
          createPrivateTenantExportApprovalCapture({
            ...options,
            callId: "waiting-for-other-call",
            state,
          }),
        owner,
      };
      // A complete historical approval is retained, but does not authorize the different requested call.
      expect(
        await readPrivateOperatorApproval({
          ...shared,
          observation: { save },
          readHistory: async (_start, onEvent) => {
            onEvent(requested());
            onEvent(settled());
            return { complete: true, nativeTailIndex: 1, nextNativeIndex: 2 };
          },
        }),
      ).toBeNull();
      expect(checkpoint?.capture.entries[0]?.completedApproved).toBe(true);
      const cancelled = settled("owner", "cancelled");
      const pending = requested({ callId: "another-cancelled-call" });
      if (otherRequest) {
        if (pending.type === "input.requested") {
          for (const item of pending.data.requests) {
            item.requestId = "another-request";
          }
        }
        if (cancelled.type === "approval.settled") {
          cancelled.data.requestId = "another-request";
        }
      }
      await expect(
        readPrivateOperatorApproval({
          ...shared,
          observation: { save, state: checkpoint },
          readHistory: async (start, onEvent) => {
            expect(start).toBe(2);
            if (otherRequest) {
              onEvent(pending);
            }
            onEvent(cancelled);
            return {
              complete: false,
              nativeTailIndex: 4,
              nextNativeIndex: otherRequest ? 4 : 3,
            };
          },
        }),
      ).rejects.toBeInstanceOf(HostedSessionReadTimeoutError);
      const receipt = await readPrivateOperatorApproval({
        ...shared,
        capture: (state) =>
          createPrivateTenantExportApprovalCapture({
            ...options,
            ...(otherRequest ? {} : { callId: "export-call" }),
            state,
          }),
        observation: { save, state: checkpoint },
        owner: { ...owner, adapterGeneration: 2, adapterSessionId: "replacement" },
        readHistory: async (start) => {
          expect(start).toBe(0);
          return { complete: true, nativeTailIndex: -1, nextNativeIndex: 0 };
        },
      });
      expect(receipt).toBeNull();
      expect(checkpoint?.capture.entries.some((entry) => entry.cancelled)).toBe(true);
      if (otherRequest) {
        const unaffected = await readPrivateOperatorApproval({
          ...shared,
          capture: (state) =>
            createPrivateTenantExportApprovalCapture({ ...options, callId: "export-call", state }),
          observation: { save, state: checkpoint },
          owner: { ...owner, adapterGeneration: 2, adapterSessionId: "replacement" },
          readHistory: async (start) => {
            expect(start).toBe(0);
            return { complete: true, nativeTailIndex: -1, nextNativeIndex: 0 };
          },
        });
        expect(unaffected?.approvalId).toBe("human-request");
      }
    },
  );
  it("does not grant an approval from a partial tail before a later cancellation", async () => {
    let checkpoint: PrivateOperatorApprovalObservation | undefined;
    const save = async (value: PrivateOperatorApprovalObservation) => {
      checkpoint = structuredClone(value);
      return;
    };
    const shared = {
      assertOwner: async () => {},
      capture: (state?: Parameters<typeof createPrivateTenantExportApprovalCapture>[0]["state"]) =>
        createPrivateTenantExportApprovalCapture({ ...options, state }),
      owner,
    };
    await expect(
      readPrivateOperatorApproval({
        ...shared,
        observation: { save },
        readHistory: async (_start, onEvent) => {
          onEvent(requested());
          onEvent(settled());
          return { complete: false, nativeTailIndex: 2, nextNativeIndex: 2 };
        },
      }),
    ).rejects.toBeInstanceOf(HostedSessionReadTimeoutError);
    expect(checkpoint?.nextNativeIndex).toBe(2);
    const result = await readPrivateOperatorApproval({
      ...shared,
      observation: { save, state: checkpoint },
      readHistory: async (start, onEvent) => {
        expect(start).toBe(2);
        onEvent(settled("owner", "cancelled"));
        return { complete: true, nativeTailIndex: 2, nextNativeIndex: 3 };
      },
    });
    expect(result).toBeNull();
    expect(checkpoint?.capture.entries[0]?.cancelled).toBe(true);
  });
});

it("rechecks a quiet native tail without rewriting unchanged approval progress", async () => {
  const principal = { ...authority, scopes: ["autograph:send"] };
  const owner = operatorOwnerContextSchema.parse({
    adapterGeneration: 1,
    adapterSessionId: "native",
    authority,
    kind: "direct",
    principal,
    sessionId: plan.target.sessionId,
  });
  let checkpoint: PrivateOperatorApprovalObservation | undefined;
  const save = vi.fn(async (value: PrivateOperatorApprovalObservation) => {
    checkpoint = structuredClone(value);
    return;
  });
  const assertOwner = vi.fn(async () => {});
  const readHistory = vi.fn(async () => ({
    complete: true,
    nativeTailIndex: -1,
    nextNativeIndex: 0,
  }));
  const read = async () =>
    await readPrivateOperatorApproval({
      assertOwner,
      capture: (state) =>
        createPrivateTenantExportApprovalCapture({ plan, principal, request, state }),
      observation: { save, state: checkpoint },
      owner,
      readHistory,
    });
  expect(await read()).toBeNull();
  expect(await read()).toBeNull();
  expect(save).toHaveBeenCalledTimes(1);
  expect(assertOwner).toHaveBeenCalledTimes(2);
  expect(readHistory).toHaveBeenCalledTimes(2);
});
