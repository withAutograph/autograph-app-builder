import { describe, expect, it, vi } from "vitest";
import startAppPreview from "../../agent/tools/start_app_preview";
import {
  previewWorkingDirectorySchema,
  resolvePreviewWorkingDirectory,
} from "./preview-working-directory";

const mocks = vi.hoisted(() => ({
  bind: vi.fn(),
  dependencies: vi.fn().mockResolvedValue({ status: "reused" }),
  prepare: vi.fn().mockResolvedValue({ status: "prepared" }),
  start: vi.fn().mockResolvedValue({ commandId: "preview-command", receipt: { status: "ready" } }),
}));
vi.mock("eve/tools", () => ({ defineTool: (value: unknown) => value }));
vi.mock("./product-behavior-state", () => ({
  bindProductBehaviorPreview: mocks.bind,
  currentProductBehaviorGeneration: () => 3,
}));
vi.mock("./workflow-state", () => ({
  appBuilderWorkflowState: {
    get: () => ({
      appSpec: { appId: "app" },
      applyReceipt: { applyRoot: "/workspace/repository" },
    }),
  },
}));
vi.mock("./working-preview-state", () => ({
  workingPreviewAttemptState: { get: () => null, update: vi.fn() },
  workingPreviewState: { get: () => null, update: vi.fn() },
}));
vi.mock("../sandbox/deployment-execution-lease", () => ({
  assertHostedSandboxCommandAuthority: vi.fn(),
}));
vi.mock("../sandbox/vercel-preview-provider", () => ({ getVercelPreviewProvider: vi.fn() }));
vi.mock("../sandbox/working-preview-runtime", () => ({ startWorkingPreview: mocks.start }));
vi.mock("./checkout-dependencies", () => ({ ensureCheckoutDependencies: mocks.dependencies }));
vi.mock("../../agent/tools/prepare-app-local-preview", () => ({
  prepareAppLocalPreview: mocks.prepare,
}));

const parseDirectory = (value?: string) => previewWorkingDirectorySchema.parse(value);

describe("preview command working directory", () => {
  it("defaults to the existing applied repository root", () => {
    expect(resolvePreviewWorkingDirectory("/workspace/repository", parseDirectory())).toBe(
      "/workspace/repository",
    );
  });
  it.each(["", "/tmp", "../repository-other", "apps/../../outside", "apps\\app", "apps/\0app"])(
    "rejects malformed or escaping directory %j",
    (directory) => {
      expect(() => resolvePreviewWorkingDirectory("/workspace/repository", directory)).toThrow();
    },
  );
  it("starts a nested package from its directory independently of its HTTP landing route", async () => {
    const input = {
      command: { args: ["run", "dev"], executable: "bun" },
      landingPath: "/review?tab=active",
      port: 3000,
      workingDirectory: "apps/example",
    };
    await startAppPreview.execute(input, {
      abortSignal: new AbortController().signal,
      callId: "call",
      getSandbox: vi
        .fn()
        .mockResolvedValue({ id: "sandbox", readTextFile: () => Promise.resolve(null) }),
      getSkill: vi.fn(),
      getToken: vi.fn(),
      requireAuth: (): never => {
        throw new Error("Unexpected auth request in preview test");
      },
      session: {
        auth: { current: null, initiator: null },
        id: "session",
        turn: { id: "turn", sequence: 0 },
      },
      toolName: "start_app_preview",
    });
    expect(mocks.bind).toHaveBeenCalledWith("preview-command", 3);
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({
        command: input.command,
        cwd: "/workspace/repository/apps/example",
        landingPath: "/review?tab=active",
      }),
    );
  });
  it("prepares a generated app's sandbox-local data before opening its preview", async () => {
    const input = {
      command: { args: ["run", "dev"], executable: "bun" },
      landingPath: "/app",
      port: 3000,
      workingDirectory: "apps/app",
    };
    const sandbox = {
      id: "sandbox",
      readTextFile: vi.fn(({ path }: { path: string }) => {
        if (path.endsWith("package.json")) {
          return Promise.resolve(JSON.stringify({ dependencies: { next: "16" } }));
        }
        return Promise.resolve(
          path.endsWith("app-spec.md") ? "mise run app:local -- app setup" : '[tasks."app:local"]',
        );
      }),
    };
    mocks.prepare.mockClear();
    mocks.start.mockClear();
    await startAppPreview.execute(input, {
      abortSignal: new AbortController().signal,
      callId: "call",
      getSandbox: vi.fn().mockResolvedValue(sandbox),
      getSkill: vi.fn(),
      getToken: vi.fn(),
      requireAuth: (): never => {
        throw new Error("Unexpected auth request in preview test");
      },
      session: {
        auth: { current: null, initiator: null },
        id: "session",
        turn: { id: "turn", sequence: 0 },
      },
      toolName: "start_app_preview",
    });
    expect(sandbox.readTextFile).toHaveBeenCalledWith({
      path: "/workspace/repository/apps/app/.config/app-spec.md",
    });
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "app", root: "/workspace/repository", sandbox }),
    );
    expect(mocks.dependencies.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.prepare.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.dependencies).toHaveBeenCalledWith(
      expect.objectContaining({ requiredExecutable: "next", root: "/workspace/repository" }),
    );
    expect(mocks.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.start.mock.invocationCallOrder[0] ?? 0,
    );
  });
  it("reports local database setup failure and does not claim a ready preview", async () => {
    mocks.prepare.mockResolvedValueOnce({
      command: "mise run --skip-tools app:local -- app setup",
      problem: "PostgreSQL could not start.",
      status: "failed",
      stderr: "pg_ctl failed",
      stdout: "",
    });
    mocks.start.mockClear();
    await expect(
      startAppPreview.execute(
        {
          command: { args: ["run", "dev"], executable: "bun" },
          landingPath: "/app",
          port: 3000,
          workingDirectory: "apps/app",
        },
        {
          abortSignal: new AbortController().signal,
          callId: "call",
          getSandbox: vi.fn().mockResolvedValue({
            id: "sandbox",
            readTextFile: ({ path }: { path: string }) => {
              if (path.endsWith("package.json")) {
                return Promise.resolve(JSON.stringify({ dependencies: { next: "16" } }));
              }
              return Promise.resolve(
                path.endsWith("app-spec.md")
                  ? "mise run app:local -- app setup"
                  : '[tasks."app:local"]',
              );
            },
          }),
          getSkill: vi.fn(),
          getToken: vi.fn(),
          requireAuth: (): never => {
            throw new Error("Unexpected auth request in preview test");
          },
          session: {
            auth: { current: null, initiator: null },
            id: "session",
            turn: { id: "turn", sequence: 0 },
          },
          toolName: "start_app_preview",
        },
      ),
    ).rejects.toThrow("PostgreSQL could not start");
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
