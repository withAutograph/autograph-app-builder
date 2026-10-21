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
  issuer: "https://builder.test/api/auth",
  audience: "https://builder.test/mcp",
  workspaceId: "workspace",
  ownerUserId: "owner",
};
const plan = hostedTenantExportPlanSchema.parse({
  version: 1,
  kind: "tenant-export-plan",
  exportId: fixture.worker.exportId,
  planRef: `_protected-operator/export-plans/${fixture.worker.exportId}`,
  authority,
  target: {
    sessionId: "session",
    appId: fixture.worker.scope.appId,
    projectId: "project",
    branch: "preview",
  },
  originalSetup: {
    operationRef: "40000000-0000-4000-8000-000000000004",
    planDigest: "a".repeat(64),
    approvalId: "setup-approval",
    approvedByCallId: "setup-call",
  },
  scope: fixture.worker.scope,
  resource: fixture.worker.resource,
  release: fixture.worker.release,
  selection: fixture.worker.selection,
  format: fixture.worker.format,
  destination: {
    kind: "owner-private-builder-artifact",
    artifactPrefix: `_protected-operator/artifacts/tenant-export/${fixture.worker.exportId}`,
  },
});
const request = {
  action: "export" as const,
  planRef: plan.planRef,
  planDigest: tenantExportPlanDigest(plan),
  idempotencyKey: "original-request",
};
const input = { ...request, plan };
const requested = (
  options: { toolName?: string; callId?: string; toolInput?: typeof input } = {},
): MessageStreamEvent => ({
  type: "input.requested",
  meta: { at: "2026-10-20T00:00:00Z", id: "request-event" },
  data: {
    sequence: 1,
    stepIndex: 0,
    turnId: "turn",
    requests: [
      {
        kind: "tool-approval",
        requestId: "human-request",
        prompt: "Approve this export",
        action: {
          kind: "tool-call",
          toolName: options.toolName ?? "export-app-hosted-data",
          callId: options.callId ?? "export-call",
          input: options.toolInput ?? input,
        },
      },
    ],
  },
});
const settled = (
  owner = "owner",
  outcome: "approved" | "cancelled" = "approved",
): MessageStreamEvent => ({
  type: "approval.settled",
  meta: { at: "2026-10-20T00:00:01Z", id: "settled-event" },
  data: {
    sequence: 2,
    stepIndex: 0,
    turnId: "turn",
    requestId: "human-request",
    responderPrincipalId: owner,
    outcome,
  },
});
const capture = () =>
  createPrivateTenantExportApprovalCapture({
    plan,
    request,
    principal: { ...authority, scopes: ["autograph:send"] },
    callId: "export-call",
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
        toolName: failure === "wrong tool" ? "prepare-app-hosted-runtime" : undefined,
        callId: failure === "wrong call" ? "other-call" : undefined,
        toolInput: changed,
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
    expect(description).toContain(plan.scope.customerId);
    expect(description).toContain(plan.resource.database);
    expect(description).toContain(plan.release.id);
    expect(description).toContain("privately on Builder");
  });
});

