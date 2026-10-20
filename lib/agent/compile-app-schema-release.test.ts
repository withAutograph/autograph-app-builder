/* oxlint-disable anti-slop/no-module-mocking -- Eve state and owner publication ports isolate the actual production tool execute boundary. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { validationOutputExcerpt } from "../repository/target-validation";
import { safeCommandOutput } from "./command-output";
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
  rememberInputs: vi.fn(),
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
  rememberCompiledSchemaPredecessors: hooks.rememberInputs,
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
  it("retains original prepared references only after successful capture", async () => {
    const selection = { appId: "spend-review", releaseId: "original-v13" };
    hooks.predecessor.mockResolvedValue({ environment: {}, predecessors: [{ selection }] });
    hooks.publish.mockResolvedValue({ selection: { releaseId: "new-v14" }, status: "published" });
    const sandbox = { run: vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" }) };
    const ctx = {
      callId: "compile",
      getSandbox: async () => await Promise.resolve(sandbox),
      session: { auth: {}, id: "saved-session" },
    };
    // SAFETY: The identity defineTool fixture exposes the real tool with every consumed context field.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The fixture supplies the complete consumed execution context.
    expect(await compileTool.execute({}, ctx as never)).toMatchObject({ status: "compiled" });
    expect(hooks.rememberInputs).toHaveBeenCalledWith("spend-review", [selection], {
      releaseId: "new-v14",
    });
    hooks.rememberInputs.mockClear();
    hooks.publish.mockRejectedValue(new Error("capture unavailable"));
    // SAFETY: The same context fixture is used above for the real execute boundary.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- All consumed execution fields are supplied.
    expect(await compileTool.execute({}, ctx as never)).toMatchObject({ status: "failed" });
    expect(hooks.rememberInputs).not.toHaveBeenCalled();
    sandbox.run.mockResolvedValue({ exitCode: 1, stderr: "invalid CUE", stdout: "" });
    // SAFETY: The same context fixture is used above for the real execute boundary.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- All consumed execution fields are supplied.
    expect(await compileTool.execute({}, ctx as never)).toMatchObject({ status: "failed" });
    expect(hooks.rememberInputs).not.toHaveBeenCalled();
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
    expect(appSchemaReleaseCommand("spend-review")).toBe(
      "mise run --no-deps app:compile spend-review",
    );
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
      command: "mise run --no-deps app:compile spend-review",
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

  it.each([
    {
      command: "mise run app:runtime installed spend-review local",
      exitCode: 7,
      reason: "command-failed" as const,
      stage: "probe" as const,
    },
    {
      command: "mise run app:runtime installed spend-review local",
      exitCode: 0,
      reason: "invalid-receipt" as const,
      stage: "receipt" as const,
    },
    { reason: "missing-history" as const, stage: "retained-lookup" as const },
    { reason: "artifact-mismatch" as const, stage: "match" as const },
    { reason: "write-failed" as const, stage: "restore" as const },
  ])(
    "reports predecessor recovery $stage without claiming the app compiler ran",
    async (recovery) => {
      hooks.predecessor.mockRejectedValue(
        new SchemaPredecessorError("canonical_schema_predecessor_unavailable", recovery),
      );
      const sandbox = { run: vi.fn(), writeBinaryFile: vi.fn() };
      const ctx = {
        abortSignal: new AbortController().signal,
        callId: "predecessor-diagnostic",
        getSandbox: async () => await Promise.resolve(sandbox),
        session: { auth: { owned: "private-session" }, id: "saved-private-session" },
      };
      // SAFETY: The existing identity defineTool fixture exposes the real execute method; every consumed context field is supplied.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The production compile tool never reads other Eve context fields in this fixture.
      const result = await compileTool.execute({}, ctx as never);
      expect(result).toMatchObject({
        code: "canonical_schema_predecessor_unavailable",
        command: "command" in recovery ? recovery.command : null,
        compilerExecuted: false,
        exitCode: "exitCode" in recovery ? recovery.exitCode : null,
        recovery,
        status: "failed",
        stderr: "",
        stdout: "",
      });
      expect(sandbox.run).not.toHaveBeenCalled();
      expect(sandbox.writeBinaryFile).not.toHaveBeenCalled();
      expect(hooks.publish).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("private-session");
    },
  );
  it("surfaces only the bounded predecessor command summary and never runs the compiler on probe failure", async () => {
    const recovery = {
      command: "mise run app:runtime installed spend-review local",
      diagnostic: "could not connect to local runtime; DATABASE_URL=[REDACTED]",
      exitCode: 1,
      outputPresence: { stderr: true, stdout: true },
      reason: "command-failed" as const,
      stage: "probe" as const,
    };
    hooks.predecessor.mockRejectedValue(
      new SchemaPredecessorError("canonical_schema_predecessor_unavailable", recovery),
    );
    const sandbox = { run: vi.fn(), writeBinaryFile: vi.fn() };
    const ctx = {
      abortSignal: new AbortController().signal,
      callId: "predecessor-diagnostic",
      getSandbox: async () => await Promise.resolve(sandbox),
      session: { auth: { owned: "private-session" }, id: "saved-private-session" },
    };
    // SAFETY: The existing identity defineTool fixture exposes the real execute method; every consumed context field is supplied.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The production compile tool never reads other Eve context fields in this fixture.
    const result = await compileTool.execute({}, ctx as never);
    expect(result).toMatchObject({
      command: recovery.command,
      compilerExecuted: false,
      exitCode: 1,
      recovery,
      status: "failed",
    });
    expect(JSON.stringify(result)).toContain("failed before schema compilation");
    expect(sandbox.run).not.toHaveBeenCalled();
    expect(sandbox.writeBinaryFile).not.toHaveBeenCalled();
  });

  it("retains restoration diagnostics after the compiler has actually completed", async () => {
    const recovery = { reason: "write-failed" as const, stage: "restore" as const };
    const result = await compileAppSchemaRelease({
      appId: "spend-review",
      onCompiled: async () => {
        await Promise.reject(
          new SchemaPredecessorError("canonical_schema_predecessor_unavailable", recovery),
        );
      },
      root: "/workspace/repository",
      sandbox: { run: vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "compiled" }) },
    });
    expect(result).toMatchObject({
      command: "mise run --no-deps app:compile spend-review",
      compilerExecuted: true,
      exitCode: 0,
      recovery,
      status: "failed",
    });
  });
});

it.each([false, true])(
  "retains compiler task diagnostics through candidate reporting (ANSI=%s)",
  async (ansi) => {
    const label = ansi ? "\u001B[34m[app:compile]\u001B[0m" : "[app:compile]";
    const detail = "apps/example/schema/app.cue:18: conflicting values";
    const result = await compileAppSchemaRelease({
      appId: "example",
      root: "/workspace/repository",
      sandbox: {
        run: vi.fn().mockResolvedValue({
          exitCode: 1,
          stdout: `${label} compiler starting`,
          stderr: `${label} ${detail}\n${label}     field: expected string\n${label}     ^`,
        }),
      },
    });
    expect(result).toMatchObject({ status: "failed", exitCode: 1 });
    expect(result.stderr).toContain(detail);
    expect(result.stderr).toContain("    field: expected string");
    expect(validationOutputExcerpt(result.stdout, result.stderr).stderr).toContain(detail);
  },
);

it("keeps decorated structured compiler payloads and credentials private", async () => {
  const stderr = [
    "[app:compile] apps/example/schema/app.cue:8: conflicting values",
    '[app:compile] {"private":"private-single-canary"}',
    "[app:compile] {",
    '[app:compile]   "private": "private-multiline-canary",',
    '[app:compile]   "nested": [{"value":"private-nested-canary"}]',
    "[app:compile] }",
    '[app:compile] ["private-array-canary"]',
    "[app:compile] token=private-token-canary Authorization: Bearer private-bearer-canary",
    "[app:compile] https://private-user:private-password@private-host/private-path",
    "[app:compile] apps/example/schema/app.cue:9: invalid field",
  ].join("\n");
  const result = await compileAppSchemaRelease({
    appId: "example",
    root: "/workspace/repository",
    sandbox: { run: vi.fn().mockResolvedValue({ exitCode: 1, stdout: "", stderr }) },
  });
  expect(result.stderr).toContain("conflicting values");
  expect(result.stderr).toContain("invalid field");
  expect(result.stderr).toContain("[structured output redacted]");
  expect(result.stderr).toContain("[REDACTED]");
  expect(JSON.stringify(result)).not.toContain("private-");
  expect(safeCommandOutput('{"private":"private-default-canary"}')).not.toContain(
    "private-default-canary",
  );
  expect(safeCommandOutput('["private-default-array"]')).not.toContain("private-default-array");
});
