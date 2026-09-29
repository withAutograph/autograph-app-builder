import { spawnSync } from "node:child_process";

// oxlint-disable typescript/promise-function-async -- In-memory store fakes return settled Promises.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { SandboxSession } from "eve/sandbox";

import type { TargetApplyReceipt } from "./target-apply";
import type { ValidationCommandExecutor } from "./target-validation";
import type { ValidationLogStore } from "./validation-log";
import type { PreparedRuntimeExecution } from "../agent/prepared-runtime-execution";
import { readValidationLogPage } from "./validation-log";
import {
  createTargetValidationAttempt,
  compilerDiagnostics,
  executeProposalBoundValidation,
  sandboxValidationCommandExecutor,
  validationOutputExcerpt,
  sanitizeValidationDiagnosticText,
} from "./target-validation";

const digest = (value: string) => value.repeat(64).slice(0, 64);

const apply: TargetApplyReceipt = {
  appSpecDigest: digest("4"),
  appSpecPath: "prototype/example/app-spec.md",
  appliedByCallId: "apply-call",
  applyRoot: "/workspace/repository",
  artifactRevision: digest("5"),
  changedContentDigest: digest("0"),
  changes: [],
  command: {
    exitCode: 0,
    name: "create-app",
    stderrDigest: digest("2"),
    stdoutDigest: digest("1"),
  },
  dependencyCacheContentDigest: digest("a"),
  dependencyCacheDigest: `sha256:${digest("9")}`,
  dependencyReceiptDigest: digest("6"),
  digest: digest("5"),
  eligibilityDigest: digest("2"),
  identityDigest: digest("7"),
  imageDigest: `fixture@sha256:${digest("8")}`,
  planningTreeDigest: digest("c"),
  postTree: [],
  postTreeDigest: digest("f"),
  preTree: [],
  preTreeDigest: digest("e"),
  preparedTreeDigest: digest("d"),
  proposalDigest: digest("b"),
  sourceReceiptDigest: digest("1"),
  sourceSha: "1".repeat(40),
  sourceTree: "0".repeat(40),
  status: "applied",
  targetReceipt: {
    appId: "example",
    mutations: ["apps/example", "microfrontends.json"],
    omittedAuthorities: ["provider-provisioning", "deployment", "production-readiness"],
    recovered: false,
    topology: {
      newDigest: digest("4"),
      oldDigest: digest("3"),
      path: "microfrontends.json",
    },
    version: 1,
    workspacePath: "apps/example",
  },
  version: 2,
  workspaceDigest: digest("3"),
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function sandboxFixture() {
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  const run = vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: "" }));
  return {
    run,
    sandbox: {
      id: "sandbox",
      run,
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      writeTextFile: vi.fn(async () => {}),
    } as unknown as SandboxSession,
  };
}