describe("resumable export approval capture", () => {
  const options = { plan, request, principal: { ...authority, scopes: ["autograph:send"] } };
  it("retains a pending exact-intent pair across readers and filters the requested call", () => {
    const prefix = createPrivateTenantExportApprovalCapture(options);
    prefix.observe(requested());
    const resumed = createPrivateTenantExportApprovalCapture({
      ...options,
      state: prefix.snapshot(),
      callId: "export-call",
    });
    resumed.observe(settled());
    expect(resumed.read()).toMatchObject({
      approvalId: "human-request",
      approvedByCallId: "export-call",
    });
    expect(
      createPrivateTenantExportApprovalCapture({
        ...options,
        state: resumed.snapshot(),
        callId: "another-call",
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
    kind: "direct",
    authority,
    principal: { ...authority, scopes: ["autograph:send"] },
    sessionId: plan.target.sessionId,
    adapterSessionId: "native-original",
    adapterGeneration: 1,
  });
  const options = { plan, request, principal: owner.principal };
  const binding = {
    adapterSessionId: owner.adapterSessionId,
    adapterGeneration: owner.adapterGeneration,
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
      const save = vi.fn(() => Promise.resolve());
      const history = vi.fn((startIndex: number, onEvent: (event: MessageStreamEvent) => void) => {
        expect(startIndex).toBe(0);
        onEvent(settled());
        return Promise.resolve({ nextNativeIndex: 1, nativeTailIndex: 0, complete: true });
      });
      const receipt = await readPrivateOperatorApproval({
        owner: { ...owner, adapterSessionId: "native-replacement", adapterGeneration: 2 },
        observation: {
          state: { ...binding, nextNativeIndex: 500, capture: prefix.snapshot() },
          save,
        },
        capture: (state) => createPrivateTenantExportApprovalCapture({ ...options, state }),
        assertOwner: () => Promise.resolve(),
        readHistory: history,
      });
      expect(receipt?.approvalId ?? null).toBe(proved ? "human-request" : null);
      expect(save).toHaveBeenCalledTimes(proved ? 0 : 1);
    },
  );
  it("does not promote a partial approval when replacement hides the unread old cancellation", async () => {
    const oldTail = [requested(), settled(), settled("owner", "cancelled")];
    let checkpoint: PrivateOperatorApprovalObservation | undefined;
    const save = (value: PrivateOperatorApprovalObservation) => {
      checkpoint = structuredClone(value);
      return Promise.resolve();
    };
    const shared = {
      owner,
      capture: (state?: Parameters<typeof createPrivateTenantExportApprovalCapture>[0]["state"]) =>
        createPrivateTenantExportApprovalCapture({ ...options, state }),
      assertOwner: () => Promise.resolve(),
    };
    await expect(
      readPrivateOperatorApproval({
        ...shared,
        observation: { save },
        readHistory: (start, onEvent) => {
          expect(start).toBe(0);
          for (const event of oldTail.slice(0, 2)) {
            onEvent(event);
          }
          return Promise.resolve({
            nextNativeIndex: 2,
            nativeTailIndex: oldTail.length - 1,
            complete: false,
          });
        },
      }),
    ).rejects.toBeInstanceOf(HostedSessionReadTimeoutError);
    expect(checkpoint?.capture.entries[0]).toMatchObject({
      approved: true,
      completedApproved: false,
    });
    const result = await readPrivateOperatorApproval({
      ...shared,
      owner: { ...owner, adapterSessionId: "replacement", adapterGeneration: 2 },
      observation: { state: checkpoint, save },
      readHistory: (start) => {
        expect(start).toBe(0);
        return Promise.resolve({ nextNativeIndex: 0, nativeTailIndex: -1, complete: true });
      },
    });
    expect(result).toBeNull();
    expect(checkpoint?.capture.entries).toEqual([]);
  });
  it("retains a prior complete cancellation through a later partial read and replacement", async () => {
    let checkpoint: PrivateOperatorApprovalObservation | undefined;
    const save = (value: PrivateOperatorApprovalObservation) => {
      checkpoint = structuredClone(value);
      return Promise.resolve();
    };
    const shared = {
      owner,
      capture: (state?: Parameters<typeof createPrivateTenantExportApprovalCapture>[0]["state"]) =>
        createPrivateTenantExportApprovalCapture({ ...options, state }),
      assertOwner: () => Promise.resolve(),
    };
    await readPrivateOperatorApproval({
      ...shared,
      observation: { save },
      readHistory: (_start, onEvent) => {
        onEvent(requested());
        onEvent(settled("owner", "cancelled"));
        return Promise.resolve({ nextNativeIndex: 2, nativeTailIndex: 1, complete: true });
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
        observation: { state: checkpoint, save },
        readHistory: (start, onEvent) => {
          expect(start).toBe(2);
          onEvent(pending);
          onEvent(approved);
          return Promise.resolve({ nextNativeIndex: 4, nativeTailIndex: 4, complete: false });
        },
      }),
    ).rejects.toBeInstanceOf(HostedSessionReadTimeoutError);
    await expect(
      readPrivateOperatorApproval({
        ...shared,
        observation: { state: checkpoint, save },
        readHistory: (start, onEvent) => {
          expect(start).toBe(4);
          onEvent(requested({ toolName: "unrelated-tool" }));
          return Promise.resolve({ nextNativeIndex: 5, nativeTailIndex: 5, complete: false });
        },
      }),
    ).rejects.toBeInstanceOf(HostedSessionReadTimeoutError);
    const result = await readPrivateOperatorApproval({
      ...shared,
      owner: { ...owner, adapterSessionId: "replacement", adapterGeneration: 2 },
      observation: { state: checkpoint, save },
      readHistory: (start) => {
        expect(start).toBe(0);
        return Promise.resolve({ nextNativeIndex: 0, nativeTailIndex: -1, complete: true });
      },
    });
    expect(result).toBeNull();
    expect(checkpoint?.capture.entries).toHaveLength(1);
    expect(checkpoint?.capture.entries[0]).toMatchObject({
      requestId: "human-request",
      cancelled: true,
      completedCancelled: true,
    });
  });
  it.each([false, true])(
    "keeps partial cancellation sticky after a prior completed approval and replacement, other request=%s",
    async (otherRequest) => {
      let checkpoint: PrivateOperatorApprovalObservation | undefined;
      const save = (value: PrivateOperatorApprovalObservation) => {
        checkpoint = structuredClone(value);
        return Promise.resolve();
      };
      const shared = {
        owner,
        assertOwner: () => Promise.resolve(),
        capture: (
          state?: Parameters<typeof createPrivateTenantExportApprovalCapture>[0]["state"],
        ) =>
          createPrivateTenantExportApprovalCapture({
            ...options,
            callId: "waiting-for-other-call",
            state,
          }),
      };
      // A complete historical approval is retained, but does not authorize the different requested call.
      expect(
        await readPrivateOperatorApproval({
          ...shared,
          observation: { save },
          readHistory: (_start, onEvent) => {
            onEvent(requested());
            onEvent(settled());
            return Promise.resolve({ nextNativeIndex: 2, nativeTailIndex: 1, complete: true });
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
          observation: { state: checkpoint, save },
          readHistory: (start, onEvent) => {
            expect(start).toBe(2);
            if (otherRequest) {
              onEvent(pending);
            }
            onEvent(cancelled);
            return Promise.resolve({
              nextNativeIndex: otherRequest ? 4 : 3,
              nativeTailIndex: 4,
              complete: false,
            });
          },
        }),
      ).rejects.toBeInstanceOf(HostedSessionReadTimeoutError);
      const receipt = await readPrivateOperatorApproval({
        ...shared,
        owner: { ...owner, adapterSessionId: "replacement", adapterGeneration: 2 },
        observation: { state: checkpoint, save },
        capture: (state) =>
          createPrivateTenantExportApprovalCapture({
            ...options,
            ...(otherRequest ? {} : { callId: "export-call" }),
            state,
          }),
        readHistory: (start) => {
          expect(start).toBe(0);
          return Promise.resolve({ nextNativeIndex: 0, nativeTailIndex: -1, complete: true });
        },
      });
      expect(receipt).toBeNull();
      expect(checkpoint?.capture.entries.some((entry) => entry.cancelled)).toBe(true);
      if (otherRequest) {
        const unaffected = await readPrivateOperatorApproval({
          ...shared,
          owner: { ...owner, adapterSessionId: "replacement", adapterGeneration: 2 },
          observation: { state: checkpoint, save },
          capture: (state) =>
            createPrivateTenantExportApprovalCapture({ ...options, callId: "export-call", state }),
          readHistory: (start) => {
            expect(start).toBe(0);
            return Promise.resolve({ nextNativeIndex: 0, nativeTailIndex: -1, complete: true });
          },
        });
        expect(unaffected?.approvalId).toBe("human-request");
      }
    },
  );
  it("does not grant an approval from a partial tail before a later cancellation", async () => {
    let checkpoint: PrivateOperatorApprovalObservation | undefined;
    const save = (value: PrivateOperatorApprovalObservation) => {
      checkpoint = structuredClone(value);
      return Promise.resolve();
    };
    const shared = {
      owner,
      capture: (state?: Parameters<typeof createPrivateTenantExportApprovalCapture>[0]["state"]) =>
        createPrivateTenantExportApprovalCapture({ ...options, state }),
      assertOwner: () => Promise.resolve(),
    };
    await expect(
      readPrivateOperatorApproval({
        ...shared,
        observation: { save },
        readHistory: (_start, onEvent) => {
          onEvent(requested());
          onEvent(settled());
          return Promise.resolve({ nextNativeIndex: 2, nativeTailIndex: 2, complete: false });
        },
      }),
    ).rejects.toBeInstanceOf(HostedSessionReadTimeoutError);
    expect(checkpoint?.nextNativeIndex).toBe(2);
    const result = await readPrivateOperatorApproval({
      ...shared,
      observation: { state: checkpoint, save },
      readHistory: (start, onEvent) => {
        expect(start).toBe(2);
        onEvent(settled("owner", "cancelled"));
        return Promise.resolve({ nextNativeIndex: 3, nativeTailIndex: 2, complete: true });
      },
    });
    expect(result).toBeNull();
    expect(checkpoint?.capture.entries[0]?.cancelled).toBe(true);
  });
});

it("rechecks a quiet native tail without rewriting unchanged approval progress", async () => {
  const principal = { ...authority, scopes: ["autograph:send"] };
  const owner = operatorOwnerContextSchema.parse({
    kind: "direct",
    authority,
    principal,
    sessionId: plan.target.sessionId,
    adapterSessionId: "native",
    adapterGeneration: 1,
  });
  let checkpoint: PrivateOperatorApprovalObservation | undefined;
  const save = vi.fn((value: PrivateOperatorApprovalObservation) => {
    checkpoint = structuredClone(value);
    return Promise.resolve();
  });
  const assertOwner = vi.fn(() => Promise.resolve());
  const readHistory = vi.fn(() =>
    Promise.resolve({ nextNativeIndex: 0, nativeTailIndex: -1, complete: true }),
  );
  const read = () =>
    readPrivateOperatorApproval({
      owner,
      observation: { state: checkpoint, save },
      capture: (state) =>
        createPrivateTenantExportApprovalCapture({ plan, request, principal, state }),
      assertOwner,
      readHistory,
    });
  expect(await read()).toBeNull();
  expect(await read()).toBeNull();
  expect(save).toHaveBeenCalledTimes(1);
  expect(assertOwner).toHaveBeenCalledTimes(2);
  expect(readHistory).toHaveBeenCalledTimes(2);
});
