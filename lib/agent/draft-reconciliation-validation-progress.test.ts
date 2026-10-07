/* oxlint-disable anti-slop/no-module-mocking, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, typescript/no-unsafe-type-assertion, eslint/require-await -- Isolated Eve state and sandbox stubs exercise the real validation tool. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import validateReconciliation from "../../agent/tools/validate_github_draft_pr_reconciliation";

const digest = "a".repeat(64);
const tree = "b".repeat(40);
const installCommand = "mise exec -- bun install --frozen-lockfile";
const schemaCommand = "mise run --skip-tools schema:release -- compile --app spend-review";
const mocks = vi.hoisted(() => ({
  candidate: null as Record<string, unknown> | null,
  check: vi.fn(),
  inspect: vi.fn(),
  publish: vi.fn(),
  run: vi.fn(),
  workflow: null as Record<string, unknown> | null,
}));

vi.mock("./compiled-operator-artifacts", () => ({
  publishCompiledOperatorArtifactsForSession: mocks.publish,
}));
vi.mock("eve/tools", () => ({ defineTool: <T>(value: T): T => value }));
vi.mock("./source-bound-sandbox", () => ({
  getSourceBoundSandbox: async () => ({ readTextFile: vi.fn(), run: mocks.run }),
}));
vi.mock("./draft-reconciliation-state", () => ({
  draftReconciliationState: { get: () => mocks.candidate },
  updateExactDraftReconciliation: ({ transition }: { transition: () => unknown }) => {
    mocks.candidate = transition() as Record<string, unknown>;
  },
}));
vi.mock("./workflow-state", () => ({
  appBuilderWorkflowState: { get: () => mocks.workflow },
}));
vi.mock("../repository/sandbox-draft-reconciliation", () => ({
  inspectDraftReconciliation: mocks.inspect,
}));
vi.mock("../../agent/tools/prepare-app-local-preview", () => ({
  appDeclaresLocalSetup: async () => false,
  localPreviewExecutionCommand: () => "mise run app:local -- spend-review setup",
  prepareAppLocalPreview: vi.fn(),
  prepareValidationLocalData: vi.fn(),
}));
vi.mock("../../agent/tools/compile-app-schema-release", () => ({
  appSchemaReleaseCommand: () => schemaCommand,
  compileAppSchemaRelease: async (input: { onCompiled?: () => Promise<void> }) => {
    await input.onCompiled?.();
    return { command: schemaCommand, exitCode: 0, status: "compiled", stderr: "", stdout: "" };
  },
}));
vi.mock("../../agent/tools/run-app-browser-tests", () => ({
  appBrowserTestCommand: () => "mise run --skip-tools //apps/spend-review:test-e2e",
  runAppBrowserTests: vi.fn(),
}));
vi.mock("../repository/target-validation", () => ({
  sandboxValidationCommandExecutor: () => mocks.check,
  validationOutputExcerpt: (stdout: string, stderr: string) => ({ stderr, stdout }),
}));

const context = {
  abortSignal: new AbortController().signal,
  callId: "validation_1",
  session: { auth: { owned: "auth" }, id: "adapter" },
} as never;

const incremental = async (expectedCommand: string) =>
  await validateReconciliation.execute(
    { additionalCheckTasks: [], expectedCommand, incremental: true, runBrowserTests: false },
    context,
  );

describe("draft reconciliation command progress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.candidate = {
      appId: "spend-review",
      githubSourceDigest: digest,
      originalReviewDigest: digest,
      root: "/workspace/candidate",
      version: 1,
    };
    mocks.workflow = {
      appSpec: { digest },
      githubSource: { digest },
      phase: "reviewed",
      reviewReceipt: { digest },
    };
    mocks.inspect.mockResolvedValue({ resolvedTree: tree, unresolvedConflicts: [] });
    mocks.run.mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });
    mocks.check.mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });
  });

  it("records one completed command and the next command across calls", async () => {
    await expect(incremental(installCommand)).resolves.toMatchObject({
      command: installCommand,
      nextCommand: schemaCommand,
      passedCommands: 1,
      status: "in_progress",
    });
    expect(mocks.run).toHaveBeenCalledOnce();
    await expect(incremental(schemaCommand)).resolves.toMatchObject({
      command: schemaCommand,
      passedCommands: 2,
      status: "in_progress",
    });
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(mocks.candidate?.validationRun).toMatchObject({ nextIndex: 2 });
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterSessionId: "adapter",
        appSpecDigest: digest,
        root: "/workspace/candidate",
      }),
    );
  });

  it("keeps the original single-call validation path available", async () => {
    await expect(
      validateReconciliation.execute(
        { additionalCheckTasks: [], incremental: false, runBrowserTests: false },
        context,
      ),
    ).resolves.toMatchObject({ status: "validated" });
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(mocks.candidate?.validation).toMatchObject({
      commands: [
        { command: installCommand, exitCode: 0 },
        { command: schemaCommand, exitCode: 0 },
        { command: "mise run --skip-tools app:check spend-review", exitCode: 0 },
        { command: "mise run --skip-tools app:test spend-review 1/1", exitCode: 0 },
      ],
    });
  });

  it("rejects a command that does not match the durable next step", async () => {
    await incremental(installCommand);
    await expect(incremental(installCommand)).rejects.toThrow(`ready for ${schemaCommand}`);
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it("resumes each remaining command and validates only after the final result", async () => {
    let nextCommand = installCommand;
    const completed: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each result supplies the next command.
      const result = (await incremental(nextCommand)) as {
        command: string;
        nextCommand?: string;
        status: "in_progress" | "validated";
      };
      completed.push(result.command);
      if (result.status === "in_progress") {
        expect(mocks.candidate?.validation).toBeUndefined();
        nextCommand = result.nextCommand ?? "";
      } else {
        expect(result.status).toBe("validated");
      }
    }
    expect(completed).toEqual([
      installCommand,
      schemaCommand,
      "mise run --skip-tools app:check spend-review",
      "mise run --skip-tools app:test spend-review 1/1",
    ]);
    expect(mocks.candidate?.validation).toMatchObject({
      commands: completed.map((command) => ({ command, exitCode: 0 })),
    });
    expect(mocks.candidate?.validationRun).toBeUndefined();
  });

  it("keeps the pending command and does not validate after an interrupted provider call", async () => {
    await incremental(installCommand);
    await incremental(schemaCommand);
    const check = "mise run --skip-tools app:check spend-review";
    mocks.check.mockRejectedValueOnce(new Error("sandbox expired"));
    await expect(incremental(check)).rejects.toThrow(
      `Builder could not run ${check} during draft PR candidate validation`,
    );
    expect(mocks.candidate?.validation).toBeUndefined();
    expect(mocks.candidate?.validationRun).toMatchObject({ nextIndex: 2 });
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterSessionId: "adapter",
        appSpecDigest: digest,
        root: "/workspace/candidate",
      }),
    );
    await expect(incremental(check)).resolves.toMatchObject({ status: "in_progress" });
    expect(mocks.candidate?.validation).toBeUndefined();
  });

  it("restarts validation from install when the checkout changes between calls", async () => {
    await incremental(installCommand);
    mocks.inspect.mockResolvedValue({ resolvedTree: "c".repeat(40), unresolvedConflicts: [] });
    await expect(incremental(installCommand)).resolves.toMatchObject({
      command: installCommand,
      passedCommands: 1,
      status: "in_progress",
    });
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });

  it("returns a command-specific failure without recording it as passed", async () => {
    mocks.run.mockResolvedValue({ exitCode: 1, stderr: "lockfile mismatch", stdout: "" });
    await expect(incremental(installCommand)).resolves.toMatchObject({
      command: installCommand,
      exitCode: 1,
      output: { stderr: "lockfile mismatch" },
      status: "needs_repair",
    });
    expect(mocks.candidate?.validationRun).toMatchObject({ commands: [], nextIndex: 0 });
  });
});