describe("target validation", () => {
  it("uses the owned hosted execution for repository checks rather than probing a local environment", async () => {
    const { sandbox } = sandboxFixture();
    const runTask = vi
      .fn<PreparedRuntimeExecution["runTask"]>()
      .mockResolvedValue({ exitCode: 0, stderr: "", stdout: "checks passed" });
    const runtime: PreparedRuntimeExecution = {
      environmentPath: "/private-state/environment.json",
      installationProof: {
        actors: 8,
        appId: "example",
        artifactHash: "a".repeat(64),
        authenticatedBehavior: "unassessed",
        branch: "builder/example",
        environment: "preview",
        observation: "database-verification",
        observedAt: "2026-09-29T12:00:00Z",
        releaseId: "release_1",
        tenants: 2,
      },
      prepareAuthenticatedOrigin: vi.fn(),
      runTask,
      stateDirectory: "/private-state",
    };
    const executor = sandboxValidationCommandExecutor({ runtime });
    const onChunk = vi.fn();
    const result = await executor({
      appId: "example",
      command: "mise run --skip-tools app:check example",
      onChunk,
      sandbox,
      validationRoot: "/workspace/repository",
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "checks passed" });
    expect(runTask).toHaveBeenCalledWith(
      expect.objectContaining({ onChunk, task: "repository-check" }),
    );
  });
  it("links a filtered failure receipt to its complete sanitized durable log", async () => {
    const { sandbox } = sandboxFixture();
    const chunks = new Map<string, { content: string; digest: string }>();
    const manifests = new Map<
      string,
      {
        bytes: number;
        channel: "stdout" | "stderr";
        chunkCount: number;
        digest: string;
        logId: string;
      }
    >();
    const store: ValidationLogStore = {
      getChunk: (key, index) => Promise.resolve(chunks.get(`${key.logId}:${index}`)),
      getReference: (key) => Promise.resolve(manifests.get(key.logId)),
      publish: (key, reference) => {
        manifests.set(key.logId, reference);
        return Promise.resolve();
      },
      putChunk: (key, index, content, chunkDigest) => {
        chunks.set(`${key.logId}:${index}`, { content, digest: chunkDigest });
        return Promise.resolve();
      },
      removeStaged: (key) => {
        manifests.delete(key.logId);
        let index = 0;
        while (chunks.delete(`${key.logId}:${index}`)) {
          index += 1;
        }
        return Promise.resolve();
      },
    };
    const attempt = createTargetValidationAttempt(apply, "durable-failure");
    const result = await executeProposalBoundValidation({
      appId: "example",
      apply,
      attempt,
      executor: () =>
        Promise.resolve({
          exitCode: 1,
          stderr: "",
          stdout:
            "ordinary build progress\napps/example/app/page.tsx(1,1): error TS2304: token=private\n",
        }),
      logStore: store,
      sandbox,
      sessionId: "session-a",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected validation failure.");
    }
    const [command] = result.receipt.commands;
    if (command === undefined) {
      throw new Error("Expected a command receipt.");
    }
    expect(command.logs?.stdout.digest).toBe(command.stdoutDigest);
    expect(result.receipt.output?.truncated).toBe(true);
    const reference = command.logs?.stdout;
    if (reference === undefined) {
      throw new Error("Expected durable log reference.");
    }
    const page = await readValidationLogPage({
      digest: reference.digest,
      key: {
        attemptDigest: attempt.digest,
        channel: "stdout",
        command: command.name,
        logId: reference.logId,
        sessionId: "session-a",
      },
      store,
    });
    expect(page.content).toContain("ordinary build progress");
    expect(page.content).not.toContain("private");
    expect(page.content).toContain("token=[REDACTED]");
  });
  it("reports a missing repository task with bounded sanitized command output", async () => {
    const { sandbox } = sandboxFixture();
    const result = await executeProposalBoundValidation({
      appId: "example",
      apply,
      attempt: createTargetValidationAttempt(apply, "missing-script"),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      executor: async () => ({
        exitCode: 1,
        stderr: "error: task app:check not found\nsecret-test-value",
        stdout: "",
      }),
      sandbox,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected a command failure");
    }
    expect(result.receipt.commandFailure).toMatchObject({
      exitCode: 1,
      hint: "The repository app task is unavailable. Check the supported mise task and app package scripts before retrying.",
    });
    expect(JSON.stringify(result)).not.toContain("secret-test-value");
  });
  it("retains complete repair diagnostics while redacting common credentials", () => {
    const excerpt = validationOutputExcerpt(
      `apps/example/app/page.tsx(4,2): error TS2304: MissingThing ${"x".repeat(7000)}`,
      "Authorization: Bearer abc123\nAPI_KEY=super-secret\nCookie: session=private",
    );
    expect(excerpt.stdout).toContain("TS2304: MissingThing");
    expect(excerpt.stdout).toContain("x".repeat(7000));
    expect(excerpt.stderr).not.toContain("abc123");
    expect(excerpt.stderr).not.toContain("super-secret");
    expect(excerpt.stderr).not.toContain("session=private");
    expect(excerpt.truncated).toBe(true);
  });
  it("redacts complete diagnostic text, including lines omitted from the repair excerpt", () => {
    const raw =
      "starting build\nhttps://user:password@example.test/path\nBearer abc123\nAPI_KEY=super-secret\napps/example/app/page.tsx(4,2): error TS2304: MissingThing";
    const sanitized = sanitizeValidationDiagnosticText(raw);
    expect(sanitized).toContain("starting build");
    expect(sanitized).toContain("TS2304: MissingThing");
    expect(sanitized).not.toContain("password@example");
    expect(sanitized).not.toContain("abc123");
    expect(sanitized).not.toContain("super-secret");
    expect(validationOutputExcerpt(raw, "").truncated).toBe(true);
  });

  it("retains schema compiler failures and their repair guidance", () => {
    const excerpt = validationOutputExcerpt(
      "",
      "Schema compilation failed for spend-review (exit 1).\nschema-compiler: apps/spend-review/schema/spend-review.cue:12:4: conflicting values\nRead the compiler error and its CUE file location above, correct the app-owned schema or its inputs, then rerun the app's schema check.",
    );
    expect(excerpt.stderr).toContain("schema-compiler:");
    expect(excerpt.stderr).toContain("conflicting values");
    expect(excerpt.stderr).toContain("rerun the app's schema check");
  });

  it("keeps multiline CUE context and the final cause of long compiler output", () => {
    const excerpt = validationOutputExcerpt(
      "",
      `schema-compiler: apps/example/schema/example.cue:12:4: conflicting values\n` +
        `    amount: string\n` +
        `            ^\n` +
        `caused by: amount must be numeric\n` +
        `cargo: ${"x".repeat(7000)}\n` +
        `apps/example/schema/example.cue:22:1: final constraint failure`,
    );
    expect(excerpt.stderr).toContain("amount must be numeric");
    expect(excerpt.stderr).toContain("final constraint failure");
    expect(excerpt.truncated).toBe(false);
  });

  it("retains native toolchain repair steps when the failure has no CUE location", () => {
    const excerpt = validationOutputExcerpt(
      "",
      'Schema compilation failed for example during --app-artifact (exit 1).\nToolNotFound: failed to find tool "cc"\nInstall a native C compiler in the build environment and verify `cc --version` succeeds before rerunning the schema check.\nRetry: mise run schema:release -- check --app example',
    );
    expect(excerpt.stderr).toContain('ToolNotFound: failed to find tool "cc"');
    expect(excerpt.stderr).toContain("Install a native C compiler");
    expect(excerpt.stderr).toContain("Retry: mise run schema:release");
  });

  it("preserves Unicode CUE names and malformed-JSON output without control characters", () => {
    const excerpt = validationOutputExcerpt(
      "",
      "Schema release generation failed for example.\nThe schema compiler produced invalid JSON for example during SQL manifest.\nCompiler output excerpt:\napps/example/schema/example.cue:8:2: conflicting value for coût\u0000",
    );
    expect(excerpt.stderr).toContain("coût");
    expect(excerpt.stderr).toContain("Compiler output excerpt:");
    expect(excerpt.stderr).not.toContain("\u0000");
  });

  it("runs repository commands without receipt or source preflight", async () => {
    const { sandbox } = sandboxFixture();
    const currentApply = { ...apply, digest: "current-worktree" };
    const attempt = createTargetValidationAttempt(currentApply, "validation-call");
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const execute = vi.fn(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "passed",
    }));

    const result = await executeProposalBoundValidation({
      appId: "example",
      apply: currentApply,
      attempt,
      dependencyLayout: {
        kind: "fixture",
        roots: [],
        version: 1,
        workspaceLinks: [],
      },
      executor: execute,
      sandbox,
    });

    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("reports the actual repository command failure", async () => {
    const { sandbox } = sandboxFixture();
    const attempt = createTargetValidationAttempt(apply, "validation-call");

    const result = await executeProposalBoundValidation({
      appId: "example",
      apply,
      attempt,
      dependencyLayout: {
        kind: "fixture",
        roots: [],
        version: 1,
        workspaceLinks: [],
      },
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      executor: async () => ({
        exitCode: 1,
        stderr: "repository command failed",
        stdout: "",
      }),
      sandbox,
    });

    expect(result).toMatchObject({
      ok: false,
      receipt: {
        commandFailure: { exitCode: 1, name: "check-build" },
        reason: "command-failed",
      },
    });
  });

  it("identifies a provider failure before the first validation command returns", async () => {
    const { sandbox } = sandboxFixture();
    const failure = new Error("Sandbox command launch failed", {
      cause: new Error("workspace unavailable for apps/example; token=private-value"),
    });
    const result = await executeProposalBoundValidation({
      appId: "example",
      apply,
      attempt: createTargetValidationAttempt(apply, "provider-error"),
      // oxlint-disable-next-line eslint/require-await -- model the provider's rejected promise
      executor: async () => {
        throw failure;
      },
      sandbox,
    });

    expect(result).toMatchObject({
      ok: false,
      receipt: {
        commandFailure: {
          exitCode: -1,
          name: "check-build",
          operation: "run-validation-command",
        },
        commands: [],
        reason: "execution-error",
      },
    });
    if (result.ok) {
      throw new Error("Expected a provider failure");
    }
    expect(result.receipt.commandFailure?.hint).toContain("Sandbox command launch failed");
    expect(result.receipt.commandFailure?.hint).toContain("workspace unavailable for apps/example");
    expect(result.receipt.commandFailure?.hint).toContain(
      "mise run --skip-tools app:check example",
    );
    expect(JSON.stringify(result)).not.toContain("private-value");
  });

  it("keeps timeout stage and full redacted provider error details", async () => {
    const { sandbox } = sandboxFixture();
    const timeout = new Error(
      `Authorization: Bearer private-bearer https://user:password@example.test/path ghp_privatekey ${"x".repeat(3000)}`,
    );
    timeout.name = "TimeoutError";
    const result = await executeProposalBoundValidation({
      appId: "example",
      apply,
      attempt: createTargetValidationAttempt(apply, "provider-timeout"),
      // oxlint-disable-next-line eslint/require-await -- model the provider's rejected promise
      executor: async () => {
        throw timeout;
      },
      sandbox,
    });

    expect(result).toMatchObject({
      ok: false,
      receipt: {
        commandFailure: {
          exitCode: -1,
          name: "check-build",
          operation: "run-validation-command",
        },
        reason: "command-timeout",
      },
    });
    if (result.ok) {
      throw new Error("Expected a provider timeout");
    }
    const hint = result.receipt.commandFailure?.hint ?? "";
    expect(hint).toContain("timed out while running");
    expect(hint).toContain("x".repeat(3000));
    expect(hint).not.toContain("private-bearer");
    expect(hint).not.toContain("password");
    expect(hint).not.toContain("ghp_privatekey");
    expect(hint.length).toBeGreaterThan(3000);
  });

  it("identifies the failing validation command after an earlier command passed", async () => {
    const { sandbox } = sandboxFixture();
    const executor = vi
      .fn<ValidationCommandExecutor>()
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "passed" })
      .mockRejectedValueOnce("provider unavailable");
    const result = await executeProposalBoundValidation({
      appId: "example",
      apply,
      attempt: createTargetValidationAttempt(apply, "second-command-error"),
      executor,
      sandbox,
    });

    expect(result).toMatchObject({
      ok: false,
      receipt: {
        commandFailure: {
          exitCode: -1,
          name: "test",
          operation: "run-validation-command",
        },
        commands: [{ exitCode: 0, name: "check-build" }],
        reason: "execution-error",
      },
    });
    if (result.ok) {
      throw new Error("Expected a provider failure");
    }
    expect(result.receipt.commandFailure?.hint).toContain("provider unavailable");
  });

  it("returns only safe structured TypeScript diagnostics from a failed command", () => {
    expect(
      compilerDiagnostics(
        "\u001B[31mx typescript(TS2593): Cannot find name 'describe'.\n   ,-[apps/stock-exceptions/app/page.test.tsx:1:1]\n   `----\n\napps/stock-exceptions/app/page.test.tsx(2,1): error TS2304: Cannot find name 'process.env.TOKEN=secret-value'.\n FAIL  apps/stock-exceptions/app/__tests__/page.test.tsx > renders the exception queue\n ❯ apps/stock-exceptions/app/__tests__/page.test.tsx:8:5",
      ),
    ).toEqual([
      {
        code: "TS2593",
        column: 1,
        line: 1,
        message: "A referenced name is missing; inspect its declaration or import.",
        path: "apps/stock-exceptions/app/page.test.tsx",
      },
      {
        code: "TS2304",
        column: 1,
        line: 2,
        message: "A referenced name is missing; inspect its declaration or import.",
        path: "apps/stock-exceptions/app/page.test.tsx",
      },
      {
        code: "VITEST",
        column: 5,
        line: 8,
        message: "Test assertion failed at this location.",
        path: "apps/stock-exceptions/app/__tests__/page.test.tsx",
      },
    ]);
  });

  it.each([
    "mise run --skip-tools app:check example",
    "mise run --skip-tools app:test example 1/1",
  ] as const)("runs the repository-owned validation task once: %s", async (command) => {
    // oxlint-disable-next-line eslint/require-await -- model the sandbox's async command API
    const run = vi.fn(async () => ({ exitCode: 1, stderr: "Formatting issues found", stdout: "" }));
    const sandbox = { run } as unknown as SandboxSession;

    const result = await sandboxValidationCommandExecutor()({
      appId: "example",
      command,
      sandbox,
      validationRoot: "/workspace/repository",
    });

    expect(result.exitCode).toBe(1);
    expect(run).toHaveBeenCalledExactlyOnceWith({
      command: `set +e
log=$(mktemp /tmp/app-builder-validation.XXXXXX) || exit $?
if [ -f '/tmp/autograph-app-runtime/b7a886d0cdd17479/example/environment.json' ]; then mise run app:runtime run example ${command.includes(" app:check ") ? "repository-check" : "repository-test 1/1"}; else ${command}; fi > "$log" 2>&1
status=$?
cat "$log"
rm -f "$log"
exit "$status"`,
      workingDirectory: "/workspace/repository",
    });
  });

  it("returns a validation failure even when a local service keeps writing after the task exits", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "builder-validation-"));
    const mise = path.join(directory, "mise");
    writeFileSync(
      mise,
      "#!/bin/sh\n(sleep 3; printf 'service log\\n') &\nprintf 'test failure\\n'\nexit 17\n",
    );
    chmodSync(mise, 0o755);
    try {
      // oxlint-disable-next-line eslint/require-await -- model the sandbox's async command API
      const run = vi.fn(async ({ command }: { command: string }) => {
        const result = spawnSync("/bin/sh", ["-c", command], {
          cwd: directory,
          encoding: "utf-8",
          env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` },
          timeout: 1000,
        });
        if (result.error !== undefined) {
          throw result.error;
        }
        return {
          exitCode: result.status ?? -1,
          stderr: result.stderr,
          stdout: result.stdout,
        };
      });
      const result = await sandboxValidationCommandExecutor()({
        appId: "example",
        command: "mise run --skip-tools app:test example 1/1",
        sandbox: { run } as unknown as SandboxSession,
        validationRoot: directory,
      });
      expect(result.exitCode).toBe(17);
      expect(result.stdout).toContain("test failure");
      expect(run).toHaveBeenCalledOnce();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
