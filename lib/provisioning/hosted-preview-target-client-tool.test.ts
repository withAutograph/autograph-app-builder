import { createHash } from "node:crypto";
/* oxlint-disable anti-slop/no-module-mocking -- Isolate private operator transport and Eve authorization while exercising the production client and tool. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHostedOperatorClient } from "./hosted-operator-client";
import { z } from "zod";
import type { OperatorSelection } from "./hosted-operator-contract";
import { HostedOperatorError } from "./hosted-operator-contract";
import planTool from "../../agent/tools/plan-app-hosted-runtime";
import getTool from "../../agent/tools/get-app-hosted-runtime";

const hooks = vi.hoisted(() => ({
  authorize: vi.fn(),
  client: vi.fn(),
  request: vi.fn(),
  export: vi.fn(),
  readExport: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("eve/tools", () => ({ defineTool: <T>(tool: T) => tool }));
vi.mock("../agent/hosted-neon-authorization", () => ({
  authorizeHostedNeonForTool: hooks.authorize,
}));
vi.mock("./hosted-operator-client", async (importOriginal) => ({
  ...(await importOriginal<{ createHostedOperatorClient: typeof createHostedOperatorClient }>()),
  hostedOperatorClientForSession: hooks.client,
}));
const selection: OperatorSelection = {
  appId: "spend-review",
  branch: "owner-preview",
  environment: "preview",
  projectId: "prj_owned",
  sessionId: "canonical-session",
};
const blocked = {
  appId: selection.appId,
  authenticatedBehavior: "unassessed",
  code: "resource_mismatch",
  status: "blocked",
};
const request = {
  action: "resolve-preview-target" as const,
  appId: selection.appId,
  sessionId: selection.sessionId,
};
const ctx = {
  callId: "owned-tool-call",
  abortSignal: new AbortController().signal,
  session: { auth: { owner: true }, id: "adapter-session" },
};
// SAFETY: The identity defineTool fixture calls the production execute method; all consumed context fields are supplied.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Synthetic Eve context for this private tool boundary.
const toolCtx = ctx as never;
const input = {
  appId: selection.appId,
  environment: "preview" as const,
  operation: "prepare" as const,
};

type TransportResponse = OperatorSelection | typeof blocked | Record<string, string>;
const transport = (value: TransportResponse, status = 200) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(value, { status }));
  const client = createHostedOperatorClient({
    endpoint: "https://operator.example",
    fetch: fetcher,
    token: async () => await Promise.resolve("synthetic-oidc"),
  });
  return { client, fetcher };
};

describe("closed Preview selection client", () => {
  it("returns the exact nonsecret Preview selection and sends the session-only request", async () => {
    const f = transport(selection);
    await expect(f.client.resolvePreviewTarget(request, ctx.abortSignal)).resolves.toEqual(
      selection,
    );
    const sent = f.fetcher.mock.calls[0]?.[1];
    expect(sent?.signal).toBe(ctx.abortSignal);
    expect(JSON.parse(z.string().parse(sent?.body))).toEqual(request);
  });
  it.each(["appId", "sessionId"] as const)("rejects a changed %s", async (key) => {
    const f = transport({ ...selection, [key]: "different" });
    await expect(f.client.resolvePreviewTarget(request)).rejects.toMatchObject({
      code: "resource_mismatch",
    });
  });
  it("retains the operator blocked category", async () => {
    const f = transport(blocked);
    await expect(f.client.resolvePreviewTarget(request)).rejects.toMatchObject({
      code: "resource_mismatch",
    });
  });
  it.each([
    { ...selection, environment: "production" },
    { ...selection, token: "synthetic-secret" },
  ])("rejects invalid or credential-bearing selections", async (value) => {
    const f = transport(value);
    await expect(f.client.resolvePreviewTarget(request)).rejects.toThrow();
  });
  it("handles denial diagnostics for the session-only request", async () => {
    const f = transport({}, 403);
    await expect(f.client.resolvePreviewTarget(request)).rejects.toMatchObject({
      code: "authorization_required",
    });
  });
});

describe("private hosted runtime planning target", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hooks.authorize.mockResolvedValue(null);
    hooks.resolve.mockResolvedValue(selection);
    hooks.request.mockResolvedValue({ status: "planned" });
    hooks.client.mockResolvedValue({
      request: hooks.request,
      resolvePreviewTarget: hooks.resolve,
      sessionId: selection.sessionId,
    });
  });
  it("accepts omitted IDs and resolves after consent using canonical session identity", async () => {
    await planTool.execute(input, toolCtx);
    expect(hooks.authorize.mock.invocationCallOrder[0]).toBeLessThan(
      hooks.resolve.mock.invocationCallOrder[0] ?? 0,
    );
    expect(hooks.resolve).toHaveBeenCalledWith(request, ctx.abortSignal);
    expect(hooks.request).toHaveBeenCalledWith(
      { action: "plan", operation: "prepare", selection },
      ctx.abortSignal,
    );
  });
  it.each([{ projectId: "prj_other" }, { branch: "other-branch" }])(
    "blocks explicit target disagreement and returns the authorized private selection",
    async (target) => {
      await expect(planTool.execute({ ...input, ...target }, toolCtx)).resolves.toEqual({
        ...blocked,
        approvedPreviewTarget: selection,
      });
      expect(hooks.request).not.toHaveBeenCalled();
    },
  );
  it("resolves supplied matching IDs and preserves authorization pause control flow", async () => {
    await planTool.execute(
      { ...input, branch: selection.branch, projectId: selection.projectId },
      toolCtx,
    );
    expect(hooks.resolve).toHaveBeenCalledTimes(1);
    const pause = { kind: "authorization-required" };
    hooks.authorize.mockRejectedValueOnce(pause);
    await expect(planTool.execute(input, toolCtx)).rejects.toBe(pause);
    expect(hooks.resolve).toHaveBeenCalledTimes(1);
  });
  it("returns resolver ownership errors without planning", async () => {
    hooks.resolve.mockRejectedValueOnce(new HostedOperatorError("resource_mismatch"));
    await expect(planTool.execute(input, toolCtx)).resolves.toEqual(blocked);
    expect(hooks.request).not.toHaveBeenCalled();
  });
  it("resolves cleanup using adapter fallback without prepare consent", async () => {
    hooks.client.mockResolvedValueOnce({
      request: hooks.request,
      resolvePreviewTarget: hooks.resolve,
    });
    await planTool.execute({ ...input, operation: "cleanup" }, toolCtx);
    expect(hooks.authorize).not.toHaveBeenCalled();
    expect(hooks.resolve).toHaveBeenCalledWith(
      { ...request, sessionId: ctx.session.id },
      ctx.abortSignal,
    );
  });
});

describe("closed export tool pre-dispatch diagnostics", () => {
  const customerId = "private-customer";
  const exportInput = { ...input, operation: "export" as const };
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
    hooks.resolve.mockResolvedValue(selection);
    hooks.export.mockResolvedValue({ status: "planned" });
    hooks.client.mockResolvedValue({
      request: hooks.request,
      resolvePreviewTarget: hooks.resolve,
      planTenantExport: hooks.export,
      sessionId: selection.sessionId,
    });
  });
  afterEach(() => vi.restoreAllMocks());
  const expectFailure = (
    stage: string,
    errorClass = "operator_error",
    sessionId = selection.sessionId,
  ) => {
    expect(console.info).toHaveBeenCalledWith("[builder:hosted-neon-consent]", {
      boundary: "builder",
      phase: "inline",
      stage: "operator_request",
      outcome: "setup_unavailable",
      event: "builder.hosted_neon_consent",
      sessionIdHash: `sha256:${createHash("sha256").update(sessionId).digest("hex")}`,
      exportPlanningFailure: { stage, errorClass },
    });
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(customerId);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(selection.sessionId);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(selection.projectId);
  };
  it.each([
    [{ projectId: "private-other-project", customerId }, "tool_project_mismatch"],
    [{ branch: "private-other-branch", customerId }, "tool_branch_mismatch"],
    [{}, "tool_missing_customer"],
  ] as const)("identifies the existing local guard %# without dispatch", async (hints, stage) => {
    expect(await planTool.execute({ ...exportInput, ...hints }, toolCtx)).toEqual({
      ...blocked,
      approvedPreviewTarget: selection,
    });
    expectFailure(stage);
    expect(hooks.resolve).toHaveBeenCalledOnce();
    expect(hooks.export).not.toHaveBeenCalled();
    expect(hooks.request).not.toHaveBeenCalled();
    expect(hooks.authorize).not.toHaveBeenCalled();
  });
  it("identifies target resolution failure using the canonical session", async () => {
    hooks.resolve.mockRejectedValueOnce(new HostedOperatorError("resource_mismatch"));
    expect(await planTool.execute({ ...exportInput, customerId }, toolCtx)).toEqual(blocked);
    expectFailure("tool_preview_target");
    expect(hooks.export).not.toHaveBeenCalled();
  });
  it("identifies client construction failure before canonical identity is available", async () => {
    hooks.client.mockRejectedValueOnce(new HostedOperatorError("resource_mismatch"));
    expect(await planTool.execute({ ...exportInput, customerId }, toolCtx)).toEqual(blocked);
    expectFailure("tool_client_resolution", "operator_error", ctx.session.id);
    expect(hooks.resolve).not.toHaveBeenCalled();
  });
  it.each([
    [new HostedOperatorError("resource_mismatch"), "operator_error", "resource_mismatch"],
    [
      new TypeError("private-token https://private.example/export"),
      "type_error",
      "operator_unavailable",
    ],
  ] as const)(
    "identifies export client request failure %# without exposing exception details",
    async (failure, errorClass, code) => {
      hooks.export.mockRejectedValueOnce(failure);
      expect(await planTool.execute({ ...exportInput, customerId }, toolCtx)).toEqual({
        ...blocked,
        code,
      });
      expectFailure("tool_plan_request", errorClass);
      expect(hooks.export).toHaveBeenCalledWith(selection, customerId, ctx.callId, ctx.abortSignal);
      expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain("private-token");
      expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain("private.example");
    },
  );
  it("passes the explicit owner organization choice without guessing a customer ID", async () => {
    const result = { status: "planned", retained: true };
    hooks.export.mockResolvedValueOnce(result);
    expect(
      await planTool.execute({ ...exportInput, customerScope: "owner-organization" }, toolCtx),
    ).toBe(result);
    expect(hooks.export).toHaveBeenCalledWith(
      selection,
      { kind: "owner-organization" },
      ctx.callId,
      ctx.abortSignal,
    );
    expect(console.info).not.toHaveBeenCalled();
  });
  it("returns an ordinary organization clarification when owner scope is unresolved", async () => {
    hooks.export.mockRejectedValueOnce(
      new HostedOperatorError("export_customer_selection_required"),
    );
    const result = await planTool.execute(
      { ...exportInput, customerScope: "owner-organization" },
      toolCtx,
    );
    expect(result).toMatchObject({
      status: "blocked",
      code: "export_customer_selection_required",
      nextAction: "Name the organization to export. No export was planned or data extracted.",
    });
  });
  it("preserves successful dispatch and produces no failure diagnostic", async () => {
    const result = { status: "planned", retained: true };
    hooks.export.mockResolvedValueOnce(result);
    expect(await planTool.execute({ ...exportInput, customerId }, toolCtx)).toBe(result);
    expect(hooks.resolve).toHaveBeenCalledOnce();
    expect(hooks.export).toHaveBeenCalledOnce();
    expect(hooks.request).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
  });
  it("preserves the existing blocked result when the diagnostic sink throws", async () => {
    vi.mocked(console.info).mockImplementation(() => {
      throw new Error("private-sink");
    });
    expect(await planTool.execute(exportInput, toolCtx)).toEqual({
      ...blocked,
      approvedPreviewTarget: selection,
    });
    expect(hooks.export).not.toHaveBeenCalled();
  });
  it("preserves the existing blocked result when diagnostic context lookup throws", async () => {
    let reads = 0;
    hooks.client.mockResolvedValueOnce({
      resolvePreviewTarget: hooks.resolve,
      planTenantExport: hooks.export,
      get sessionId() {
        reads += 1;
        if (reads > 1) {
          throw new Error("private-context");
        }
        return selection.sessionId;
      },
    });
    expect(await planTool.execute(exportInput, toolCtx)).toEqual({
      ...blocked,
      approvedPreviewTarget: selection,
    });
    expect(console.info).not.toHaveBeenCalled();
    expect(hooks.export).not.toHaveBeenCalled();
  });
});

describe("saved export lookup tool", () => {
  const exportId = "40000000-0000-4000-8000-000000000004";
  beforeEach(() => {
    vi.clearAllMocks();
    hooks.client.mockResolvedValue({
      request: hooks.request,
      readTenantExport: hooks.readExport,
      planTenantExport: hooks.export,
      resolvePreviewTarget: hooks.resolve,
      sessionId: selection.sessionId,
    });
  });
  it("routes an export ID to the saved intent read without preparation lookup or replanning", async () => {
    const saved = {
      plan: { frozen: "selected-plan" },
      request: { idempotencyKey: "original-call" },
      status: { state: "planned" },
    };
    hooks.readExport.mockResolvedValueOnce(saved);
    await expect(getTool.execute({ operation: "export", exportId }, toolCtx)).resolves.toEqual(
      saved,
    );
    expect(hooks.client).toHaveBeenCalledWith(ctx.session.auth, ctx.session.id);
    expect(hooks.readExport).toHaveBeenCalledWith(exportId, ctx.abortSignal);
    expect(hooks.request).not.toHaveBeenCalled();
    expect(hooks.export).not.toHaveBeenCalled();
    expect(hooks.resolve).not.toHaveBeenCalled();
  });
  it("keeps the existing preparation lookup input and request unchanged", async () => {
    const oldInput = {
      appId: selection.appId,
      branch: selection.branch,
      environment: "preview" as const,
      operationRef: exportId,
      projectId: selection.projectId,
    };
    const status = { status: "pending" };
    hooks.request.mockResolvedValueOnce(status);
    await expect(getTool.execute(oldInput, toolCtx)).resolves.toEqual(status);
    const { operationRef, ...selected } = oldInput;
    expect(hooks.request).toHaveBeenCalledWith(
      {
        action: "status",
        operationRef,
        selection: { ...selected, sessionId: selection.sessionId },
      },
      ctx.abortSignal,
    );
    expect(hooks.readExport).not.toHaveBeenCalled();
  });
  it("preserves a saved export ownership refusal without returning an intent or replanning", async () => {
    hooks.readExport.mockRejectedValueOnce(new HostedOperatorError("authorization_required"));
    await expect(getTool.execute({ operation: "export", exportId }, toolCtx)).resolves.toEqual({
      exportId,
      authenticatedBehavior: "unassessed",
      code: "authorization_required",
      status: "blocked",
    });
    expect(hooks.request).not.toHaveBeenCalled();
    expect(hooks.export).not.toHaveBeenCalled();
  });
});
