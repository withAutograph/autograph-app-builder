import { describe, expect, it, vi } from "vitest";
import type { DependencyAttemptResult } from "./checkout-dependencies";
import startAppPreview from "../../agent/tools/start_app_preview";
import {
  previewWorkingDirectorySchema,
  resolvePreviewWorkingDirectory,
} from "./preview-working-directory";

interface MockWorkflowState {
  checkoutDependencyAttempts?: readonly DependencyAttemptResult[];
  appSpec?: { appId: string };
  applyReceipt?: { applyRoot: string };
  identityReceipt?: { identity: { appId: string; baseRoutes: string[] } };
  githubSource?: { digest: string };
  phase?: string;
  sourceReceipt?: { sourceKind: string };
  workspace?: { workspacePath: string };
}

const mocks = vi.hoisted(() => {
  const workflowState: MockWorkflowState = {
    appSpec: { appId: "app" },
    applyReceipt: { applyRoot: "/workspace/repository" },
  };
  return {
    bind: vi.fn(),
    dependencies: vi.fn().mockResolvedValue({ status: "reused" }),
    invalidate: vi.fn(),
    nativeBindings: vi.fn().mockResolvedValue(null),
    nativePreview: vi.fn(),
    prepare: vi.fn().mockResolvedValue({ status: "prepared" }),
    previewStateUpdate:
      vi.fn<(transition: (state: { commandId: string } | null) => null) => void>(),
    runtime: vi.fn().mockResolvedValue(null),
    start: vi
      .fn()
      .mockResolvedValue({ commandId: "preview-command", receipt: { status: "ready" } }),
    workflowState,
  };
});
vi.mock("eve/tools", () => ({ defineTool: (value: unknown) => value }));
vi.mock("./product-behavior-state", () => ({
  bindProductBehaviorPreview: mocks.bind,
  currentProductBehaviorGeneration: () => 3,
  invalidateProductBehaviorPreview: mocks.invalidate,
}));
vi.mock("./workflow-state", () => ({
  appBuilderWorkflowState: {
    get: () => mocks.workflowState,
    update: (transition: (state: MockWorkflowState) => MockWorkflowState) => {
      mocks.workflowState = transition(mocks.workflowState);
    },
  },
}));
vi.mock("./working-preview-state", () => ({
  workingPreviewAttemptState: { get: () => null, update: vi.fn() },
  workingPreviewState: { get: () => null, update: mocks.previewStateUpdate },
}));
vi.mock("../sandbox/deployment-execution-lease", () => ({
  assertHostedSandboxCommandAuthority: vi.fn(),
}));
vi.mock("../sandbox/vercel-preview-provider", () => ({ getVercelPreviewProvider: vi.fn() }));
vi.mock("../sandbox/working-preview-runtime", () => ({ startWorkingPreview: mocks.start }));
vi.mock("./prepared-runtime-execution", () => ({
  resolvePreparedRuntimeExecution: mocks.runtime,
  resolveProtectedRuntimeBindings: mocks.nativeBindings,
}));
vi.mock("./native-working-preview", () => ({ nativeWorkingPreview: mocks.nativePreview }));
vi.mock("./checkout-dependencies", () => ({ ensureCheckoutDependencies: mocks.dependencies }));
vi.mock("../../agent/tools/prepare-app-local-preview", () => ({
  appDeclaresLocalSetup: async ({
    appId,
    root,
    sandbox,
  }: {
    appId: string;
    root: string;
    sandbox: { readTextFile: (input: { path: string }) => Promise<string | null> };
  }) => {
    const [contract, tasks] = await Promise.all([
      sandbox.readTextFile({ path: `${root}/apps/${appId}/.config/app-spec.md` }),
      sandbox.readTextFile({ path: `${root}/.config/mise/config.toml` }),
    ]);
    return (
      contract?.includes(`mise run app:local -- ${appId} setup`) === true &&
      tasks?.includes('[tasks."app:local"]') === true
    );
  },
  prepareAppLocalPreview: mocks.prepare,
}));

const parseDirectory = (value?: string) => previewWorkingDirectorySchema.parse(value);

