/* oxlint-disable anti-slop/no-module-mocking -- Exercise tool selection against the bound session and read-only client. */
import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import getAppProduction from "../../agent/tools/get-app-production";

const mocks = vi.hoisted(() => ({
  grant: vi.fn(),
  client: vi.fn(),
  predecessor: vi.fn(),
  status: vi.fn(),
}));
vi.mock("./direct-production-state", () => ({ currentDirectProductionGrant: mocks.grant }));
vi.mock(import("./repository-production-client"), async (importOriginal) => ({
  ...(await importOriginal()),
  repositoryProductionClientForContext: mocks.client,
}));
vi.mock("./prepare-app-production-step", () => ({ nextProductionDeliveryCall: {} }));

const appId = "fixture-app";
const identity = {
  version: 1,
  appId,
  repositoryId: "123",
  releaseId: "fixture.v8",
  artifactSha256: "a".repeat(64),
  manifestSha256: "b".repeat(64),
  cueSha256: "c".repeat(64),
};
const session: ToolContext["session"] = {
  auth: { current: null, initiator: null },
  id: "saved-session",
  turn: { id: "readback", sequence: 1 },
};
const unexpectedToolEffect = (): never => {
  throw new Error("The installed schema diagnostic should only read the existing setup.");
};
const ctx: ToolContext = {
  abortSignal: new AbortController().signal,
  callId: "readback",
  getSandbox: unexpectedToolEffect,
  getToken: unexpectedToolEffect,
  requireAuth: unexpectedToolEffect,
  session,
  toolName: "get-app-production",
};
const readback = { appId, includeSchemaPredecessor: true } as const;

describe("read installed schema through the saved app tool", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.client.mockResolvedValue({ schemaPredecessor: mocks.predecessor, status: mocks.status });
  });

  it("returns the owned app's installed schema without a draft, approval, or setup continuation", async () => {
    mocks.predecessor.mockResolvedValue(identity);
    await expect(getAppProduction.execute(readback, ctx)).resolves.toEqual(identity);
    expect(mocks.client).toHaveBeenCalledExactlyOnceWith(ctx);
    expect(mocks.predecessor).toHaveBeenCalledExactlyOnceWith(appId);
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.grant).not.toHaveBeenCalled();
  });

  it("keeps ordinary setup status on its existing path", async () => {
    mocks.status.mockResolvedValue({ state: "reconciling" });
    await expect(getAppProduction.execute({ appId }, ctx)).resolves.toEqual({
      state: "reconciling",
    });
    expect(mocks.status).toHaveBeenCalledExactlyOnceWith(appId);
    expect(mocks.predecessor).not.toHaveBeenCalled();
  });

  it("propagates operator read failures without starting setup", async () => {
    mocks.predecessor.mockRejectedValue(
      new Error("Builder could not verify the app’s installed schema."),
    );
    await expect(getAppProduction.execute(readback, ctx)).rejects.toThrow(
      "Builder could not verify the app’s installed schema.",
    );
    expect(mocks.predecessor).toHaveBeenCalledOnce();
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it("reports that the protected owner is unavailable without exposing auth errors", async () => {
    mocks.client.mockRejectedValue(new Error("private auth failure"));
    await expect(getAppProduction.execute(readback, ctx)).rejects.toThrow("owner-unavailable");
    expect(mocks.predecessor).not.toHaveBeenCalled();
  });

  it("honors cancellation before opening the protected client", async () => {
    const stopped = new AbortController();
    stopped.abort();
    await expect(
      getAppProduction.execute(readback, { ...ctx, abortSignal: stopped.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.client).not.toHaveBeenCalled();
  });
});
