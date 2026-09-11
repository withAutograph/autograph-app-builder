import type { SandboxSession } from "eve/sandbox";
import { describe, expect, it, vi } from "vitest";

import type { TargetApplyReceipt } from "./target-apply";
import {
  createTargetValidationAttempt,
  compilerDiagnostics,
  executeProposalBoundValidation,
  sandboxValidationCommandExecutor,
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
    contractPath: "apps/example/app.contract.json",
    mutations: ["apps/example", "microfrontends.json"],
    omittedAuthorities: [
      "provider-provisioning",
      "deployment",
      "production-readiness",
    ],
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

function sandboxFixture() {
  const run = vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: "" }));
  return {
    run,
    sandbox: {
      id: "sandbox",
      run,
      writeTextFile: vi.fn(async () => {}),
    } as unknown as SandboxSession,
  };
}

describe("target validation", () => {
  it("reports a missing package script without echoing command output", async () => {
    const { sandbox } = sandboxFixture();
    const result = await executeProposalBoundValidation({
      appId: "example",
      apply,
      attempt: createTargetValidationAttempt(apply, "missing-script"),
      executor: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: 'error: Script not found "check"\nsecret-test-value',
      }),
      sandbox,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected a command failure");
    }
    expect(result.receipt.commandFailure).toMatchObject({
      exitCode: 1,
      hint: "The requested package script is missing. Inspect the app package and finish its runnable setup before retrying.",
    });
    expect(JSON.stringify(result)).not.toContain("secret-test-value");
  });
  it("runs repository commands without receipt or source preflight", async () => {
    const { sandbox } = sandboxFixture();
    const currentApply = { ...apply, digest: "current-worktree" };
    const attempt = createTargetValidationAttempt(
      currentApply,
      "validation-call"
    );
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
      executor: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "repository command failed",
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

  it("returns only safe structured TypeScript diagnostics from a failed command", () => {
    expect(
      compilerDiagnostics(
        "\u001B[31mx typescript(TS2593): Cannot find name 'describe'.\n   ,-[apps/stock-exceptions/app/page.test.tsx:1:1]\n   `----\n\napps/stock-exceptions/app/page.test.tsx(2,1): error TS2304: Cannot find name 'process.env.TOKEN=secret-value'.\n FAIL  apps/stock-exceptions/app/__tests__/page.test.tsx > renders the exception queue\n ❯ apps/stock-exceptions/app/__tests__/page.test.tsx:8:5"
      )
    ).toEqual([
      {
        code: "TS2593",
        column: 1,
        line: 1,
        message:
          "A referenced name is missing; inspect its declaration or import.",
        path: "apps/stock-exceptions/app/page.test.tsx",
      },
      {
        code: "TS2304",
        column: 1,
        line: 2,
        message:
          "A referenced name is missing; inspect its declaration or import.",
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

  it("repairs only the reported formatter failure before rerunning check and build", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 1,
        stderr: "Formatting issues found",
        stdout: "package.json Formatting issues found",
      })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "fixed" })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "checked" })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "built" });
    const sandbox = { run } as unknown as SandboxSession;
    const executor = sandboxValidationCommandExecutor();

    const result = await executor({
      appId: "example",
      command: "mise run app:check-build example",
      sandbox,
      validationRoot: "/workspace/repository",
    });

    expect(result.exitCode).toBe(0);
    expect(
      run.mock.calls.every(([input]) => input.abortSignal === undefined)
    ).toBe(true);
    expect(run.mock.calls.map(([input]) => input.command)).toEqual([
      "bun run --cwd apps/example check",
      "bun run --cwd apps/example check -- --fix",
      "bun run --cwd apps/example check",
      "bun run --cwd apps/example build",
    ]);
  });
});