describe("preview command working directory", () => {
  it("restores approved hosted persistence and updates the private gateway origin without local setup", async () => {
    const prepareAuthenticatedOrigin = vi.fn();
    mocks.runtime.mockResolvedValueOnce({
      environmentPath: "/private-state/environment.json",
      installationProof: { releaseId: "release_1" },
      prepareAuthenticatedOrigin,
      stateDirectory: "/private-state",
    });
    mocks.prepare.mockClear();
    mocks.start.mockClear();
    await startAppPreview.execute(
      {
        command: { args: ["run", "dev"], executable: "bun" },
        landingPath: "/app",
        port: 3000,
        workingDirectory: "apps/app",
      },
      {
        abortSignal: new AbortController().signal,
        callId: "hosted-preview",
        getSandbox: vi.fn().mockResolvedValue({
          id: "sandbox_replacement",
          readTextFile: () => Promise.resolve("{}"),
        }),
        getToken: vi.fn(),
        requireAuth: (): never => {
          throw new Error("Unexpected auth request");
        },
        session: {
          auth: { current: null, initiator: null },
          id: "session",
          turn: { id: "turn", sequence: 0 },
        },
        toolName: "start_app_preview",
      },
    );
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentPath: "/private-state/environment.json",
        prepareAuthenticatedOrigin,
      }),
    );
    expect(mocks.runtime).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxId: "sandbox_replacement", sessionId: "session" }),
    );
  });
  it("opens an existing selected app before an implementation proposal", async () => {
    mocks.workflowState = {
      githubSource: { digest: "selected-source" },
      phase: "prepared",
      sourceReceipt: { sourceKind: "existing-repository" },
      workspace: { workspacePath: "/workspace/repository" },
    };
    const readTextFile = vi.fn(({ path }: { path: string }) =>
      Promise.resolve(path.endsWith("package.json") ? "{}" : "# App contract"),
    );
    try {
      await startAppPreview.execute(
        {
          appId: "existing-app",
          command: { args: ["run", "dev"], executable: "bun" },
          landingPath: "/",
          port: 3000,
          workingDirectory: "apps/existing-app",
        },
        {
          abortSignal: new AbortController().signal,
          callId: "prepared-preview",
          getSandbox: vi.fn().mockResolvedValue({ id: "sandbox", readTextFile }),
          getToken: vi.fn(),
          requireAuth: (): never => {
            throw new Error("Unexpected auth request");
          },
          session: {
            auth: { current: null, initiator: null },
            id: "session",
            turn: { id: "turn", sequence: 0 },
          },
          toolName: "start_app_preview",
        },
      );
      expect(readTextFile).toHaveBeenCalledWith({
        path: "/workspace/repository/apps/existing-app/.config/app-spec.md",
      });
      expect(mocks.start).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: "existing-app",
          cwd: "/workspace/repository/apps/existing-app",
        }),
      );
    } finally {
      mocks.workflowState = {
        appSpec: { appId: "app" },
        applyReceipt: { applyRoot: "/workspace/repository" },
      };
    }
  });
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
    expect(mocks.invalidate).toHaveBeenCalledWith("preview-replaced");
    expect(mocks.invalidate).toHaveBeenCalledBefore(mocks.start);
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
  it("saves dependency references in workflow state before preview failure", async () => {
    const attempt: DependencyAttemptResult = {
      attemptDigest: "a".repeat(64),
      command: "dependency-install",
      completion: "complete",
      durability: "available",
      excerpt: "lockfile mismatch",
      executionCommand: "bun install --frozen-lockfile",
      exitCode: 1,
      logs: {
        stdout: {
          bytes: 100_000,
          channel: "stdout",
          chunkCount: 4,
          completion: "complete",
          digest: "b".repeat(64),
          logId: "123e4567-e89b-42d3-a456-426614174001",
        },
      },
      truncated: true,
    };
    mocks.dependencies.mockImplementationOnce(
      (input: { onAttempt: (value: DependencyAttemptResult) => void }) => {
        input.onAttempt(attempt);
        throw new Error("dependency install failed");
      },
    );
    mocks.start.mockClear();
    await expect(
      startAppPreview.execute(
        {
          command: { args: ["run", "dev"], executable: "bun" },
          landingPath: "/",
          port: 3000,
          workingDirectory: ".",
        },
        {
          abortSignal: new AbortController().signal,
          callId: "failed-dependency-preview",
          getSandbox: vi
            .fn()
            .mockResolvedValue({ id: "sandbox", readTextFile: vi.fn().mockResolvedValue(null) }),
          getToken: vi.fn(),
          requireAuth: (): never => {
            throw new Error("Unexpected authentication redirect");
          },
          session: {
            auth: { current: null, initiator: null },
            id: "session",
            turn: { id: "turn", sequence: 0 },
          },
          toolName: "start_app_preview",
        },
      ),
    ).rejects.toThrow("dependency install failed");
    expect(mocks.workflowState.checkoutDependencyAttempts).toContainEqual(attempt);
    expect(mocks.start).not.toHaveBeenCalled();
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

describe("protected native preview early branch", () => {
  it("publishes native receipt before asking for a Sandbox or discovering launch configuration", async () => {
    const receipt = {
      installationProof: { authenticatedBehavior: "unassessed" },
      workingPreview: { appId: "app", status: "ready", url: "https://apps.example/app" },
    };
    mocks.nativeBindings.mockResolvedValueOnce({
      nativePreview: { publicOrigin: "https://apps.example" },
    });
    mocks.nativePreview.mockReturnValueOnce(receipt);
    const previous = mocks.workflowState;
    mocks.workflowState = {
      ...previous,
      appSpec: { appId: "app" },
      identityReceipt: { identity: { appId: "app", baseRoutes: ["/app", "/app/:path*"] } },
    };
    const getSandbox = vi.fn(() => {
      throw new Error("Native publication must not open Sandbox");
    });
    try {
      const result = await startAppPreview.execute(
        {
          command: { args: [], executable: "unused" },
          landingPath: "/",
          port: 3000,
          workingDirectory: ".",
        },
        { getSandbox, session: { auth: {}, id: "session-native" } } as never,
      );
      expect(result).toEqual(receipt);
      expect(getSandbox).not.toHaveBeenCalled();
      expect(mocks.nativePreview).toHaveBeenCalledWith(
        expect.objectContaining({ baseRoute: "/app", landingPath: "/" }),
      );
      expect(mocks.invalidate).toHaveBeenCalledWith("preview-replaced");
      const clearPreview = mocks.previewStateUpdate.mock.calls.at(-1)?.[0];
      expect(clearPreview?.({ commandId: "old-private-command" })).toBeNull();
    } finally {
      mocks.workflowState = previous;
    }
  });
  it("does not fall back when protected native metadata is unavailable", async () => {
    mocks.nativeBindings.mockResolvedValueOnce({});
    mocks.nativePreview.mockImplementationOnce(() => {
      throw new Error("resource_mismatch");
    });
    const previous = mocks.workflowState;
    mocks.workflowState = {
      ...previous,
      identityReceipt: { identity: { appId: "app", baseRoutes: ["/app", "/app/:path*"] } },
    };
    const getSandbox = vi.fn();
    try {
      await expect(
        startAppPreview.execute(
          {
            command: { args: [], executable: "unused" },
            landingPath: "/",
            port: 3000,
            workingDirectory: ".",
          },
          { getSandbox, session: { auth: {}, id: "session-native" } } as never,
        ),
      ).rejects.toThrow("resource_mismatch");
      expect(getSandbox).not.toHaveBeenCalled();
    } finally {
      mocks.workflowState = previous;
    }
  });
  it("does not fall back to Sandbox when protected binding fails", async () => {
    mocks.nativeBindings.mockRejectedValueOnce(new Error("resource_mismatch"));
    const getSandbox = vi.fn();
    await expect(
      startAppPreview.execute(
        {
          command: { args: [], executable: "unused" },
          landingPath: "/",
          port: 3000,
          workingDirectory: ".",
        },
        { getSandbox, session: { auth: {}, id: "session-native" } } as never,
      ),
    ).rejects.toThrow("resource_mismatch");
    expect(getSandbox).not.toHaveBeenCalled();
  });
});
