/* oxlint-disable anti-slop/no-module-mocking -- Eve state and owner publication ports isolate the actual production tool execute boundary. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SchemaPredecessorError } from "./schema-predecessor";

import compileTool, {
  appSchemaReleaseCommand,
  compileAppSchemaRelease,
} from "../../agent/tools/compile-app-schema-release";

const hooks = vi.hoisted(() => ({
  invalidate: vi.fn(),
  predecessor: vi.fn(),
  publish: vi.fn(),
  releaseIdentity: vi.fn(),
  remember: vi.fn(),
  state: {
    appSpec: { appId: "spend-review", digest: "a".repeat(64) },
    applyReceipt: { applyRoot: "/workspace/repository" },
    phase: "applied",
  },
}));
vi.mock("eve/tools", () => ({ defineTool: <T>(tool: T) => tool }));
vi.mock("./workflow-state", () => ({
  APP_BUILDER_WORKFLOW_VERSION: 1,
  appBuilderWorkflowState: { get: () => hooks.state },
  updateExactWorkflow: vi.fn(),
}));
vi.mock("./schema-predecessor", async (importOriginal) => ({
  ...(await importOriginal<{ SchemaPredecessorError: typeof SchemaPredecessorError }>()),
  assertCompiledSchemaReleaseIdentity: hooks.releaseIdentity,
  prepareCanonicalSchemaPredecessorsForSession: hooks.predecessor,
}));
vi.mock("./schema-predecessor-state", () => ({
  canonicalSchemaPredecessorState: { get: () => [] },
  rememberCanonicalSchemaRelease: hooks.remember,
}));
vi.mock("./product-behavior-state", () => ({
  invalidateProductBehaviorEvidence: hooks.invalidate,
}));
vi.mock("./refresh-planning-source", () => ({
  refreshPlanningSource: async (ctx: { getSandbox: () => Promise<{ id?: string }> }) =>
    await ctx.getSandbox(),
}));
vi.mock("./compiled-operator-artifacts", () => ({
  publishCompiledOperatorArtifactsForSession: hooks.publish,
}));

describe("private app schema release compilation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hooks.predecessor.mockResolvedValue({ environment: {}, predecessors: [] });
    hooks.publish.mockResolvedValue({ status: "not-required" });
  });
  it("publishes only after a successful compiler and reports capture failure", async () => {
    const onCompiled = vi.fn(async () => {
      await Promise.resolve();
    });
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "compiled" });
    await expect(
      compileAppSchemaRelease({
        appId: "spend-review",
        onCompiled,
        root: "/workspace/repository",
        sandbox: { run },
      }),
    ).resolves.toMatchObject({ status: "compiled" });
    expect(onCompiled).toHaveBeenCalledTimes(1);
    run.mockResolvedValue({ exitCode: 1, stderr: "invalid CUE", stdout: "" });
    await compileAppSchemaRelease({
      appId: "spend-review",
      onCompiled,
      root: "/workspace/repository",
      sandbox: { run },
    });
    expect(onCompiled).toHaveBeenCalledTimes(1);
    run.mockResolvedValue({ exitCode: 0, stderr: "", stdout: "compiled" });
    onCompiled.mockRejectedValue(new Error("private resource"));
    const failed = await compileAppSchemaRelease({
      appId: "spend-review",
      onCompiled,
      root: "/workspace/repository",
      sandbox: { run },
    });
    expect(failed).toMatchObject({ exitCode: 0, status: "failed" });
    expect(JSON.stringify(failed)).not.toContain("private resource");
  });
  it("production execution supplies current session and approved workflow facts to capture", async () => {
    const sandbox = {
      readBinaryFile: vi.fn(),
      run: vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "compiled" }),
    };
    const ctx = {
      abortSignal: new AbortController().signal,
      callId: "compile_call",
      getSandbox: async () => await Promise.resolve(sandbox),
      session: { auth: { owned: "session-auth" }, id: "adapter-session" },
    };
    // SAFETY: The isolated Eve defineTool mock exposes the actual production execute method.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test supplies every field read by the actual tool through an identity defineTool fixture.
    await compileTool.execute({}, ctx as never);
    expect(hooks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterSessionId: "adapter-session",
        appId: "spend-review",
        appSpecDigest: "a".repeat(64),
        callId: "compile_call",
        root: "/workspace/repository",
        sandbox,
        sessionAuth: ctx.session.auth,
        signal: ctx.abortSignal,
      }),
    );
  });
  it("returns a typed reused-identity outcome instead of calling it a storage failure", async () => {
    const identityFailure = new SchemaPredecessorError("schema_release_identity_reused");
    expect(identityFailure.code).toBe("schema_release_identity_reused");
    const result = await compileAppSchemaRelease({
      appId: "spend-review",
      environment: {
        APP_SCHEMA_TRANSITION_PREDECESSOR_FILES:
          '["/workspace/.app-builder/schema-predecessors/exact.json"]',
      },
      onCompiled: async () => {
        await Promise.reject(identityFailure);
      },
      root: "/workspace/repository",
      sandbox: { run: vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "compiled" }) },
    });
    expect(result).toMatchObject({
      code: "schema_release_identity_reused",
      exitCode: 0,
      status: "failed",
    });
    expect(result.problem).toContain("Author a new schema release ID");
  });

  it("targets only the selected app with a fixed repository task", () => {
    expect(appSchemaReleaseCommand("spend-review")).toBe("mise run app:compile spend-review");
    expect(() => appSchemaReleaseCommand("spend-review; deploy")).toThrow();
  });

  it("returns a useful compiler failure without losing the failing command", async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: 1,
      stderr: "apps/spend-review/schema/spend-review.cue:18: conflicting values",
      stdout: "",
    });
    const result = await compileAppSchemaRelease({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run },
    });
    expect(run).toHaveBeenCalledWith({
      command: "mise run app:compile spend-review",
      workingDirectory: "/workspace/repository",
    });
    expect(result).toMatchObject({
      exitCode: 1,
      status: "failed",
      stderr: "apps/spend-review/schema/spend-review.cue:18: conflicting values",
    });
    expect(result.problem).toContain("fix the named CUE source");
  });

  it("names provider failures and removes credentials", async () => {
    const run = vi.fn().mockRejectedValue(new Error("Sandbox aborted: token=secret-value"));
    const result = await compileAppSchemaRelease({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run },
    });
    expect(result).toMatchObject({ exitCode: null, status: "failed" });
    expect(result.problem).toContain("Sandbox aborted");
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });

  it("preserves complete sanitized compiler output", async () => {
    const detail = `apps/spend-review/schema/spend-review.cue:18: conflicting values ${"x".repeat(7000)}`;
    const run = vi.fn().mockResolvedValue({ exitCode: 1, stderr: detail, stdout: "" });
    const result = await compileAppSchemaRelease({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run },
    });
    expect(result.stderr).toBe(detail);
  });
});
