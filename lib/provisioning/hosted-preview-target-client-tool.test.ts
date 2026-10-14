/* oxlint-disable anti-slop/no-module-mocking -- Isolate private operator transport and Eve authorization while exercising the production client and tool. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHostedOperatorClient } from "./hosted-operator-client";
import { z } from "zod";
import type { OperatorSelection } from "./hosted-operator-contract";
import { HostedOperatorError } from "./hosted-operator-contract";
import planTool from "../../agent/tools/plan-app-hosted-runtime";

const hooks = vi.hoisted(() => ({
  authorize: vi.fn(),
  client: vi.fn(),
  request: vi.fn(),
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
