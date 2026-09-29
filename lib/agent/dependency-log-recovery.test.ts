import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import getValidationLog, { validationLogInputSchema } from "../../agent/tools/get_validation_log";

const mocks = vi.hoisted(() => ({
  attempts: [
    {
      attemptDigest: "a".repeat(64),
      command: "dependency-install",
      durability: "unavailable",
      logs: {},
    },
  ],
}));
// oxlint-disable-next-line anti-slop/no-module-mocking, anti-slop/no-unknown-parameters -- Exercise the tool contract without starting an Eve runtime.
vi.mock("eve/tools", () => ({ defineTool: (value: unknown) => value }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Restore a saved session state while compute is unavailable.
vi.mock("./workflow-state", () => ({
  appBuilderWorkflowState: {
    get: () => ({ checkoutDependencyAttempts: mocks.attempts, phase: "prepared" }),
  },
}));

const auth = (workspace = "workspace-a", user = "user-a") => ({
  attributes: {
    "mcp:audience": "https://builder.example.test/mcp",
    "mcp:scopes": ["eve:start"],
    "mcp:workspace-id": workspace,
  },
  authenticator: "mcp-oauth-jwks" as const,
  issuer: "https://builder.example.test/api/auth",
  principalId: user,
  principalType: "user" as const,
  subject: user,
});
const context = (current = auth(), initiator = current) => ({
  abortSignal: new AbortController().signal,
  callId: "read-log",
  getSandbox: vi.fn().mockRejectedValue(new Error("compute cleaned up")),
  getSkill: vi.fn(),
  getToken: vi.fn(),
  requireAuth: (): never => {
    throw new Error("Unexpected authentication redirect");
  },
  session: { auth: { current, initiator }, id: "session-a", turn: { id: "turn", sequence: 0 } },
  toolName: "get_validation_log",
});

describe("saved dependency log recovery", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "");
  });
  it("retrieves saved attempts with verified authority after compute and storage are unavailable", async () => {
    const ctx = context();
    const result = await getValidationLog.execute({ operation: "dependency-attempts" }, ctx);
    expect(result).toEqual({ attempts: mocks.attempts });
    expect(ctx.getSandbox).not.toHaveBeenCalled();
  });
  it("rejects changed tenant and initiating user authority", async () => {
    await expect(
      getValidationLog.execute(
        { operation: "dependency-attempts" },
        context(auth("workspace-b"), auth()),
      ),
    ).rejects.toThrow("authority");
    await expect(
      getValidationLog.execute(
        { operation: "dependency-attempts" },
        context(auth("workspace-a", "user-b"), auth()),
      ),
    ).rejects.toThrow("authority");
  });
  it("accepts old and dependency command identities without loosening digest-bound page inputs", () => {
    for (const command of ["check-build", "test", "dependency-probe", "dependency-install"]) {
      const result = validationLogInputSchema.safeParse({
        attemptDigest: "a".repeat(64),
        channel: "stdout",
        command,
        digest: "b".repeat(64),
        logId: "123e4567-e89b-42d3-a456-426614174001",
      });
      expect(result.success).toBe(true);
    }
    const invalid = validationLogInputSchema.safeParse({
      attemptDigest: "bad",
      channel: "stdout",
      command: "dependency-install",
      digest: "b".repeat(64),
      logId: "123e4567-e89b-42d3-a456-426614174001",
    });
    expect(invalid.success).toBe(false);
  });
});
