import type { runAppBrowserTests as runAppBrowserTestsPort } from "../../agent/tools/run-app-browser-tests";
import type { resolvePreparedRuntimeExecution } from "./prepared-runtime-execution";
/* oxlint-disable anti-slop/no-module-mocking, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, typescript/no-unsafe-type-assertion, eslint/require-await -- Isolated Eve state and sandbox stubs exercise the real validation tool. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ValidationLogKey,
  ValidationLogReference,
  ValidationLogStore,
} from "../repository/validation-log";

import type { retireUnusedDraftWorktrees } from "../repository/retire-unused-draft-worktrees";

import validateReconciliation from "../../agent/tools/validate_github_draft_pr_reconciliation";
import formatCandidate from "../../agent/tools/format_github_draft_pr_candidate";
import editCandidate from "../../agent/tools/edit_github_draft_pr_candidate";

const digest = "a".repeat(64);
const tree = "b".repeat(40);
const installCommand = "mise exec --no-deps -- bun install --frozen-lockfile";
const schemaCommand = "mise run --no-deps app:compile spend-review";
const checkCommand = "mise run --no-deps --skip-deps --skip-tools app:check spend-review";
const testCommand = "mise run --no-deps --skip-deps --skip-tools app:test spend-review 1/1";
const captureCommand = "Capture selected checked app release";
const mocks = vi.hoisted(() => ({
  candidate: null as Record<string, unknown> | null,
  completions: [] as { root: string }[],
  retire: vi.fn<typeof retireUnusedDraftWorktrees>(),
  attempts: [] as Record<string, unknown>[],
  check: vi.fn(),
  compile: vi.fn(),
  local: vi.fn(),
  browser: vi.fn(),
  resolveRuntime: vi.fn<typeof resolvePreparedRuntimeExecution>(),
  declaresLocal: false,
  inspect: vi.fn(),
  logStore: vi.fn(),
  publish: vi.fn(),
  run: vi.fn(),
  replace: vi.fn(),
  readText: vi.fn(),
  workflow: null as Record<string, unknown> | null,
}));

vi.mock("../repository/retire-unused-draft-worktrees", () => ({
  retireUnusedDraftWorktrees: mocks.retire,
}));
vi.mock("./compiled-operator-artifacts", () => ({
  publishCompiledOperatorArtifactsForSession: mocks.publish,
}));
vi.mock("eve/tools", () => ({ defineTool: <T>(value: T): T => value }));
vi.mock("./source-bound-sandbox", () => ({
  getSourceBoundSandbox: async () => ({
    id: "owned-provider-sandbox",
    readTextFile: mocks.readText,
    run: mocks.run,
  }),
}));
vi.mock("./draft-reconciliation-state", () => ({
  candidateValidationAttemptHistory: { get: () => mocks.attempts },
  draftReconciliationCompletions: { get: () => mocks.completions },
  draftReconciliationState: { get: () => mocks.candidate },
  retainCandidateValidationAttempt: (attempt: Record<string, unknown>) =>
    mocks.attempts.push(attempt),
  updateExactDraftReconciliation: ({ transition }: { transition: () => unknown }) => {
    mocks.candidate = transition() as Record<string, unknown>;
  },
}));
vi.mock("./workflow-state", () => ({
  appBuilderWorkflowState: { get: () => mocks.workflow },
}));
vi.mock("../repository/sandbox-draft-reconciliation", () => ({
  inspectDraftReconciliation: mocks.inspect,
  replaceDraftReconciliationCandidateText: mocks.replace,
  readDraftReconciliationCandidateFilePage: vi.fn(),
  restoreDraftReconciliationCandidateFile: vi.fn(),
}));
vi.mock("../../agent/tools/prepare-app-local-preview", () => ({
  appDeclaresLocalSetup: async () => mocks.declaresLocal,
  localPreviewExecutionCommand: () => "mise run app:local -- spend-review setup",
  prepareAppLocalPreview: mocks.local,
  prepareValidationLocalData: vi.fn(),
}));
vi.mock("../../agent/tools/compile-app-schema-release", () => ({
  appSchemaReleaseCommand: () => schemaCommand,
  compileAppSchemaRelease: mocks.compile,
}));
vi.mock("./prepared-runtime-execution", () => ({
  resolvePreparedRuntimeExecution: mocks.resolveRuntime,
}));
vi.mock("../../agent/tools/run-app-browser-tests", () => ({
  appBrowserTestCommand: () => "mise run --no-deps app:runtime run spend-review test-e2e",
  runAppBrowserTests: mocks.browser,
}));
vi.mock(import("../repository/target-validation"), async (importOriginal) => ({
  ...(await importOriginal()),
  sandboxValidationCommandExecutor: () => mocks.check,
  validationOutputExcerpt: (stdout: string, stderr: string) => ({
    stderr,
    stdout,
    truncated: false,
  }),
}));
vi.mock("./validation-log-store-for-session", () => ({
  validationLogStoreForSession: mocks.logStore,
}));

const abortSignal = new AbortController().signal;
const context = {
  abortSignal,
  callId: "validation_1",
  session: { auth: { owned: "auth" }, id: "adapter" },
} as never;

const incremental = async (expectedCommand: string) => {
  if (expectedCommand !== schemaCommand && mocks.candidate?.validationRun === undefined) {
    await validateReconciliation.execute(
      {
        additionalCheckTasks: [],
        expectedCommand: schemaCommand,
        incremental: true,
        runBrowserTests: false,
      },
      context,
    );
  }
  return await validateReconciliation.execute(
    { additionalCheckTasks: [], expectedCommand, incremental: true, runBrowserTests: false },
    context,
  );
};

describe("draft reconciliation command progress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.retire.mockResolvedValue({ status: "unavailable", retired: 0, retained: 0, reasons: {} });
    mocks.completions = [];
    mocks.publish.mockResolvedValue({
      status: "published",
      compilation: {
        context: {
          authority: { ownerUserId: "owner" },
          target: { appId: "spend-review", sessionId: "canonical-session" },
        },
        release: {
          status: "published",
          selection: {
            appId: "spend-review",
            appSpecDigest: digest,
            artifactRef: `_protected-operator/artifacts/generated-release/spend-review/${digest}`,
            releaseId: "captured-release",
            manifestSha256: digest,
            schemaSha256: digest,
            version: 1,
          },
        },
      },
    });
    mocks.readText.mockResolvedValue(
      JSON.stringify({
        scripts: { test: "vitest run" },
        devDependencies: { vitest: "workspace:*", "fixture-runner": "workspace:*" },
      }),
    );
    mocks.replace.mockResolvedValue({ digest, mode: "644" });
    mocks.declaresLocal = false;
    mocks.compile.mockResolvedValue({
      command: schemaCommand,
      exitCode: 0,
      status: "compiled",
      stderr: "",
      stdout: "",
    });
    mocks.local.mockResolvedValue({
      command: "mise run app:local -- spend-review setup",
      exitCode: 0,
      status: "prepared",
      stderr: "",
      stdout: "",
    });
    mocks.browser.mockResolvedValue({
      command: "mise run --no-deps app:runtime run spend-review test-e2e",
      exitCode: 0,
      status: "passed",
      stderr: "",
      stdout: "",
    });
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
      workspaceRoot: "/workspace",
      version: 1,
    };
    mocks.attempts = [];
    mocks.workflow = {
      appSpec: { digest },
      workspace: { workspacePath: "/workspace/repository" },
      applyReceipt: { applyRoot: "/workspace/applied" },
      validationReceipt: { commands: [{ validationRoot: "/workspace/validation" }] },
      githubSource: { digest },
      phase: "reviewed",
      reviewReceipt: { digest },
    };
    mocks.inspect.mockResolvedValue({
      resolvedTree: tree,
      unresolvedConflicts: [],
      baseChanges: [],
      headChanges: [],
    });
    mocks.run.mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });
    mocks.check.mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });
  });

  it("retires only unused worktrees before a direct failed-compilation retry", async () => {
    mocks.completions = [
      { root: "/workspace/completed-one" },
      { root: "/workspace/completed-two" },
    ];
    mocks.compile.mockResolvedValueOnce({
      command: schemaCommand,
      exitCode: 1,
      status: "failed",
      stderr: "No space left on device",
      stdout: "",
    });
    await expect(incremental(schemaCommand)).resolves.toMatchObject({ status: "needs_repair" });
    expect(mocks.candidate?.validationRun).not.toHaveProperty("schemaTaskCompleted", true);
    mocks.retire.mockClear();
    const events: string[] = [];
    mocks.retire.mockImplementation(async (input) => {
      expect(input).toMatchObject({
        workspaceRoot: "/workspace",
        retainedRoots: [
          "/workspace/repository",
          "/workspace/applied",
          "/workspace/validation",
          "/workspace/candidate",
          "/workspace/completed-one",
          "/workspace/completed-two",
        ],
        signal: abortSignal,
      });
      expect(input.sandbox.run).toBeTypeOf("function");
      events.push("retire");
      return { status: "complete", retired: 0, retained: 0, reasons: {} };
    });
    mocks.run.mockImplementation(async () => {
      events.push("attach");
      return { exitCode: 0, stderr: "", stdout: "" };
    });
    mocks.compile.mockImplementation(async () => {
      events.push("compile");
      return { command: schemaCommand, exitCode: 0, status: "compiled", stderr: "", stdout: "" };
    });
    await expect(incremental(schemaCommand)).resolves.toMatchObject({
      status: "in_progress",
      nextCommand: checkCommand,
    });
    expect(mocks.retire).toHaveBeenCalledOnce();
    expect(events.indexOf("retire")).toBeLessThan(events.indexOf("attach"));
    expect(events.indexOf("attach")).toBeLessThan(events.indexOf("compile"));
    expect(mocks.candidate?.validationRun).toMatchObject({ schemaTaskCompleted: true });
    await incremental(checkCommand);
    await incremental(testCommand);
    await expect(incremental(captureCommand)).resolves.toMatchObject({ status: "validated" });
    expect(mocks.retire).toHaveBeenCalledOnce();
  });

  it("does not retire worktrees for a candidate that fails the existing context check", async () => {
    mocks.workflow = { ...mocks.workflow, phase: "validated" };
    await expect(incremental(schemaCommand)).rejects.toThrow("no longer matches");
    expect(mocks.retire).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each(["format", "validate"] as const)(
    "attaches the saved candidate dependency view before direct resumed %s commands",
    async (operation) => {
      let attached = false;
      const events: string[] = [];
      const root = mocks.candidate?.root;
      mocks.run.mockImplementation((input: { command: string; workingDirectory?: string }) => {
        if (input.command === "mise run --no-deps --skip-tools format:app") {
          expect(attached).toBe(true);
          events.push("format");
        } else {
          expect(input.workingDirectory).toBe("/workspace");
          attached = true;
          events.push("attached");
        }
        return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
      });
      mocks.inspect.mockImplementation(() => {
        expect(attached).toBe(true);
        return Promise.resolve({
          resolvedTree: tree,
          unresolvedConflicts: [],
          baseChanges: [],
          headChanges: [],
        });
      });
      mocks.compile.mockImplementation(() => {
        expect(attached).toBe(true);
        events.push("compile");
        return Promise.resolve({
          command: schemaCommand,
          exitCode: 0,
          status: "compiled",
          stderr: "",
          stdout: "",
        });
      });
      if (operation === "format") {
        await expect(formatCandidate.execute({}, context)).resolves.toMatchObject({
          status: "formatted",
        });
        expect(events.indexOf("attached")).toBeLessThan(events.indexOf("format"));
        expect(mocks.compile).not.toHaveBeenCalled();
      } else {
        await expect(
          validateReconciliation.execute(
            {
              additionalCheckTasks: [],
              expectedCommand: schemaCommand,
              incremental: true,
              runBrowserTests: false,
            },
            context,
          ),
        ).resolves.toMatchObject({ status: "in_progress", command: schemaCommand });
        expect(events.indexOf("attached")).toBeLessThan(events.indexOf("compile"));
      }
      expect(mocks.candidate?.root).toBe(root);
      expect(mocks.run).not.toHaveBeenCalledWith(
        expect.objectContaining({ command: installCommand }),
      );
    },
  );

  it.each(["format", "validate"] as const)(
    "preserves an actual dependency attachment failure before resumed %s commands",
    async (operation) => {
      const saved = mocks.candidate;
      mocks.run.mockResolvedValueOnce({
        exitCode: 1,
        stderr: "existing dependency unavailable",
        stdout: "",
      });
      const result =
        operation === "format"
          ? formatCandidate.execute({}, context)
          : validateReconciliation.execute(
              {
                additionalCheckTasks: [],
                expectedCommand: schemaCommand,
                incremental: true,
                runBrowserTests: false,
              },
              context,
            );
      await expect(result).rejects.toThrow("could not attach the existing checkout dependencies");
      expect(mocks.candidate).toBe(saved);
      expect(mocks.compile).not.toHaveBeenCalled();
      expect(mocks.check).not.toHaveBeenCalled();
      expect(mocks.run).not.toHaveBeenCalledWith(
        expect.objectContaining({ command: "mise run --no-deps --skip-tools format:app" }),
      );
      expect(mocks.run).not.toHaveBeenCalledWith(
        expect.objectContaining({ command: installCommand }),
      );
    },
  );

  it("records checks before independently capturing the actual selected release", async () => {
    await expect(incremental(checkCommand)).resolves.toMatchObject({
      command: checkCommand,
      nextCommand: testCommand,
      passedCommands: 2,
      status: "in_progress",
    });
    expect(mocks.run).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: installCommand }),
    );
    expect(mocks.compile).toHaveBeenCalledOnce();
    expect(mocks.publish).not.toHaveBeenCalled();
    await expect(incremental(testCommand)).resolves.toMatchObject({
      nextCommand: captureCommand,
      status: "in_progress",
    });
    await expect(incremental(captureCommand)).resolves.toMatchObject({ status: "validated" });
    expect(mocks.candidate?.validation).toMatchObject({
      compilation: { release: { selection: { releaseId: "captured-release" } } },
    });
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
    expect(mocks.run).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: installCommand }),
    );
    expect(mocks.compile).toHaveBeenCalledOnce();
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(mocks.candidate?.validation).toMatchObject({
      compilation: { release: { selection: { releaseId: "captured-release" } } },
      commands: [
        { command: schemaCommand, exitCode: 0 },
        { command: checkCommand, exitCode: 0 },
        { command: testCommand, exitCode: 0 },
      ],
    });
  });

  it("rejects a command that does not match the durable next step", async () => {
    await incremental(checkCommand);
    await expect(incremental(checkCommand)).rejects.toThrow(`ready for ${testCommand}`);
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(mocks.run).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: installCommand }),
    );
  });

  it("resumes checks and capture and validates only after the final result", async () => {
    for (const command of [checkCommand, testCommand]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each durable tool call advances the same ordered validation run.
      await expect(incremental(command)).resolves.toMatchObject({ status: "in_progress" });
      expect(mocks.candidate?.validation).toBeUndefined();
    }
    await expect(incremental(captureCommand)).resolves.toMatchObject({ status: "validated" });
    expect(mocks.candidate?.validation).toMatchObject({
      commands: [schemaCommand, checkCommand, testCommand].map((command) => ({
        command,
        exitCode: 0,
      })),
      compilation: { release: { selection: { releaseId: "captured-release" } } },
    });
    expect(mocks.candidate?.validationRun).toBeUndefined();
  });

  it("keeps a pending command after an interrupted provider call without setting up again", async () => {
    mocks.check.mockRejectedValueOnce(new Error("sandbox expired"));
    await expect(incremental(checkCommand)).rejects.toThrow(
      `Builder could not run ${checkCommand} during draft PR candidate validation`,
    );
    expect(mocks.candidate?.validationRun).toMatchObject({
      nextIndex: 1,
      commands: [{ command: schemaCommand, exitCode: 0 }],
    });
    expect(mocks.publish).not.toHaveBeenCalled();
    await expect(incremental(checkCommand)).resolves.toMatchObject({ status: "in_progress" });
    expect(mocks.attempts).toHaveLength(2);
    expect(mocks.attempts[0]).toMatchObject({
      category: "check-build",
      completion: "interrupted",
      exitCode: null,
    });
    expect(mocks.attempts[1]).toMatchObject({ completion: "complete", exitCode: 0 });
    expect(mocks.run).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: installCommand }),
    );
    expect(mocks.compile).toHaveBeenCalledOnce();
  });

  it("evaluates the selected compiler once for each new coherent source validation", async () => {
    await incremental(checkCommand);
    mocks.inspect.mockResolvedValue({ resolvedTree: "c".repeat(40), unresolvedConflicts: [] });
    await expect(incremental(schemaCommand)).resolves.toMatchObject({
      command: schemaCommand,
      nextCommand: checkCommand,
      status: "in_progress",
    });
    await incremental(checkCommand);
    expect(mocks.compile).toHaveBeenCalledTimes(2);
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(mocks.run).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: installCommand }),
    );
    expect(mocks.compile).toHaveBeenCalledTimes(2);
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
      if (!pending.original.includes(" app:test ")) {
        mocks.readText.mockResolvedValue(JSON.stringify({}));
      }
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

  it("returns the actual failed install cause and allows retrying that pending repair", async () => {
    mocks.check.mockResolvedValueOnce({
      exitCode: 1,
      stderr: "error: Cannot find package 'vitest' from '/workspace/candidate/tool.ts'",
      stdout: "",
    });
    await expect(incremental(checkCommand)).resolves.toMatchObject({
      nextCommand: installCommand,
      status: "in_progress",
      exitCode: 1,
    });
    let installFailed = false;
    mocks.run.mockImplementation((input: { command: string }) => {
      if (input.command === installCommand && !installFailed) {
        installFailed = true;
        return Promise.resolve({ exitCode: 1, stderr: "lockfile mismatch", stdout: "" });
      }
      return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
    });
    await expect(incremental(installCommand)).resolves.toMatchObject({
      command: installCommand,
      exitCode: 1,
      output: { stderr: "lockfile mismatch" },
      status: "needs_repair",
    });
    expect(mocks.candidate?.validationRun).toMatchObject({
      commands: [{ command: schemaCommand, exitCode: 0 }],
      nextIndex: 0,
    });
    await expect(incremental(installCommand)).resolves.toMatchObject({
      nextCommand: checkCommand,
      status: "in_progress",
    });
  });

  it("retains one historical attempt for a real failed supported command", async () => {
    const manifests = new Map<string, ValidationLogReference>();
    const chunks = new Map<string, { content: string; digest: string }>();
    const keyFor = (key: ValidationLogKey) =>
      JSON.stringify([key.sessionId, key.attemptDigest, key.command, key.channel, key.logId]);
    const store: ValidationLogStore = {
      async getChunk(key, index) {
        return await Promise.resolve(chunks.get(`${keyFor(key)}:${index}`));
      },
      async getReference(key) {
        return await Promise.resolve(manifests.get(keyFor(key)));
      },
      async publish(key, reference) {
        await Promise.resolve(manifests.set(keyFor(key), reference));
      },
      async putChunk(key, index, content, chunkDigest) {
        await Promise.resolve(
          chunks.set(`${keyFor(key)}:${index}`, { content, digest: chunkDigest }),
        );
      },
      async removeStaged(key) {
        await Promise.resolve(manifests.delete(keyFor(key)));
      },
    };
    mocks.logStore.mockResolvedValue(store);
    const check = checkCommand;
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
    expect(mocks.check).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "spend-review",
        command: check,
        validationRoot: "/workspace/candidate",
      }),
    );
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
    const attempt = mocks.attempts[0] as {
      attemptDigest: string;
      logs: { stderr: ValidationLogReference };
    };
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
  it.each([
    {
      diagnostic: "spend-review must have exactly one checked release matching its CUE source",
      repair: schemaCommand,
    },
    {
      diagnostic:
        "apps/spend-review/schema/index.ts is stale for its checked release; run mise run app:compile spend-review",
      repair: schemaCommand,
    },
    {
      diagnostic: "error: Cannot find package 'vitest' from '/workspace/candidate/task.ts'",
      repair: installCommand,
    },
  ])(
    "recovers the concrete task diagnostic $diagnostic then reruns checks before capture",
    async ({ diagnostic, repair }) => {
      mocks.check.mockResolvedValueOnce({ exitCode: 1, stderr: diagnostic, stdout: "" });
      await expect(incremental(checkCommand)).resolves.toMatchObject({
        exitCode: 1,
        status: "in_progress",
        nextCommand: repair,
      });
      expect(mocks.publish).not.toHaveBeenCalled();
      await expect(incremental(repair)).resolves.toMatchObject({
        nextCommand: checkCommand,
        status: "in_progress",
      });
      await incremental(checkCommand);
      await incremental(testCommand);
      await expect(incremental(captureCommand)).resolves.toMatchObject({ status: "validated" });
      expect(mocks.check).toHaveBeenCalledTimes(3);
      expect(mocks.candidate?.validation).toMatchObject({
        compilation: { release: { selection: { releaseId: "captured-release" } } },
      });
    },
  );

  it.each([
    "error TS2307: Cannot find module './missing-app-file'",
    "unbound-method lint failure",
    "test assertion failed",
    "other-app must have exactly one checked release matching its CUE source",
  ])("does not install or compile for %s", async (diagnostic) => {
    mocks.check.mockResolvedValueOnce({ exitCode: 2, stderr: diagnostic, stdout: "" });
    await expect(incremental(checkCommand)).resolves.toMatchObject({
      status: "needs_repair",
      exitCode: 2,
    });
    expect(mocks.run).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: installCommand }),
    );
    expect(mocks.compile).toHaveBeenCalledOnce();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("returns an unchanged failure after the named repair succeeded rather than recursively setting up", async () => {
    mocks.check.mockResolvedValue({
      exitCode: 1,
      stderr: "spend-review must have exactly one checked release matching its CUE source",
      stdout: "",
    });
    await incremental(checkCommand);
    await incremental(schemaCommand);
    await expect(incremental(checkCommand)).resolves.toMatchObject({
      status: "needs_repair",
      exitCode: 1,
    });
    expect(mocks.compile).toHaveBeenCalledTimes(2);
    await expect(incremental(checkCommand)).resolves.toMatchObject({ status: "needs_repair" });
    expect(mocks.compile).toHaveBeenCalledTimes(2);
  });

  it("retries capture without rerunning checks or the compiler", async () => {
    await incremental(checkCommand);
    await incremental(testCommand);
    mocks.publish.mockRejectedValueOnce(new Error("artifact storage unavailable"));
    await expect(incremental(captureCommand)).resolves.toMatchObject({
      status: "needs_repair",
      command: captureCommand,
      exitCode: null,
    });
    expect(mocks.candidate?.validation).toBeUndefined();
    await expect(
      validateReconciliation.execute(
        { additionalCheckTasks: [], incremental: false, runBrowserTests: false },
        context,
      ),
    ).resolves.toMatchObject({ status: "validated" });
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(mocks.compile).toHaveBeenCalledOnce();
    expect(mocks.run).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: installCommand }),
    );
  });

  it("captures static app completion as not-required after its selected compile task", async () => {
    mocks.publish.mockResolvedValueOnce({
      status: "not-required",
      compilation: { context: {}, release: { status: "not-required" } },
    });
    await expect(
      validateReconciliation.execute(
        { additionalCheckTasks: [], incremental: false, runBrowserTests: false },
        context,
      ),
    ).resolves.toMatchObject({ status: "validated" });
    expect(mocks.candidate?.validation).toMatchObject({
      compilation: { release: { status: "not-required" } },
    });
    expect(mocks.compile).toHaveBeenCalledOnce();
  });

  it("retains local, browser and additional repository task behavior", async () => {
    mocks.declaresLocal = true;
    await expect(
      validateReconciliation.execute(
        {
          additionalCheckTasks: ["check:vercel-services"],
          incremental: false,
          runBrowserTests: true,
        },
        context,
      ),
    ).resolves.toMatchObject({ status: "validated" });
    expect(mocks.local).toHaveBeenCalledOnce();
    expect(mocks.local).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "spend-review",
        root: "/workspace/candidate",
        signal: abortSignal,
      }),
    );
    expect(mocks.local.mock.calls[0]?.[0]).not.toHaveProperty("execution");
    expect(mocks.browser).toHaveBeenCalledOnce();
    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({ command: "mise run --no-deps --skip-tools check:vercel-services" }),
    );
    expect(mocks.candidate?.validation).toMatchObject({
      commands: [
        { command: schemaCommand, exitCode: 0 },
        { command: checkCommand, exitCode: 0 },
        { command: "mise run app:local -- spend-review setup", exitCode: 0 },
        { command: testCommand, exitCode: 0 },
        { command: "mise run --no-deps app:runtime run spend-review test-e2e", exitCode: 0 },
        { command: "mise run --no-deps --skip-tools check:vercel-services", exitCode: 0 },
      ],
    });
  });
  it.each([false, true])(
    "supplies fresh owner-bound browser context for candidate validation, incremental=%s",
    async (isIncremental) => {
      const changedRoot = "/workspace/reconciled-candidate";
      if (mocks.candidate === null) {
        throw new Error("Candidate fixture unavailable");
      }
      mocks.candidate.root = changedRoot;
      const initialWorkflow = mocks.workflow;
      mocks.check.mockImplementation(() => {
        mocks.workflow = { ...mocks.workflow, bindingGeneration: "fresh-at-browser-step" };
        return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
      });
      if (isIncremental) {
        for (const expectedCommand of [
          schemaCommand,
          checkCommand,
          testCommand,
          "mise run --no-deps app:runtime run spend-review test-e2e",
        ]) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- Advance the actual durable candidate sequence to its browser step.
          await validateReconciliation.execute(
            { additionalCheckTasks: [], expectedCommand, incremental: true, runBrowserTests: true },
            context,
          );
        }
      } else {
        await validateReconciliation.execute(
          { additionalCheckTasks: [], incremental: false, runBrowserTests: true },
          context,
        );
      }
      expect(mocks.workflow).not.toBe(initialWorkflow);
      expect(mocks.browser).toHaveBeenCalledOnce();
      expect(mocks.browser).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: "spend-review",
          root: changedRoot,
          signal: abortSignal,
          execution: {
            appId: "spend-review",
            root: changedRoot,
            sandboxId: "owned-provider-sandbox",
            sessionAuth: { owned: "auth" },
            sessionId: "adapter",
            signal: abortSignal,
            state: mocks.workflow,
          },
        }),
      );
      expect(mocks.local).not.toHaveBeenCalled();
    },
  );

  it.each([
    { isIncremental: false, cancelled: false },
    { isIncremental: true, cancelled: false },
    { isIncremental: false, cancelled: true },
    { isIncremental: true, cancelled: true },
  ])(
    "stops refused/cancelled binding before browser dispatch, incremental=$isIncremental cancelled=$cancelled",
    async ({ isIncremental, cancelled }) => {
      const actual = await vi.importActual<{ runAppBrowserTests: typeof runAppBrowserTestsPort }>(
        "../../agent/tools/run-app-browser-tests",
      );
      mocks.browser.mockImplementationOnce(actual.runAppBrowserTests);
      const requestAbort = new AbortController();
      if (cancelled) {
        requestAbort.abort();
      }
      const requestedSignal = cancelled ? requestAbort.signal : abortSignal;
      mocks.resolveRuntime.mockImplementationOnce((execution) => {
        execution.signal?.throwIfAborted();
        return Promise.reject(new Error("Approved HTTPS binding unavailable"));
      });
      // Synthetic Eve context supplies only the same consumed request/session fields as the shared fixture.
      const callContext = {
        abortSignal: requestedSignal,
        callId: "validation_1",
        session: { auth: { owned: "auth" }, id: "adapter" },
      } as never;
      if (mocks.candidate === null) {
        throw new Error("Candidate fixture unavailable");
      }
      mocks.readText.mockResolvedValue(JSON.stringify({}));
      mocks.candidate.validationRun = {
        commands: [],
        compilation: undefined,
        nextIndex: 0,
        resolvedTree: tree,
        schemaTaskCompleted: true,
        steps: [
          { kind: "browser", command: "mise run --no-deps app:runtime run spend-review test-e2e" },
        ],
      };
      const result = await validateReconciliation.execute(
        { additionalCheckTasks: [], incremental: isIncremental, runBrowserTests: true },
        callContext,
      );
      expect(result).toMatchObject({ status: "needs_repair" });
      expect(mocks.resolveRuntime).toHaveBeenCalledWith({
        appId: "spend-review",
        root: "/workspace/candidate",
        sandboxId: "owned-provider-sandbox",
        sessionAuth: { owned: "auth" },
        sessionId: "adapter",
        signal: requestedSignal,
        state: mocks.workflow,
      });
      expect(mocks.run).not.toHaveBeenCalledWith(
        expect.objectContaining({
          command: "mise run --no-deps app:runtime run spend-review test-e2e",
        }),
      );
      expect(mocks.publish).not.toHaveBeenCalled();
      expect(mocks.local).not.toHaveBeenCalled();
    },
  );

  it("revalidates after the real candidate edit clears progress without reinstalling or recompiling", async () => {
    await validateReconciliation.execute(
      { additionalCheckTasks: [], incremental: false, runBrowserTests: false },
      context,
    );
    mocks.candidate = {
      ...mocks.candidate,
      proposal: { digest: "old-proposal" },
      review: { digest: "old-review" },
    };
    await editCandidate.execute(
      {
        kind: "replace",
        path: "apps/spend-review/example.test.ts",
        expectedDigest: digest,
        oldText: "old lint expression",
        newText: "corrected lint expression",
      },
      context,
    );
    expect(mocks.candidate).not.toHaveProperty("validation");
    expect(mocks.candidate).not.toHaveProperty("validationRun");
    expect(mocks.candidate).not.toHaveProperty("review");
    expect(mocks.candidate).not.toHaveProperty("proposal");
    mocks.publish.mockResolvedValueOnce({
      status: "published",
      compilation: {
        context: {
          authority: { ownerUserId: "owner" },
          target: { appId: "spend-review", sessionId: "canonical-session" },
        },
        release: {
          status: "published",
          selection: {
            appId: "spend-review",
            appSpecDigest: digest,
            artifactRef: "actual-repaired-artifact",
            releaseId: "actual-repaired-capture",
            manifestSha256: "e".repeat(64),
            schemaSha256: "f".repeat(64),
            version: 1,
          },
        },
      },
    });
    await expect(
      validateReconciliation.execute(
        { additionalCheckTasks: [], incremental: false, runBrowserTests: false },
        context,
      ),
    ).resolves.toMatchObject({ status: "validated" });
    expect(mocks.check).toHaveBeenCalledTimes(4);
    expect(mocks.run).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: installCommand }),
    );
    expect(mocks.publish).toHaveBeenCalledTimes(2);
    expect(mocks.compile).toHaveBeenCalledTimes(2);
    expect(mocks.candidate?.validation).toMatchObject({
      compilation: { release: { selection: { releaseId: "actual-repaired-capture" } } },
    });
  });
  it("retains the actual schema repair failure and permits retry after fixing its cause", async () => {
    mocks.check.mockResolvedValueOnce({
      exitCode: 1,
      stderr: "spend-review must have exactly one checked release matching its CUE source",
      stdout: "",
    });
    await incremental(checkCommand);
    mocks.compile.mockResolvedValueOnce({
      command: schemaCommand,
      exitCode: 2,
      status: "failed",
      problem: "CUE source diagnostic",
      stderr: "source.cue:42: invalid type",
      stdout: "",
    });
    await expect(incremental(schemaCommand)).resolves.toMatchObject({
      status: "needs_repair",
      exitCode: 2,
      problem: "CUE source diagnostic",
      output: { stderr: "source.cue:42: invalid type" },
    });
    expect(mocks.candidate?.validation).toBeUndefined();
    await expect(incremental(schemaCommand)).resolves.toMatchObject({
      status: "in_progress",
      nextCommand: checkCommand,
    });
    expect(mocks.compile).toHaveBeenCalledTimes(3);
  });

  it("preserves a scheduled setup repair when the failed command generated ordinary checkout changes", async () => {
    mocks.check.mockResolvedValueOnce({
      exitCode: 1,
      stderr: "spend-review must have exactly one checked release matching its CUE source",
      stdout: "",
    });
    mocks.inspect
      .mockResolvedValueOnce({ resolvedTree: tree, unresolvedConflicts: [] })
      .mockResolvedValue({ resolvedTree: "d".repeat(40), unresolvedConflicts: [] });
    await expect(incremental(checkCommand)).resolves.toMatchObject({
      nextCommand: schemaCommand,
      status: "in_progress",
    });
    await expect(incremental(schemaCommand)).resolves.toMatchObject({
      nextCommand: checkCommand,
      status: "in_progress",
    });
    expect(mocks.compile).toHaveBeenCalledTimes(2);
  });

  it("rechecks earlier repository checks after a later test needs dependencies", async () => {
    await incremental(checkCommand);
    mocks.check.mockResolvedValueOnce({
      exitCode: 1,
      stderr:
        "error: Cannot find package 'fixture-runner' from '/workspace/candidate/tests/task.ts'",
      stdout: "",
    });
    await expect(incremental(testCommand)).resolves.toMatchObject({
      nextCommand: installCommand,
      status: "in_progress",
    });
    await expect(incremental(installCommand)).resolves.toMatchObject({
      nextCommand: checkCommand,
      status: "in_progress",
    });
    await incremental(checkCommand);
    await incremental(testCommand);
    await expect(incremental(captureCommand)).resolves.toMatchObject({ status: "validated" });
    expect(mocks.check).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ command: checkCommand }),
    );
    expect(mocks.check).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ command: testCommand }),
    );
    expect(mocks.check).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ command: checkCommand }),
    );
    expect(mocks.check).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ command: testCommand }),
    );
  });
  it("keeps prior check and review invalidation while recording new progress", async () => {
    mocks.candidate = {
      ...mocks.candidate,
      validation: { resolvedTree: "old-tree" },
      review: { digest: "old-review" },
      proposal: { digest: "old-proposal" },
      reviewReadProgress: { baseComplete: true },
    };
    await incremental(checkCommand);
    for (const field of ["validation", "review", "proposal", "reviewReadProgress"]) {
      expect(mocks.candidate).not.toHaveProperty(field);
    }
    await incremental(testCommand);
    await incremental(captureCommand);
    expect(mocks.candidate).not.toHaveProperty("review");
    expect(mocks.candidate).not.toHaveProperty("proposal");
  });
  it("leaves an undeclared application package import as an application repair", async () => {
    mocks.check.mockResolvedValueOnce({
      exitCode: 1,
      stderr:
        "Error: Cannot find package 'wrong-application-package' imported from '/workspace/candidate/apps/spend-review/server/data.ts'",
      stdout: "",
    });
    await expect(incremental(checkCommand)).resolves.toMatchObject({
      status: "needs_repair",
      exitCode: 1,
    });
    expect(mocks.run).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: installCommand }),
    );
    expect(mocks.compile).toHaveBeenCalledOnce();
    expect(mocks.candidate?.validationRun).toMatchObject({
      nextIndex: 1,
      commands: [{ command: schemaCommand, exitCode: 0 }],
    });
  });

  it("does not infer an installation repair from missing declaration evidence", async () => {
    mocks.readText.mockRejectedValue(new Error("dependency metadata unavailable"));
    mocks.check.mockResolvedValueOnce({
      exitCode: 1,
      stderr: "error: Cannot find package 'vitest' from '/workspace/candidate/task.ts'",
      stdout: "",
    });
    await expect(incremental(checkCommand)).resolves.toMatchObject({
      status: "needs_repair",
      exitCode: 1,
    });
    expect(mocks.run).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: installCommand }),
    );
  });
  it.each([
    "Error: Cannot find package 'vitest/wrong-internal-path' imported from '/workspace/candidate/apps/spend-review/test.ts'",
    "Error: Cannot find module '/workspace/candidate/node_modules/vitest/wrong-internal-path.js'\ncode: MODULE_NOT_FOUND",
  ])(
    "does not reinstall a declared package to repair an application subpath error: %s",
    async (diagnostic) => {
      mocks.check.mockResolvedValueOnce({ exitCode: 1, stderr: diagnostic, stdout: "" });
      await expect(incremental(checkCommand)).resolves.toMatchObject({
        status: "needs_repair",
        exitCode: 1,
      });
      expect(mocks.run).not.toHaveBeenCalledWith(
        expect.objectContaining({ command: installCommand }),
      );
      expect(mocks.compile).toHaveBeenCalledOnce();
    },
  );
  it("marks compilation only after an actual successful task before dependency skipping", async () => {
    await expect(incremental(schemaCommand)).resolves.toMatchObject({
      command: schemaCommand,
      nextCommand: checkCommand,
      status: "in_progress",
    });
    expect(mocks.candidate?.validationRun).toMatchObject({
      schemaTaskCompleted: true,
      nextIndex: 1,
    });
    expect(mocks.check).not.toHaveBeenCalled();
    await incremental(checkCommand);
    await incremental(testCommand);
    await incremental(captureCommand);
    expect(mocks.compile).toHaveBeenCalledOnce();
    expect(mocks.run).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: installCommand }),
    );
  });

  it("repairs a declared missing compiler dependency before acknowledging compilation", async () => {
    mocks.compile.mockResolvedValueOnce({
      command: schemaCommand,
      exitCode: 1,
      status: "failed",
      stderr: "error: Cannot find package 'vitest' from '/workspace/candidate/compiler-task.ts'",
      stdout: "",
    });
    await expect(incremental(schemaCommand)).resolves.toMatchObject({
      status: "in_progress",
      nextCommand: installCommand,
      exitCode: 1,
    });
    expect(mocks.candidate?.validationRun).not.toHaveProperty("schemaTaskCompleted", true);
    await expect(incremental(installCommand)).resolves.toMatchObject({
      nextCommand: schemaCommand,
      status: "in_progress",
    });
    await expect(incremental(schemaCommand)).resolves.toMatchObject({
      nextCommand: checkCommand,
      status: "in_progress",
    });
    expect(mocks.candidate?.validationRun).toMatchObject({ schemaTaskCompleted: true });
    expect(mocks.compile).toHaveBeenCalledTimes(2);
  });
  it("does not infer compilation from a retained command spelling or runtime existence", async () => {
    mocks.readText.mockResolvedValue(JSON.stringify({}));
    mocks.candidate = {
      ...mocks.candidate,
      validationRun: {
        commands: [],
        nextIndex: 0,
        resolvedTree: tree,
        steps: [{ kind: "check", command: checkCommand }],
      },
    };
    await expect(incremental(checkCommand)).resolves.toMatchObject({
      command: "mise run --no-deps --skip-tools app:check spend-review",
      nextCommand: captureCommand,
      status: "in_progress",
    });
    expect(mocks.check).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "mise run --no-deps --skip-tools app:check spend-review",
      }),
    );
    expect(mocks.compile).not.toHaveBeenCalled();
    expect(mocks.candidate?.validationRun).not.toHaveProperty("schemaTaskCompleted");
  });
});
