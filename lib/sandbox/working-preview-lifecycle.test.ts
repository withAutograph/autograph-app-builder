import hook from "../../agent/hooks/release-sandbox-compute";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HookContext } from "eve/hooks";
import type { WorkingPreviewRuntime } from "./working-preview-runtime";

const mocks = vi.hoisted(() => ({
  hosted: false,
  preview: null as WorkingPreviewRuntime | null,
  provider: vi.fn(),
  release: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("eve/hooks", () => ({ defineHook: (value: unknown) => value }));
vi.mock("eve/context", () => ({
  defineState: () => ({
    get: () => mocks.preview,
    update: (update: (current: WorkingPreviewRuntime | null) => WorkingPreviewRuntime | null) => {
      mocks.preview = update(mocks.preview);
    },
  }),
}));
vi.mock("./vercel-preview-provider", () => ({ getVercelPreviewProvider: mocks.provider }));
vi.mock("./deployment-execution-lease", () => ({
  acquireHostedSandboxExecutionLease: vi.fn(),
  isHostedSandboxExecutionEnabled: () => mocks.hosted,
  releaseHostedSandboxExecutionLease: mocks.release,
}));

const context = {
  getSandbox: () => Promise.resolve({ id: "sandbox", stop: mocks.stop }),
  session: { auth: {}, id: "session" },
} as unknown as HookContext;
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
    },
  );
  it.each(["turn.cancelled", "turn.failed", "session.failed"])("releases on %s", async (event) => {
    await events[event]({}, context);
    expect(mocks.preview).toBeNull();
    expect(hosted ? mocks.release : mocks.stop).toHaveBeenCalledOnce();
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
  });
});
