import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReadyRepositoryAccess } from "../integrations/repository-access";
import type { RepositoryAccessRuntime } from "./deployment-repository-access-runtime";
import { resolveRepositoryAccessForTool } from "./repository-access-tool";

vi.mock("eve/context", () => ({
  defineState: () => ({
    update: (fn: (value: undefined) => unknown) => fn(),
  }),
}));
const ready: ReadyRepositoryAccess = {
  accessDigest: "a".repeat(64),
  repository: {
    archived: false,
    defaultBranch: "main",
    headSha: "1".repeat(40),
    headTree: "2".repeat(40),
    name: "stock",
    owner: "acme",
    repositoryId: "20",
    repositoryVariableNames: [],
    visibility: "private",
  },
  scope: {
    accountLogin: "acme",
    accountType: "Organization",
    installationId: "10",
  },
  status: "ready",
};
const reference = { fullName: "acme/stock", name: "stock", owner: "acme" };
const input = { repository: reference.fullName };
const ctx = {
  callId: "call_one",
  getToken: vi.fn(),
  requireAuth: vi.fn(),
  session: { auth: {}, id: "ses_one" },
} as unknown as ToolContext;
const runtime = {
  authorization: vi.fn(),
  classify: vi.fn(),
  prepareExistingSource: vi.fn(),
  resumeAuthorizedForSession: vi.fn(),
} satisfies RepositoryAccessRuntime;

describe("repository access tool continuity", () => {
  beforeEach(() => vi.clearAllMocks());
  it("continues with freshly ready access without any auth request", async () => {
    runtime.classify.mockResolvedValue(ready);
    expect(
      await resolveRepositoryAccessForTool(input, ctx, runtime)
    ).toMatchObject({
      kind: "ready",
      receipt: { scope: ready.scope, sessionId: "ses_one" },
    });
    expect(runtime.classify).toHaveBeenCalledTimes(1);
    expect(runtime.authorization).not.toHaveBeenCalled();
    expect(ctx.getToken).not.toHaveBeenCalled();
    expect(ctx.requireAuth).not.toHaveBeenCalled();
  });
  it("retries an outage without entering authorization", async () => {
    runtime.classify.mockResolvedValue({
      repository: reference,
      status: "provider-unavailable",
    });
    await expect(
      resolveRepositoryAccessForTool(input, ctx, runtime)
    ).rejects.toMatchObject({
      reason: "provider_unavailable",
      retryable: true,
    });
    expect(runtime.authorization).not.toHaveBeenCalled();
    expect(ctx.getToken).not.toHaveBeenCalled();
  });
  it("parks missing access in the existing same-session authorization flow and rechecks it", async () => {
    runtime.classify
      .mockResolvedValueOnce({
        action: "update",
        repository: reference,
        scopes: [],
        status: "authorization-required",
      })
      .mockResolvedValueOnce(ready);
    expect(
      await resolveRepositoryAccessForTool(input, ctx, runtime)
    ).toMatchObject({ kind: "ready" });
    expect(runtime.authorization).toHaveBeenCalledWith({
      repository: reference.fullName,
      requestId: "call_one",
      sessionId: "ses_one",
    });
    expect(ctx.getToken).toHaveBeenCalledOnce();
    expect(runtime.classify).toHaveBeenCalledTimes(2);
  });
  it("does not record access when a post-authorization read is unavailable", async () => {
    runtime.classify
      .mockResolvedValueOnce({
        action: "update",
        repository: reference,
        scopes: [],
        status: "authorization-required",
      })
      .mockResolvedValueOnce({
        repository: reference,
        status: "provider-unavailable",
      });
    await expect(
      resolveRepositoryAccessForTool(input, ctx, runtime)
    ).rejects.toMatchObject({
      reason: "provider_unavailable",
      retryable: true,
    });
    expect(ctx.requireAuth).not.toHaveBeenCalled();
  });
});
