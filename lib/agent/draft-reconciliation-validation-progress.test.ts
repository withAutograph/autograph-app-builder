/* oxlint-disable anti-slop/no-module-mocking, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, typescript/no-unsafe-type-assertion, eslint/require-await -- Isolated Eve state and sandbox stubs exercise the real validation tool. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ValidationLogKey, ValidationLogReference, ValidationLogStore } from "../repository/validation-log";

import validateReconciliation from "../../agent/tools/validate_github_draft_pr_reconciliation";

const digest = "a".repeat(64);
const tree = "b".repeat(40);
const installCommand = "mise exec --no-deps -- bun install --frozen-lockfile";
const schemaCommand = "mise run --no-deps app:compile spend-review";
const mocks = vi.hoisted(() => ({
  candidate: null as Record<string, unknown> | null,
  attempts: [] as Record<string, unknown>[],
  check: vi.fn(),
  inspect: vi.fn(),
  logStore: vi.fn(),
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
  candidateValidationAttemptHistory: { get: () => mocks.attempts },
  draftReconciliationState: { get: () => mocks.candidate },
  retainCandidateValidationAttempt: (attempt: Record<string, unknown>) => mocks.attempts.push(attempt),
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
  appBrowserTestCommand: () => "mise run --no-deps app:runtime run spend-review test-e2e",
  runAppBrowserTests: vi.fn(),
}));
vi.mock("../repository/target-validation", () => ({
  sandboxValidationCommandExecutor: () => mocks.check,
  validationOutputExcerpt: (stdout: string, stderr: string) => ({ stderr, stdout }),
}));
vi.mock("./validation-log-store-for-session", () => ({
  validationLogStoreForSession: mocks.logStore,
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
    mocks.logStore.mockRejectedValue(new Error("log storage unavailable"));
    mocks.candidate = {
      appId: "spend-review",
      baseSha: "base-sha",
      githubSourceDigest: digest,
      headSha: "head-sha",
      headTree: tree,
      originalReviewDigest: digest,
      pullRequestNumber: 7,
      repositoryId: "repo-id",
      root: "/workspace/candidate",
      version: 1,
    };
    mocks.attempts = [];
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
        { command: "mise run --no-deps --skip-tools app:check spend-review", exitCode: 0 },
        { command: "mise run --no-deps --skip-tools app:test spend-review 1/1", exitCode: 0 },
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
      "mise run --no-deps --skip-tools app:check spend-review",
      "mise run --no-deps --skip-tools app:test spend-review 1/1",
    ]);
    expect(mocks.candidate?.validation).toMatchObject({
      commands: completed.map((command) => ({ command, exitCode: 0 })),
    });
    expect(mocks.candidate?.validationRun).toBeUndefined();
  });

  it("keeps the pending command and does not validate after an interrupted provider call", async () => {
    await incremental(installCommand);
    await incremental(schemaCommand);
    const check = "mise run --no-deps --skip-tools app:check spend-review";
    mocks.check.mockRejectedValueOnce(new Error("sandbox expired"));
    try {
      await incremental(check);
      throw new Error("Expected the interrupted command to fail.");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      const actual = error instanceof Error ? error : new Error(String(error));
      expect(actual.message).toContain(`Builder could not run ${check} during draft PR candidate validation`);
      expect(actual.cause).toMatchObject({ message: "sandbox expired" });
    }
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
    expect(mocks.attempts).toHaveLength(2);
    expect(mocks.attempts[0]).toMatchObject({
      category: "check-build",
      completion: "interrupted",
      durability: "unavailable",
      exitCode: null,
    });
    expect(mocks.attempts[1]).toMatchObject({
      completion: "complete",
      durability: "unavailable",
      exitCode: 0,
    });
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

  it.each([
    {
      kind: "install",
      original: "mise exec -- bun install --frozen-lockfile",
      current: installCommand,
    },
    {
      kind: "check",
      original: "mise run --skip-tools app:check spend-review",
      current: "mise run --no-deps --skip-tools app:check spend-review",
    },
    {
      kind: "check",
      original: "mise run --skip-tools app:test spend-review 1/1",
      current: "mise run --no-deps --skip-tools app:test spend-review 1/1",
    },
    {
      kind: "additional",
      original: "mise run --skip-tools check:vercel-services",
      current: "mise run --no-deps --skip-tools check:vercel-services",
    },
  ] as const)(
    "continues retained $kind metadata with explicit setup flags and keeps completed work",
    async (pending) => {
      const completed = { command: "mise run app:compile spend-review", exitCode: 0 };
      mocks.candidate = {
        ...mocks.candidate,
        validationRun: {
          commands: [completed],
          nextIndex: 1,
          resolvedTree: tree,
          steps: [
            { command: completed.command, kind: "schema" },
            { command: pending.original, kind: pending.kind },
            { command: "mise run app:runtime run spend-review test-e2e", kind: "browser" },
          ],
        },
      };
      await expect(incremental(pending.original)).resolves.toMatchObject({
        command: pending.current,
        nextCommand: "mise run --no-deps app:runtime run spend-review test-e2e",
        status: "in_progress",
      });
      const executor = pending.kind === "check" ? mocks.check : mocks.run;
      expect(executor).toHaveBeenCalledWith(expect.objectContaining({ command: pending.current }));
      expect(mocks.candidate?.validationRun).toMatchObject({
        commands: [completed, { command: pending.current, exitCode: 0 }],
        nextIndex: 2,
      });
    },
  );

  it("accepts the current semantic command when the pending receipt still has its historical spelling", async () => {
    mocks.candidate = {
      ...mocks.candidate,
      validationRun: {
        commands: [],
        nextIndex: 0,
        resolvedTree: tree,
        steps: [
          { kind: "install", command: "mise exec -- bun install --frozen-lockfile" },
          { kind: "schema", command: "mise run app:compile spend-review" },
        ],
      },
    };
    await expect(incremental(installCommand)).resolves.toMatchObject({
      command: installCommand,
      nextCommand: schemaCommand,
      status: "in_progress",
    });
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ command: installCommand }));
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

  it("retains one historical attempt for a real failed supported command", async () => {
    const manifests = new Map<string, ValidationLogReference>();
    const chunks = new Map<string, { content: string; digest: string }>();
    const keyFor = (key: ValidationLogKey) =>
      JSON.stringify([key.sessionId, key.attemptDigest, key.command, key.channel, key.logId]);
    const store: ValidationLogStore = {
      async getChunk(key, index) { return await Promise.resolve(chunks.get(`${keyFor(key)}:${index}`)); },
      async getReference(key) { return await Promise.resolve(manifests.get(keyFor(key))); },
      async publish(key, reference) { await Promise.resolve(manifests.set(keyFor(key), reference)); },
      async putChunk(key, index, content, chunkDigest) {
        await Promise.resolve(chunks.set(`${keyFor(key)}:${index}`, { content, digest: chunkDigest }));
      },
      async removeStaged(key) { await Promise.resolve(manifests.delete(keyFor(key))); },
    };
    mocks.logStore.mockResolvedValue(store);
    await incremental(installCommand);
    await incremental(schemaCommand);
    const check = "mise run --no-deps --skip-tools app:check spend-review";
    mocks.check.mockResolvedValueOnce({
      exitCode: 2,
      stderr: "assertion failed\nBearer sensitive-token\n",
      stdout: "check output\n",
    });
    await expect(incremental(check)).resolves.toMatchObject({
      exitCode: 2,
      output: { stderr: "assertion failed\nBearer sensitive-token\n", stdout: "check output\n" },
      status: "needs_repair",
    });
    expect(mocks.check).toHaveBeenCalledTimes(1);
    expect(mocks.check).toHaveBeenCalledWith(expect.objectContaining({
      appId: "spend-review",
      command: check,
      validationRoot: "/workspace/candidate",
    }));
    expect(mocks.check.mock.calls[0]?.[0]).not.toHaveProperty("onChunk");
    expect(mocks.attempts).toHaveLength(1);
    expect(mocks.attempts[0]).toMatchObject({
      category: "check-build",
      command: check,
      completion: "complete",
      durability: "available",
      exitCode: 2,
      logs: { stderr: { completion: "complete", channel: "stderr" } },
    });
    const attempt = mocks.attempts[0] as { attemptDigest: string; logs: { stderr: ValidationLogReference } };
    const key = {
      attemptDigest: attempt.attemptDigest,
      channel: "stderr" as const,
      command: "check-build" as const,
      logId: attempt.logs.stderr.logId,
      sessionId: "adapter",
    };
    expect(await store.getReference(key)).toMatchObject({ completion: "complete" });
    const chunk = await store.getChunk(key, 0);
    expect(chunk?.content).toContain("assertion failed");
    expect(chunk?.content).not.toContain("sensitive-token");
  });
});
