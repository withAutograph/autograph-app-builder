import { describe, expect, it, vi } from "vitest";
import preparedContext, { scopedPreparedAppContext } from "../../agent/tools/prepared_app_context";
import inspectToolchain from "../../agent/tools/inspect_sandbox_toolchain";
import { createPreparedAppContextReader } from "./prepared-provider-context";
import { HostedSessionAuthorityError } from "../hosted/session-authority";
import { activeBuilderModelId } from "../integrations/active-model";
import { parseRepositoryReference } from "../integrations/repository-access";

const initiating = {
  attributes: {
    "mcp:audience": "https://builder.example.test/mcp",
    "mcp:scopes": ["autograph:get", "autograph:session"],
    "mcp:workspace-id": "workspace-fixture",
  },
  authenticator: "mcp-oauth-jwks",
  issuer: "https://builder.example.test/api/auth",
  principalId: "owner-fixture",
  principalType: "user",
  subject: "owner-fixture",
};
const auth = { current: initiating, initiator: initiating };

describe("scoped internal diagnostics", () => {
  it("describes absent web context on an authenticated public MCP session without an access or workspace failure", async () => {
    // SAFETY: prepared_app_context consumes only session.auth; this fixture supplies a valid forwarded envelope.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The fixture provides the context fields consumed by this tool.
    const result = await preparedContext.execute({}, { session: { auth } } as never);
    if (!("note" in result)) {
      throw new Error("Expected a non-streaming diagnostic result");
    }
    expect(result).toMatchObject({
      diagnosticOnly: true,
      readinessScope: "web-prepared-app-context",
      status: "not-prepared",
    });
    expect(result.note).toContain("normal for public MCP builds");
    expect(result.note).toContain(
      "says nothing about the selected repository, workspace, or read access",
    );
    expect(result).not.toHaveProperty("access");
    expect(result).not.toHaveProperty("approval");
    expect(JSON.stringify(result)).not.toMatch(/principalId|mcp:scopes|owner-fixture/u);
  });

  it("does not reclassify a genuine authority failure as missing prepared context", async () => {
    const foreign = { ...initiating, principalId: "foreign-owner", subject: "foreign-owner" };
    // SAFETY: the fixture supplies the only consumed context field; the actual reader validates and rejects this foreign envelope.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The fixture provides only the consumed auth field, which the real reader rejects.
    const context = { session: { auth: { current: foreign, initiator: initiating } } } as never;
    await expect(preparedContext.execute({}, context)).rejects.toBeInstanceOf(
      HostedSessionAuthorityError,
    );
  });

  it.each(["authorization-required", "provider-unavailable"] as const)(
    "preserves the existing prepared %s provider projection and actions",
    async (status) => {
      const reader = createPreparedAppContextReader({
        async github() {
          const repository = parseRepositoryReference("acme/stock");
          return await Promise.resolve(
            status === "authorization-required"
              ? { action: "connect" as const, repository, scopes: [], status }
              : { repository, status },
          );
        },
        async readHandoff() {
          return await Promise.resolve({
            appId: "stock",
            appName: "Stock",
            brief: "Manage stock",
            connections: ["github", "vercel"],
            modelId: activeBuilderModelId,
            repository: { private: true, requestedName: "stock", resolvedFullName: "acme/stock" },
          });
        },
        async vercel() {
          return await Promise.resolve(
            status === "authorization-required"
              ? { action: "reconnect" as const, status }
              : { action: "retry" as const, retryable: true as const, status },
          );
        },
      });
      const projected = await reader(auth);
      const scoped = scopedPreparedAppContext(projected);
      expect(scoped.status).toBe("prepared");
      if (scoped.status !== "prepared" || projected.status !== "prepared") {
        throw new Error("Expected prepared fixture");
      }
      expect(scoped.access).toBe(projected.access);
      expect(scoped.app).toBe(projected.app);
      expect(scoped.resources).toBe(projected.resources);
      expect(scoped.access.github).toMatchObject({
        action: status === "authorization-required" ? "reconnect" : "retry",
        status,
      });
      expect(scoped.access.vercel.status).toBe(status);
      expect(scoped.diagnosticOnly).toBe(true);
      expect(scoped.note).toContain("grants no build or publication approval");
    },
  );

  it("keeps inspector version comparisons advisory and preserves an actual version-command failure", async () => {
    const run = vi.fn(async (input: { command: string }) => {
      if (input.command.startsWith("command -v ")) {
        return await Promise.resolve({
          exitCode: 0,
          stderr: "",
          stdout: `/usr/bin/${input.command.slice(11)}\n`,
        });
      }
      if (input.command === "bun --version") {
        return await Promise.resolve({ exitCode: 1, stderr: "cannot load runtime", stdout: "" });
      }
      return await Promise.resolve({ exitCode: 0, stderr: "", stdout: "observed tool version\n" });
    });
    const sandbox = { id: "owned-sandbox-fixture", run };
    // SAFETY: inspect_sandbox_toolchain consumes getSandbox only; the fixture exposes its required read-only command and provider identity capabilities.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The fixture exposes only this tool's consumed getSandbox capability.
    const context = { getSandbox: async () => await Promise.resolve(sandbox) } as never;
    const result = await inspectToolchain.execute({}, context);
    if (!("tools" in result)) {
      throw new Error("Expected a non-streaming inspection result");
    }
    expect(result).toMatchObject({
      backendBlockers: [],
      diagnosticOnly: true,
      readinessScope: "toolchain-configuration-observations",
      sandboxId: sandbox.id,
      toolchainReady: false,
    });
    expect(result.tools.find((tool) => tool.command === "bun")).toEqual({
      available: false,
      command: "bun",
    });
    expect(result.required.find((tool) => tool.command === "mise")?.matches).toBe(false);
    expect(result.note).toContain("not workspace readiness or build admission");
    expect(
      run.mock.calls.every(
        ([input]) =>
          input.command.startsWith("command -v ") || input.command.endsWith(" --version"),
      ),
    ).toBe(true);
  });

  it("propagates an actual Sandbox command refusal without a guessed readiness result", async () => {
    const error = new Error("Sandbox refused command");
    const sandbox = { id: "owned-sandbox-fixture", run: vi.fn().mockRejectedValue(error) };
    // SAFETY: the only consumed context capability is getSandbox; this terminal fixture refuses its real command dispatch.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The fixture's consumed command boundary rejects the real tool dispatch.
    const context = { getSandbox: async () => await Promise.resolve(sandbox) } as never;
    await expect(inspectToolchain.execute({}, context)).rejects.toBe(error);
  });
});
