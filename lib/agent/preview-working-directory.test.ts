import { describe, expect, it, vi } from "vitest";
import startAppPreview from "../../agent/tools/start_app_preview";
import {
  previewWorkingDirectorySchema,
  resolvePreviewWorkingDirectory,
} from "./preview-working-directory";

const mocks = vi.hoisted(() => ({
  bind: vi.fn(),
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
      getSandbox: () => Promise.resolve({ id: "sandbox" }),
      session: { id: "session" },
    } as Parameters<typeof startAppPreview.execute>[1]);
    expect(mocks.bind).toHaveBeenCalledWith("preview-command", 3);
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({
        command: input.command,
        cwd: "/workspace/repository/apps/example",
        landingPath: "/review?tab=active",
      }),
    );
  });
});
