/* oxlint-disable anti-slop/no-module-mocking -- Isolate Eve workflow authority at the real tool execute boundary. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "eve/tools";
import installTool, {
  appIntegrationsInstallCommand,
  installAppIntegrations,
} from "../../agent/tools/install-app-integrations";

const hooks = vi.hoisted(() => ({
  invalidate: vi.fn(),
  update: vi.fn(),
  sandbox: { run: vi.fn() },
  state: {
    phase: "applied",
    appSpec: { appId: "spend-review", digest: "accepted" },
    applyReceipt: { applyRoot: "/private/approved-checkout" },
  },
}));
vi.mock("eve/tools", () => ({ defineTool: <T>(tool: T) => tool }));
vi.mock("./workflow-state", () => ({
  appBuilderWorkflowState: { get: () => hooks.state },
  updateExactWorkflow: hooks.update,
}));
vi.mock("./product-behavior-state", () => ({
  invalidateProductBehaviorEvidence: hooks.invalidate,
}));
vi.mock("./source-bound-sandbox", () => ({
  getSourceBoundSandbox: () => Promise.resolve(hooks.sandbox),
}));

const context: ToolContext = {
  abortSignal: new AbortController().signal,
  callId: "install-integrations",
  getSandbox: () => Promise.reject(new Error("The source-bound sandbox fixture owns execution.")),
  getToken: () => Promise.reject(new Error("Installation must not request a provider token.")),
  requireAuth: () => {
    throw new Error("Installation must use the existing private build approval.");
  },
  session: {
    auth: { current: null, initiator: null },
    id: "integration-install-session",
    turn: { id: "integration-install-turn", sequence: 0 },
  },
  toolName: "install-app-integrations",
};

describe("private app integrations installation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hooks.state.phase = "applied";
    hooks.sandbox.run.mockResolvedValue({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        appId: "spend-review",
        status: "installed",
        files: ["apps/spend-review/app/integrations/receive.ts"],
        providers: ["quickbooks"],
      }),
    });
  });

  it("runs the fixed operation in the accepted private checkout and invalidates validation", async () => {
    const result = await installTool.execute({}, context);
    expect(hooks.sandbox.run).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "mise run integrations:install spend-review",
        workingDirectory: "/private/approved-checkout",
      }),
    );
    expect(result).toMatchObject({
      status: "installed",
      providers: ["quickbooks"],
      providerReadiness: "unverified",
    });
    expect(hooks.update).toHaveBeenCalled();
    expect(hooks.invalidate).toHaveBeenCalledWith("source-repair");
  });

  it.each(["empty", "planned", "app_spec_accepted", "change_set_accepted"])(
    "cannot install in the %s phase before approval or after review",
    async (phase) => {
      hooks.state.phase = phase;
      await expect(installTool.execute({}, context)).rejects.toThrow(
        "Apply the accepted private app build",
      );
      expect(hooks.sandbox.run).not.toHaveBeenCalled();
    },
  );

  it("rejects command injection in app identity before executing", () => {
    expect(() => appIntegrationsInstallCommand("spend-review; publish")).toThrow();
    expect(() => appIntegrationsInstallCommand("../other-app")).toThrow();
    expect(hooks.sandbox.run).not.toHaveBeenCalled();
  });

  it("reports absent opt-in without claiming readiness and exposes real command failure", async () => {
    hooks.sandbox.run.mockResolvedValueOnce({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        appId: "spend-review",
        status: "omitted",
        files: [],
        providers: [],
      }),
    });
    const omitted = await installAppIntegrations({
      appId: "spend-review",
      root: "/private/approved-checkout",
      sandbox: hooks.sandbox,
    });
    expect(omitted).toMatchObject({
      status: "omitted",
      files: [],
      providerReadiness: "unverified",
    });
    hooks.sandbox.run.mockResolvedValueOnce({
      exitCode: 2,
      stderr: "provider recipe unavailable",
      stdout: "",
    });
    const failed = await installAppIntegrations({
      appId: "spend-review",
      root: "/private/approved-checkout",
      sandbox: hooks.sandbox,
    });
    expect(failed).toMatchObject({
      status: "failed",
      exitCode: 2,
      stderr: "provider recipe unavailable",
    });
  });

  it("reports the app-bound capability problem from the repository's JSON failure receipt", async () => {
    hooks.sandbox.run.mockResolvedValueOnce({
      exitCode: 2,
      stderr: "",
      stdout: JSON.stringify({
        appId: "spend-review",
        status: "capability-gap",
        files: [],
        providers: [],
        problem: "Integration server host is unavailable; token=secret-access-token",
        internal: "private-source-payload",
      }),
    });
    const failed = await installAppIntegrations({
      appId: "spend-review",
      root: "/private/approved-checkout",
      sandbox: hooks.sandbox,
    });
    expect(failed).toMatchObject({ status: "failed", exitCode: 2, stderr: "" });
    expect(failed.problem).toContain("Integration server host is unavailable");
    expect(JSON.stringify(failed)).not.toContain("secret-access-token");
    expect(JSON.stringify(failed)).not.toContain("private-source-payload");
  });

  it.each([
    "not-json",
    JSON.stringify({
      appId: "another-app",
      status: "capability-gap",
      problem: "foreign diagnosis",
    }),
    JSON.stringify({ appId: "spend-review", status: "installed", problem: "false success" }),
  ])("keeps malformed or unrelated failure receipts generic: %s", async (stdout) => {
    hooks.sandbox.run.mockResolvedValueOnce({ exitCode: 2, stderr: "", stdout });
    const failed = await installAppIntegrations({
      appId: "spend-review",
      root: "/private/approved-checkout",
      sandbox: hooks.sandbox,
    });
    expect(failed).toMatchObject({ status: "failed", exitCode: 2 });
    expect(failed.problem).toContain("The app integration installer failed");
    expect(failed.problem).not.toContain("foreign diagnosis");
    expect(failed.problem).not.toContain("false success");
  });

  it("rejects a receipt for another app and redacts credential-bearing command errors", async () => {
    hooks.sandbox.run.mockResolvedValueOnce({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        appId: "another-app",
        status: "installed",
        files: [],
        providers: [],
      }),
    });
    expect(
      await installAppIntegrations({
        appId: "spend-review",
        root: "/private/approved-checkout",
        sandbox: hooks.sandbox,
      }),
    ).toMatchObject({ status: "failed" });
    hooks.sandbox.run.mockRejectedValueOnce(new Error("token=secret-access-token"));
    const failed = await installAppIntegrations({
      appId: "spend-review",
      root: "/private/approved-checkout",
      sandbox: hooks.sandbox,
    });
    expect(failed.status).toBe("failed");
    expect(JSON.stringify(failed)).not.toContain("secret-access-token");
  });
});
