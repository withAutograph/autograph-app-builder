/* oxlint-disable anti-slop/no-module-mocking -- Exercise the actual approval and execute callbacks with controlled Eve state and Sandbox command boundaries. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import repair from "../../agent/tools/repair-retained-preview-bin-modes";

const fixture = vi.hoisted(() => ({
  // SAFETY: Tool-owned state is opaque to these fixture callbacks.
  state: null as { plan: unknown } | null,
  // SAFETY: The fixture only supplies the preview fields read by the tool.
  preview: null as { receipt: { expiresAt: string } } | null,
  run: vi.fn(),
  assertCurrent: vi.fn(),
  result: {
    beforeDigest: "a".repeat(64),
    targets: [{ path: "packages/tools/cli.js", digest: "b".repeat(64), device: "1", inode: "2" }],
  },
}));
vi.mock("eve/context", () => ({
  defineState: () => ({
    get: () => fixture.state,
    update: (update: (state: typeof fixture.state) => NonNullable<typeof fixture.state>) => {
      fixture.state = update(fixture.state);
    },
  }),
}));
vi.mock("eve/tools", () => ({ defineTool: (definition: () => void) => definition }));
vi.mock("./workflow-state", async (importOriginal) => {
  const actual = await importOriginal<{ sha256: (value: string) => string }>();
  return { ...actual, appBuilderWorkflowState: { get: () => ({}) } };
});
vi.mock("../sandbox/deployment-execution-lease", () => ({
  assertHostedSandboxCommandAuthority: vi.fn(),
}));
vi.mock("./working-preview-state", () => ({
  workingPreviewState: { get: () => fixture.preview },
  workingPreviewAttemptState: { get: () => null },
}));
vi.mock("./prior-validated-private-artifact", () => ({
  resolvePriorValidatedPrivateArtifact: () => ({
    appId: "example",
    workspaceId: "sandbox",
    workspaceDigest: "workspace",
    appSpecDigest: "spec",
    sourceReceiptDigest: "source",
    denialEvidenceDigest: "denial",
    currentProposalDigest: "proposal",
    apply: { digest: "apply", postTreeDigest: "c".repeat(64) },
    validation: { digest: "validation" },
    root: "/workspace/repository",
    assertCurrent: fixture.assertCurrent,
  }),
}));

const context = (
  callId = "repair-call",
  sessionId = "session",
): Parameters<typeof repair.execute>[1] => ({
  session: {
    id: sessionId,
    auth: { current: null, initiator: null },
    turn: { id: "turn", sequence: 0 },
  },
  callId,
  toolName: "repair-retained-preview-bin-modes",
  abortSignal: new AbortController().signal,
  getSandbox: vi.fn().mockResolvedValue({ run: fixture.run }),
  getToken: vi.fn(),
  requireAuth: () => {
    throw new Error("Unexpected auth request.");
  },
});

const inspect = async () => {
  const result = await repair.execute({ operation: "inspect" }, context("inspect-call"));
  if (!("status" in result) || result.status !== "approval-required") {
    throw new Error("Expected a repair plan.");
  }
  return { operation: "repair" as const, planDigest: result.planDigest, files: result.files };
};

describe("retained bin repair approval", () => {
  beforeEach(() => {
    fixture.state = null;
    fixture.preview = null;
    fixture.assertCurrent.mockReset();
    fixture.run.mockReset().mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify(fixture.result),
    });
  });

  it("requires the fresh native approval call bound to exactly the inspected file list", async () => {
    const input = await inspect();
    const approve = repair.approval;
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Eve exposes either a fixed policy or a callback. This test exercises the callback.
    if (typeof approve !== "function") {
      throw new TypeError("Expected a dynamic approval policy.");
    }
    const request = (toolInput: typeof input, callId: string, sessionId?: string) =>
      approve({
        ...context(callId, sessionId),
        toolInput,
        approvedTools: new Set(),
        toolName: "repair-retained-preview-bin-modes",
      });
    await expect(repair.execute(input, context())).rejects.toThrow("fresh approval");
    expect(request({ ...input, files: ["packages/other/cli.js"] }, "repair-call")).toMatchObject({
      type: "denied",
    });
    expect(request(input, "repair-call", "foreign")).toMatchObject({ type: "denied" });
    expect(request(input, "repair-call")).toBe("user-approval");
    expect(request(input, "second-call")).toMatchObject({ type: "denied" });
    await expect(repair.execute(input, context("second-call"))).rejects.toThrow("fresh approval");
    expect(fixture.run).toHaveBeenCalledTimes(1);
    await expect(repair.execute(input, context())).resolves.toEqual({
      status: "restored",
      files: input.files,
    });
    await expect(repair.execute(input, context())).rejects.toThrow("fresh approval");
    expect(fixture.run).toHaveBeenCalledTimes(2);
  });

  it("preserves the current plan when an older inspection returns late", async () => {
    const response = Promise.withResolvers<{ exitCode: number; stdout: string }>();
    fixture.run.mockReturnValueOnce(response.promise);
    const older = inspect();
    await vi.waitFor(() => {
      expect(fixture.run).toHaveBeenCalledTimes(1);
    });
    const current = await inspect();
    const lateResult = expect(older).rejects.toThrow("changed concurrently");
    response.resolve({ exitCode: 0, stdout: JSON.stringify(fixture.result) });
    await lateResult;
    const approve = repair.approval;
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Exercise Eve's dynamic policy form.
    if (typeof approve !== "function") {
      throw new TypeError("Expected a dynamic approval policy.");
    }
    expect(
      approve({
        ...context(),
        approvedTools: new Set(["repair-retained-preview-bin-modes"]),
        toolInput: current,
      }),
    ).toBe("user-approval");
  });

  it("does not execute with an active private preview", async () => {
    fixture.preview = { receipt: { expiresAt: new Date(Date.now() + 60_000).toISOString() } };
    await expect(inspect()).rejects.toThrow("startup attempt");
    expect(fixture.run).not.toHaveBeenCalled();
  });
});
