import { describe, expect, it, vi } from "vitest";

import type { SandboxSession } from "eve/sandbox";

import type { TargetApplyReceipt } from "./target-apply";
import {
  createTargetValidationAttempt,
  compilerDiagnostics,
  executeProposalBoundValidation,
  sandboxValidationCommandExecutor,
  validationOverlayRoot,
} from "./target-validation";

const digest = (value: string) => value.repeat(64).slice(0, 64);

const apply: TargetApplyReceipt = {
  version: 2,
  sourceSha: "1".repeat(40),
  sourceTree: "0".repeat(40),
  sourceReceiptDigest: digest("1"),
  eligibilityDigest: digest("2"),
  workspaceDigest: digest("3"),
  appSpecDigest: digest("4"),
  appSpecPath: "prototype/example/app-spec.md",
  artifactRevision: digest("5"),
  dependencyReceiptDigest: digest("6"),
  identityDigest: digest("7"),
  imageDigest: `fixture@sha256:${digest("8")}`,
  dependencyCacheDigest: `sha256:${digest("9")}`,
  dependencyCacheContentDigest: digest("a"),
  proposalDigest: digest("b"),
  applyRoot: "/workspace/repository",
  planningTreeDigest: digest("c"),
  preparedTreeDigest: digest("d"),
  preTree: [],
  postTree: [],
  preTreeDigest: digest("e"),
  postTreeDigest: digest("f"),
  changes: [],
  changedContentDigest: digest("0"),
  command: {
    name: "create-app",
    exitCode: 0,
    stdoutDigest: digest("1"),
    stderrDigest: digest("2"),
  },
  appliedByCallId: "apply-call",
  status: "applied",
  targetReceipt: {
    version: 1,
    appId: "example",
    contractPath: "apps/example/app.contract.json",
    workspacePath: "apps/example",
    topology: {
      path: "microfrontends.json",
      oldDigest: digest("3"),
      newDigest: digest("4"),
    },
    mutations: ["apps/example", "microfrontends.json"],
    recovered: false,
    omittedAuthorities: [
      "provider-provisioning",
      "deployment",
      "production-readiness",
    ],
  },
  digest: digest("5"),
};

function sandboxFixture() {
  const run = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  return {
    run,
    sandbox: {
      id: "sandbox",
      run,
      writeTextFile: vi.fn(async () => undefined),
    } as unknown as SandboxSession,
  };
}

describe("target validation", () => {
  it("reports a missing package script without echoing command output", async () => {
    const { sandbox } = sandboxFixture();
    const result = await executeProposalBoundValidation({
      sandbox,
      apply,
      appId: "example",
      attempt: createTargetValidationAttempt(apply, "missing-script"),
      executor: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: 'error: Script not found "check"\nsecret-test-value',
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a command failure");
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
      "validation-call",
    );
    const execute = vi.fn(async () => ({
      exitCode: 0,
      stdout: "passed",
      stderr: "",
    }));

    const result = await executeProposalBoundValidation({
      sandbox,
      executor: execute,
      apply: currentApply,
      attempt,
      appId: "example",
      dependencyLayout: {
        version: 1,
        kind: "fixture",
        roots: [],
        workspaceLinks: [],
      },
    });

    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("reports the actual repository command failure", async () => {
    const { sandbox } = sandboxFixture();
    const attempt = createTargetValidationAttempt(apply, "validation-call");

    const result = await executeProposalBoundValidation({
      sandbox,
      executor: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "repository command failed",
      }),
      apply,
      attempt,
      appId: "example",
      dependencyLayout: {
        version: 1,
        kind: "fixture",
        roots: [],
        workspaceLinks: [],
      },
    });

    expect(result).toMatchObject({
      ok: false,
      receipt: {
        reason: "command-failed",
        commandFailure: { name: "check-build", exitCode: 1 },
      },
    });
  });

  it("returns only safe structured TypeScript diagnostics from a failed command", () => {
    expect(
      compilerDiagnostics(
        "\u001B[31mx typescript(TS2593): Cannot find name 'describe'.\n   ,-[apps/stock-exceptions/app/page.test.tsx:1:1]\n   `----\n\napps/stock-exceptions/app/page.test.tsx(2,1): error TS2304: Cannot find name 'process.env.TOKEN=secret-value'.\n FAIL  apps/stock-exceptions/app/__tests__/page.test.tsx > renders the exception queue\n ❯ apps/stock-exceptions/app/__tests__/page.test.tsx:8:5",
      ),
    ).toEqual([
      {
        code: "TS2593",
        path: "apps/stock-exceptions/app/page.test.tsx",
        line: 1,
        column: 1,
        message:
          "A referenced name is missing; inspect its declaration or import.",
      },
      {
        code: "TS2304",
        path: "apps/stock-exceptions/app/page.test.tsx",
        line: 2,
        column: 1,
        message:
          "A referenced name is missing; inspect its declaration or import.",
      },
      {
        code: "VITEST",
        path: "apps/stock-exceptions/app/__tests__/page.test.tsx",
        line: 8,
        column: 5,
        message: "Test assertion failed at this location.",
      },
    ]);
  });

  it("repairs only the reported formatter failure before rerunning check and build", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "package.json Formatting issues found",
        stderr: "Formatting issues found",
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "fixed", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "checked", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "built", stderr: "" });
    const sandbox = { run } as unknown as SandboxSession;
    const executor = sandboxValidationCommandExecutor();

    const result = await executor({
      sandbox,
      appId: "example",
      command: "mise run app:check-build example",
      validationRoot: "/workspace/repository",
    });

    expect(result.exitCode).toBe(0);
    expect(run.mock.calls.map(([input]) => input.command)).toEqual([
      "bun run --cwd apps/example check",
      "bun run --cwd apps/example check -- --fix",
      "bun run --cwd apps/example check",
      "bun run --cwd apps/example build",
    ]);
  });

  it("uses a writable validation directory without binding it to an apply digest", () => {
    expect(validationOverlayRoot("any-current-value", "check-build")).toBe(
      "/workspace/.app-builder/validation/check-build/repository",
    );
  });
});
