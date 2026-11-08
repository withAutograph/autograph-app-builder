import { createReleaseSandboxComputeHook } from "../../agent/hooks/release-sandbox-compute";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HookContext } from "eve/hooks";
import type { Mock } from "vitest";
import type { WorkingPreviewRuntime } from "./working-preview-runtime";

type ReleaseDependencies = Parameters<typeof createReleaseSandboxComputeHook>[0];
interface LifecycleMocks {
  hosted: boolean;
  invalidate: Mock<ReleaseDependencies["invalidate"]>;
  preview: WorkingPreviewRuntime | null;
  provider: Mock<ReleaseDependencies["provider"]>;
  release: Mock<ReleaseDependencies["releaseLease"]>;
  stop: Mock<() => Promise<void>>;
}

const mocks: LifecycleMocks = {
  hosted: false,
  invalidate: vi.fn<ReleaseDependencies["invalidate"]>(),
  preview: null,
  provider: vi.fn<ReleaseDependencies["provider"]>(),
  release: vi.fn<ReleaseDependencies["releaseLease"]>(),
  stop: vi.fn<() => Promise<void>>(),
};
const hook = createReleaseSandboxComputeHook({
  attempt: { get: () => null, update: () => {} },
  invalidate: mocks.invalidate,
  isHosted: () => mocks.hosted,
  preview: {
    get: () => mocks.preview,
    update: (update: (current: WorkingPreviewRuntime | null) => WorkingPreviewRuntime | null) => {
      mocks.preview = update(mocks.preview);
    },
  },
  provider: mocks.provider,
  releaseLease: mocks.release,
});

// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The hook fixture supplies only the session and sandbox operations under test.
const context = {
  getSandbox: () => Promise.resolve({ id: "sandbox", stop: mocks.stop }),
  session: { auth: {}, id: "session" },
} as unknown as HookContext;
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
const events = hook.events as Record<string, (event: unknown, ctx: HookContext) => Promise<void>>;

describe.each([false, true])("preview completion lifecycle hosted=%s", (hosted) => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hosted = hosted;
    mocks.preview = {
      commandId: "command",
      providerSessionId: "provider-session",
      receipt: {
        appId: "app",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        status: "ready",
        url: "https://preview.example",
        verifiedAt: new Date().toISOString(),
      },
      sandboxId: "sandbox",
    };
    mocks.provider.mockResolvedValue({
      currentSession: () => ({ sessionId: "provider-session" }),
      getCommand: () => Promise.resolve({ exitCode: null }),
      status: "running",
    });
  });
  it.each(["turn.completed", "session.completed"])(
    "keeps the same live process on %s",
    async (event) => {
      await events[event]({}, context);
      expect(mocks.provider).toHaveBeenCalledWith("sandbox", undefined, false);
      expect(mocks.preview).not.toBeNull();
      expect(mocks.stop).not.toHaveBeenCalled();
      expect(mocks.release).not.toHaveBeenCalled();
      expect(mocks.invalidate).not.toHaveBeenCalled();
    },
  );
  it.each(["turn.cancelled", "turn.failed", "session.failed"])("releases on %s", async (event) => {
    await events[event]({}, context);
    expect(mocks.preview).toBeNull();
    expect(hosted ? mocks.release : mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.invalidate).toHaveBeenCalledWith("preview-released");
    expect(mocks.invalidate).toHaveBeenCalledBefore(hosted ? mocks.release : mocks.stop);
    expect(mocks.provider).not.toHaveBeenCalled();
  });
  it("does not preserve a preview from a replaced provider session", async () => {
    mocks.provider.mockResolvedValue({
      currentSession: () => ({ sessionId: "replacement" }),
      getCommand: vi.fn(),
      status: "running",
    });
    await events["turn.completed"]({}, context);
    expect(mocks.preview).toBeNull();
    expect(hosted ? mocks.release : mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.invalidate).toHaveBeenCalledWith("preview-released");
    expect(mocks.invalidate).toHaveBeenCalledBefore(hosted ? mocks.release : mocks.stop);
  });
  it("releases a stopped preview command", async () => {
    mocks.provider.mockResolvedValue({
      currentSession: () => ({ sessionId: "provider-session" }),
      getCommand: () => Promise.resolve({ exitCode: 0 }),
      status: "running",
    });
    await events["turn.completed"]({}, context);
    expect(mocks.preview).toBeNull();
    expect(hosted ? mocks.release : mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.invalidate).toHaveBeenCalledWith("preview-released");
    expect(mocks.invalidate).toHaveBeenCalledBefore(hosted ? mocks.release : mocks.stop);
  });
});
