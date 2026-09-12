import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadyRepositoryAccess } from "../integrations/repository-access";
import type { RepositoryAccessRuntime } from "./deployment-repository-access-runtime";
import { resolveRepositoryAccessForTool } from "./repository-access-tool";

vi.mock("eve/context", () => ({
  defineState: () => ({
    // oxlint-disable-next-line unicorn/no-useless-undefined -- The state test double must receive its undefined initial value.
    update: (fn: (value: undefined) => unknown) => fn(undefined),
  }),
}));
const ready: ReadyRepositoryAccess = {
  status: "ready",
  accessDigest: "a".repeat(64),
  scope: {
    installationId: "10",
    accountLogin: "acme",
    accountType: "Organization",
  },
  repository: {
    repositoryId: "20",
    owner: "acme",
    name: "stock",
    defaultBranch: "main",
    headSha: "1".repeat(40),
    headTree: "2".repeat(40),
    archived: false,
    visibility: "private",
    repositoryVariableNames: [],
  },
};
const reference = { owner: "acme", name: "stock", fullName: "acme/stock" };
const input = { repository: reference.fullName };
const ctx = {
  session: { id: "ses_one", auth: {} },
  callId: "call_one",
  getToken: vi.fn(),
  requireAuth: vi.fn(),
} as unknown as ToolContext;
const runtime = {
  classify: vi.fn(),
  authorization: vi.fn(),
  resumeAuthorizedForSession: vi.fn(),
  prepareExistingSource: vi.fn(),
} satisfies RepositoryAccessRuntime;

describe("repository access tool continuity", () => {
  beforeEach(() => vi.clearAllMocks());
  it("continues with freshly ready access without any auth request", async () => {
    runtime.classify.mockResolvedValue(ready);
    expect(await resolveRepositoryAccessForTool(input, ctx, runtime)).toMatchObject({
      kind: "ready",
      receipt: { sessionId: "ses_one", scope: ready.scope },
    });
    expect(runtime.classify).toHaveBeenCalledTimes(1);
    expect(runtime.authorization).not.toHaveBeenCalled();
    expect(ctx.getToken).not.toHaveBeenCalled();
    expect(ctx.requireAuth).not.toHaveBeenCalled();
  });
  it("retries an outage without entering authorization", async () => {
    runtime.classify.mockResolvedValue({
      status: "provider-unavailable",
      repository: reference,
    });
    await expect(resolveRepositoryAccessForTool(input, ctx, runtime)).rejects.toMatchObject({
      reason: "provider_unavailable",
      retryable: true,
    });
    expect(runtime.authorization).not.toHaveBeenCalled();
    expect(ctx.getToken).not.toHaveBeenCalled();
  });
  it("parks missing access in the existing same-session authorization flow and rechecks it", async () => {
    runtime.classify
      .mockResolvedValueOnce({
        status: "authorization-required",
        action: "update",
        repository: reference,
        scopes: [],
      })
      .mockResolvedValueOnce(ready);
    expect(await resolveRepositoryAccessForTool(input, ctx, runtime)).toMatchObject({
      kind: "ready",
    });
    expect(runtime.authorization).toHaveBeenCalledWith({
      repository: reference.fullName,
      sessionId: "ses_one",
      requestId: "call_one",
    });
    expect(ctx.getToken).toHaveBeenCalledOnce();
    expect(runtime.classify).toHaveBeenCalledTimes(2);
  });
  it("does not record access when a post-authorization read is unavailable", async () => {
    runtime.classify
      .mockResolvedValueOnce({
        status: "authorization-required",
        action: "update",
        repository: reference,
        scopes: [],
      })
      .mockResolvedValueOnce({
        status: "provider-unavailable",
        repository: reference,
      });
    await expect(resolveRepositoryAccessForTool(input, ctx, runtime)).rejects.toMatchObject({
      reason: "provider_unavailable",
      retryable: true,
    });
    expect(ctx.requireAuth).not.toHaveBeenCalled();
  });
});
