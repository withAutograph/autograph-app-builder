import type { MessageStreamEvent } from "eve/client";
import { describe, expect, it } from "vitest";
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
  issuer: "https://builder.test/auth",
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
