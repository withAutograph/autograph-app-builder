import { decideApprovedBuildContinuation } from "../agent/approved-build-continuation";
import type { AppBuilderWorkflowState } from "../agent/workflow-state";
import { sourceDeclaredToolchainActivationCommand } from "./source-toolchain";
import { spawnSync } from "node:child_process";

// oxlint-disable typescript/promise-function-async -- In-memory store fakes return settled Promises.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { SandboxSession } from "eve/sandbox";

import type { TargetApplyReceipt } from "./target-apply";
import { localRuntimeEnvironmentPath } from "./runtime-environment";
import { repositoryDeliveryBuildCommand } from "./supported-template";
import type { ValidationCommandExecutor } from "./target-validation";
import type {
  ValidationLogKey,
  ValidationLogReference,
  ValidationLogStore,
} from "./validation-log";
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

const unexpectedSandboxOperation = () =>
  Promise.reject(new Error("Unexpected sandbox operation in validation fixture"));
const createSandbox = (overrides: Partial<SandboxSession>): SandboxSession => ({
  readBinaryFile: unexpectedSandboxOperation,
  readFile: unexpectedSandboxOperation,
  readTextFile: unexpectedSandboxOperation,
  removePath: unexpectedSandboxOperation,
  resolvePath: () => {
    throw new Error("Unexpected sandbox operation in validation fixture");
  },
  run: unexpectedSandboxOperation,
  spawn: unexpectedSandboxOperation,
  writeBinaryFile: unexpectedSandboxOperation,
  writeFile: unexpectedSandboxOperation,
  writeTextFile: unexpectedSandboxOperation,
  ...overrides,
});

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
      ...createSandbox({
        run,
        writeTextFile: vi.fn<() => Promise<void>>().mockResolvedValue(),
      }),
    },
  };
}

const outputStream = (content: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(content));
      controller.close();
    },
  });

const validationLogKey = (key: ValidationLogKey) =>
  JSON.stringify([key.sessionId, key.attemptDigest, key.command, key.channel, key.logId]);

const memoryValidationLogStore = (): ValidationLogStore => {
  const chunks = new Map<string, { content: string; digest: string }>();
  const references = new Map<string, ValidationLogReference>();
  return {
    getChunk: (key, index) => Promise.resolve(chunks.get(`${validationLogKey(key)}:${index}`)),
    getReference: (key) => Promise.resolve(references.get(validationLogKey(key))),
    publish: (key, reference) => {
      references.set(validationLogKey(key), reference);
      return Promise.resolve();
    },
    putChunk: (key, index, content, chunkDigest) => {
      chunks.set(`${validationLogKey(key)}:${index}`, { content, digest: chunkDigest });
      return Promise.resolve();
    },
    removeStaged: () => Promise.resolve(),
  };
};

const writePrivateNativeRunnerFixture = (root: string, hasEnvironmentHelper: boolean) => {
  const write = (relativePath: string, contents: string, mode = 0o644) => {
    const file = path.join(root, relativePath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents, { mode });
  };
  const environmentHelper = hasEnvironmentHelper
    ? `export const applicationTaskEnvironment = (root) => ({
  ...process.env,
  VC_MICROFRONTENDS_CONFIG: root + "/.scratch/microfrontends/microfrontends.json",
  APP_TASK_ENV_OWNER: "checkout",
  TURBO_TELEMETRY_DISABLED: "1",
});`
    : "";
  write(
    ".config/mise/scripts/repository/app-validation.ts",
    `const selectedApp = {
  id: "example",
  directory: "apps/example",
  framework: "next",
  package: "@fixture/selected",
};
export const discoverApplications = (root) => {
  if (root !== process.cwd()) process.exit(56);
  return [{ id: "other" }, selectedApp];
};
export const ${hasEnvironmentHelper ? "applicationTaskArguments" : "lifecycleTaskArguments"} = (root, app, task) => {
  if (root !== process.cwd() || app !== selectedApp || task !== "build") process.exit(134);
  return ["run", task, "--ui=stream", "--only", "--filter=" + app.package];
};
${environmentHelper}
`,
  );
  write(
    ".config/mise/scripts/repository/generate-microfrontends.ts",
    `import { mkdirSync, writeFileSync } from "node:fs";
if (process.env.FIXTURE_OUTCOME === "catalog failed") process.exit(45);
mkdirSync(".scratch/microfrontends", { recursive: true });
writeFileSync(".scratch/microfrontends/microfrontends.json", "selected catalog");
console.log("generated selected catalog");
`,
  );
  write(
    "node_modules/.bin/turbo",
    `#!/bin/sh
if [ "$*" != "run build --ui=stream --only --filter=@fixture/selected" ]; then exit 134; fi
if [ ! -s "$VC_MICROFRONTENDS_CONFIG" ] || [ "$TURBO_TELEMETRY_DISABLED" != 1 ]; then exit 57; fi
if [ "$APP_TASK_ENV_OWNER" != "${hasEnvironmentHelper ? "checkout" : ""}" ]; then exit 58; fi
if [ "$BETTER_AUTH_SECRET" != local-only-fixture ] || [ -n "$APP_RUNTIME_STATE_DIR" ]; then exit 59; fi
if [ -n "$UNRELATED_RUNTIME_VALUE" ]; then exit 60; fi
if [ "$FIXTURE_OUTCOME" = "build failed" ]; then exit 44; fi
mkdir -p apps/example/.next
printf 'fixture native output\n' > apps/example/.next/build-proof
printf 'ran selected native build\n'
`,
    0o755,
  );
  if (hasEnvironmentHelper) {
    write(
      "node_modules/@autograph/microfrontends/package.json",
      JSON.stringify({ name: "@autograph/microfrontends", exports: { "./config": "./config.js" } }),
    );
    write(
      "node_modules/@autograph/microfrontends/config.js",
      `import { readFileSync } from "node:fs";
export const readMicrofrontendsConfig = ({ cwd, environment }) => {
  if (cwd !== process.cwd() || environment.APP_TASK_ENV_OWNER !== "checkout") process.exit(61);
  return readFileSync(environment.VC_MICROFRONTENDS_CONFIG, "utf8");
};
`,
    );
    write(
      "packages/platform-microfrontends/src/policy/application-identity",
      `export const platformCatalogApplication = (config, appId) => {
  if (config !== "selected catalog" || appId !== "example") process.exit(62);
  return { assetPrefix: "selected-assets" };
};
`,
    );
  }
  write(
    "packages/platform-microfrontends/src/hosting/vercel/next-build-output",
    `export async function assertNativeNextBuild(appRoot, appId${hasEnvironmentHelper ? ", prefix" : ""}) {
  if (appRoot !== process.cwd() + "/apps/example" || appId !== "example") process.exit(63);
  ${hasEnvironmentHelper ? 'if (prefix !== "/selected-assets") process.exit(64);' : ""}
  if (process.env.FIXTURE_OUTCOME === "private verifier rejected") {
    throw new Error("native output verification rejected");
  }
  if (!(await Bun.file(appRoot + "/.next/build-proof").exists())) process.exit(65);
  console.log("verified selected native output");
}
`,
  );
};

describe("target validation", () => {
  it("preserves compiler operation inputs across the check and test commands", async () => {
    const { sandbox } = sandboxFixture();
    const environment = {
      APP_SCHEMA_TRANSITION_PREDECESSOR_FILES: '["/private-state/original-predecessor.json"]',
      OPTIONAL_INPUT: undefined,
    };
    const executor = vi
      .fn<ValidationCommandExecutor>()
      .mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });
    const attempt = createTargetValidationAttempt(apply, "compiler-environment");
    const result = await executeProposalBoundValidation({
      appId: "example",
      apply,
      attempt,
      environment,
      executor,
      sandbox,
    });
    expect(result.ok).toBe(true);
    expect(executor).toHaveBeenCalledTimes(attempt.commands.length);
    expect(attempt.commands.map(({ name }) => name)).toEqual(["check-build", "test"]);
    for (const [index, planned] of attempt.commands.entries()) {
      expect(executor.mock.calls[index]?.[0]).toMatchObject({ command: planned.command });
      expect(executor.mock.calls[index]?.[0].environment).toBe(environment);
    }
  });
  it("returns late kernel and assertion details from streamed durable logs and times each command", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    vi.setSystemTime(new Date("2026-10-09T12:00:00.000Z"));
    try {
      const { sandbox } = sandboxFixture();
      const store = memoryValidationLogStore();
      const attempt = createTargetValidationAttempt(apply, "late-command-failure");
      const result = await executeProposalBoundValidation({
        appId: "example",
        apply,
        attempt,
        executor: async ({ command, onChunk }) => {
          if (command === repositoryDeliveryBuildCommand("example")) {
            vi.advanceTimersByTime(125);
            return { exitCode: 0, stderr: "", stdout: "" };
          }
          await onChunk?.("stdout", "apps/example: checking existing files\n".repeat(1200));
          await onChunk?.(
            "stdout",
            [
              "kernel_prepare_schema_revision: unsupported_predecessor",
              "DETAIL: active base not exact compiler-owned transition predecessor",
              "CONTEXT: version 2026-10-08.authenticated-review-v2",
              "FAIL apps/example/test/review.test.ts > validates a transition",
              "Expected: canonical predecessor",
              "Received: unknown transition",
              "The active release cannot establish this transition.",
              "secret=private-value",
              " ❯ apps/example/test/review.test.ts:12:3",
              "",
            ].join("\n"),
          );
          vi.advanceTimersByTime(47);
          return { exitCode: 1, stderr: "", stdout: "" };
        },
        logStore: store,
        sandbox,
        sessionId: "session-a",
      });
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("Expected failed test validation.");
      }
      expect(result.receipt.commands).toHaveLength(2);
      expect(result.receipt.commandFailure).toMatchObject({ exitCode: 1, name: "test" });
      expect(result.receipt.output?.stdout).toContain("unsupported_predecessor");
      expect(result.receipt.output?.stdout).toContain(
        "DETAIL: active base not exact compiler-owned transition predecessor",
      );
      expect(result.receipt.output?.stdout).toContain("Expected: canonical predecessor");
      expect(result.receipt.output?.stdout).toContain("Received: unknown transition");
      expect(result.receipt.output?.stdout).toContain(
        "The active release cannot establish this transition.",
      );
      expect(result.receipt.output?.stdout).not.toContain("private-value");
      expect(result.receipt.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "VITEST",
          column: 3,
          line: 12,
          path: "apps/example/test/review.test.ts",
        }),
      );
      const events = info.mock.calls.map(([entry]): unknown => JSON.parse(z.string().parse(entry)));
      expect(events).toEqual([
        expect.objectContaining({
          command: "check-build",
          phase: "started",
          startedAt: "2026-10-09T12:00:00.000Z",
        }),
        expect.objectContaining({
          command: "check-build",
          elapsedMs: 125,
          finishedAt: "2026-10-09T12:00:00.125Z",
          phase: "finished",
        }),
        expect.objectContaining({
          command: "test",
          phase: "started",
          startedAt: "2026-10-09T12:00:00.125Z",
        }),
        expect.objectContaining({
          command: "test",
          elapsedMs: 47,
          exitCode: 1,
          finishedAt: "2026-10-09T12:00:00.172Z",
          phase: "finished",
        }),
      ]);
      const [, command] = result.receipt.commands;
      const reference = command?.logs?.stdout;
      if (command === undefined || reference === undefined) {
        throw new Error("Expected durable failed-command log.");
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
      expect(page.content).toContain("checking existing files");
      expect(page.nextCursor).toBeDefined();
      expect(result.receipt.output?.truncated).toBe(true);
    } finally {
      vi.useRealTimers();
      info.mockRestore();
    }
  });

  it("times a provider rejection without logging its private error message", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    vi.setSystemTime(new Date("2026-10-09T12:00:00.000Z"));
    try {
      const { sandbox } = sandboxFixture();
      const result = await executeProposalBoundValidation({
        appId: "example",
        apply,
        attempt: createTargetValidationAttempt(apply, "provider-rejection-timing"),
        executor: () => {
          vi.advanceTimersByTime(31);
          return Promise.reject(new Error("secret=private-value"));
        },
        sandbox,
      });
      expect(result.ok).toBe(false);
      expect(JSON.parse(z.string().parse(warn.mock.calls[0]?.[0]))).toMatchObject({
        elapsedMs: 31,
        finishedAt: "2026-10-09T12:00:00.031Z",
        phase: "provider_error",
        startedAt: "2026-10-09T12:00:00.000Z",
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("private-value");
    } finally {
      vi.useRealTimers();
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it.each([
    ["mise run --no-deps --skip-tools app:test example 1/1", "repository-test", "1/1", undefined],
    [
      "mise run --no-deps --skip-deps --skip-tools app:test example 1/1",
      "repository-test",
      "1/1",
      true,
    ],
  ] as const)(
    "forwards compiler inputs to owned hosted execution: %s",
    async (command, task, shard, alreadyCompiled) => {
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
      const executor = sandboxValidationCommandExecutor({ alreadyCompiled, runtime });
      const onChunk = vi.fn();
      const environment = { APP_SCHEMA_TRANSITION_PREDECESSOR_FILES: '["original.json"]' };
      const result = await executor({
        appId: "example",
        command,
        environment,
        onChunk,
        sandbox,
        validationRoot: "/workspace/repository",
      });
      expect(result).toMatchObject({ exitCode: 0, stdout: "checks passed" });
      const expected: Partial<Parameters<PreparedRuntimeExecution["runTask"]>[0]> = {
        environment,
        onChunk,
        task,
      };
      if (shard !== undefined) {
        expected.shard = shard;
      }
      if (alreadyCompiled) {
        expected.alreadyCompiled = true;
      }
      expect(runTask).toHaveBeenCalledWith(expect.objectContaining(expected));
    },
  );
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
  it("preserves recovery guidance for a retained native missing selected-app check task", async () => {
    const { sandbox } = sandboxFixture();
    const attempt = createTargetValidationAttempt(apply, "missing-native-app-task");
    const result = await executeProposalBoundValidation({
      appId: "example",
      apply,
      attempt: {
        ...attempt,
        commands: [
          {
            name: "check-build",
            command: "mise run --no-deps --skip-tools app:check example",
            validationRoot: apply.applyRoot,
          },
        ],
      },
      executor: async ({ onChunk }) => {
        await onChunk?.("stderr", "mise ERROR no task //apps/example:che");
        await onChunk?.("stderr", "ck found\n");
        return { exitCode: 1, stderr: "", stdout: "" };
      },
      sandbox,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected a missing task prerequisite");
    }
    expect(result.receipt).toMatchObject({
      commandFailure: { exitCode: 1, failureClass: "missing-app-task", name: "check-build" },
      reason: "tooling-prerequisite",
    });
    expect(result.receipt.commandFailure?.hint).toContain("executable mode");
    // SAFETY: Project the precise trusted workflow fields consumed by the classifier;
    // actual approval retention is exercised in approved-build-continuation.test.ts.
    const state = {
      phase: "validation_failed",
      appSpec: { appId: "example", digest: apply.appSpecDigest },
      proposal: { digest: apply.proposalDigest },
      workspace: { workspaceId: "owned-private-workspace" },
      validationFailure: result.receipt,
      applyReceipt: apply,
    } as AppBuilderWorkflowState;
    expect(
      decideApprovedBuildContinuation({
        adapterSessionId: "owned-session",
        approvalMatches: () => true,
        blocked: false,
        pendingInput: false,
        state,
        turnId: "actual-validation",
        turnSequence: 1,
      }),
    ).toMatchObject({
      decision: "blocked",
      validation: { failureClass: "missing-app-task", reason: "tooling-prerequisite" },
    });
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

  it.each(["Format issues found in 2 files", "Formatting issues found in 2 files"])(
    "retains generic formatter filenames and timings after %s",
    (summary) => {
      const excerpt = validationOutputExcerpt(
        "",
        [
          "ordinary build progress",
          summary,
          "  verbose build progress",
          "app/forms/task list.tsx (0ms)",
          "src/café view.ts (1ms)",
          "README.md (0ms)",
          "HK src/資料 page (2ms)",
          "apps/example/app/page.tsx (3ms)",
          "task-check: packages/shared/entry file (4ms)",
        ].join("\n"),
      );

      expect(excerpt.stderr).toContain(summary);
      expect(excerpt.stderr).toContain("app/forms/task list.tsx (0ms)");
      expect(excerpt.stderr).toContain("src/café view.ts (1ms)");
      expect(excerpt.stderr).toContain("README.md (0ms)");
      expect(excerpt.stderr).toContain("HK src/資料 page (2ms)");
      expect(excerpt.stderr).toContain("apps/example/app/page.tsx (3ms)");
      expect(excerpt.stderr).toContain("task-check: packages/shared/entry file (4ms)");
      expect(excerpt.stderr).not.toContain("ordinary build progress");
      expect(excerpt.stderr).not.toContain("verbose build progress");
      expect(excerpt.truncated).toBe(true);
    },
  );

  it("does not retain formatter timing lines without a failure summary", () => {
    const excerpt = validationOutputExcerpt("src/fast path.ts (1ms)\nordinary build progress", "");

    expect(excerpt.stdout).toBe("");
    expect(excerpt.truncated).toBe(true);
  });

  it.each(["stdout", "stderr"] as const)(
    "retains formatter filenames in %s when the other stream reports the failure",
    (stream) => {
      const filename = "src/fixture file.ts (1ms)";
      const summary = "Formatting issues found";
      const excerpt = validationOutputExcerpt(
        stream === "stdout" ? filename : summary,
        stream === "stderr" ? filename : summary,
      );

      expect(excerpt[stream]).toBe(filename);
      expect(excerpt.truncated).toBe(false);
    },
  );

  it("sanitizes formatter failure and adjacent timing lines before selecting them", () => {
    const excerpt = validationOutputExcerpt(
      "",
      "\u001B[31mFormatting issues found\u001B[0m\napps/example/API_KEY=private page.tsx (0ms)\u0000",
    );

    expect(excerpt.stderr).toContain("Formatting issues found");
    expect(excerpt.stderr).toContain("apps/example/API_KEY=[REDACTED] page.tsx (0ms)");
    expect(excerpt.stderr).not.toContain("private");
    expect(excerpt.stderr).not.toContain("\u0000");
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

  it.each(["streamed", "returned"])(
    "classifies a positively observed native checker panic from %s output as a prerequisite",
    async (delivery) => {
      const { sandbox } = sandboxFixture();
      const panic =
        "thread 'tokio-rt-worker' (14920) panicked at crates/oxc_allocator/src/pool/fixed_size.rs:112:67:\ncalled `Result::unwrap()` on an `Err` value: ()";
      const result = await executeProposalBoundValidation({
        appId: "example",
        apply,
        attempt: createTargetValidationAttempt(apply, "checker-panic"),
        dependencyLayout: { kind: "fixture", roots: [], version: 1, workspaceLinks: [] },
        executor: async ({ onChunk }) => {
          if (delivery === "streamed") {
            await onChunk?.("stderr", panic.slice(0, 65));
            await onChunk?.("stderr", panic.slice(65));
          }
          return { exitCode: 134, stderr: delivery === "returned" ? panic : "", stdout: "" };
        },
        sandbox,
      });
      expect(result).toMatchObject({
        ok: false,
        receipt: {
          commandFailure: {
            exitCode: 134,
            failureClass: "native-tool-panic",
            // oxlint-disable-next-line typescript/no-unsafe-assignment -- Vitest asymmetric matcher checks the safe prerequisite hint.
            hint: expect.stringContaining("repairOnly"),
            name: "check-build",
          },
          reason: "tooling-prerequisite",
        },
      });
    },
  );
  it("does not classify exit134 alone as a native tooling prerequisite", async () => {
    const { sandbox } = sandboxFixture();
    const result = await executeProposalBoundValidation({
      appId: "example",
      apply,
      attempt: createTargetValidationAttempt(apply, "unknown-134"),
      dependencyLayout: { kind: "fixture", roots: [], version: 1, workspaceLinks: [] },
      executor: () => Promise.resolve({ exitCode: 134, stderr: "no diagnostic", stdout: "" }),
      sandbox,
    });
    expect(result).toMatchObject({
      ok: false,
      receipt: { commandFailure: { exitCode: 134 }, reason: "command-failed" },
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
      repositoryDeliveryBuildCommand("example"),
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

  it.each(["[id]", "[...view]", "[[...slug]]", "(finance)", "@modal/(.)details"])(
    "retains bounded diagnostics inside the literal Next.js segment %s",
    (segment) => {
      const routePath = `apps/example/app/${segment}/page.tsx`;
      expect(compilerDiagnostics(`${routePath}(4,2): error TS2304: private source text`)).toEqual([
        {
          code: "TS2304",
          column: 2,
          line: 4,
          message: "A referenced name is missing; inspect its declaration or import.",
          path: routePath,
        },
      ]);
      expect(
        compilerDiagnostics(`apps/example/API_KEY=private.tsx(4,2): error TS2304: secret`),
      ).toEqual([]);
    },
  );
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
    ["mise run --no-deps --skip-tools app:test example 1/1", undefined],
    ["mise run --no-deps --skip-deps --skip-tools app:test example 1/1", true],
  ] as const)(
    "runs the repository-owned validation task once: %s",
    async (command, alreadyCompiled) => {
      // oxlint-disable-next-line eslint/require-await -- model the sandbox's async command API
      const run = vi.fn(async () => ({
        exitCode: 1,
        stderr: "Formatting issues found",
        stdout: "",
      }));
      const sandbox = createSandbox({ run });

      const result = await sandboxValidationCommandExecutor({ alreadyCompiled })({
        appId: "example",
        environment: { APP_RUNTIME_ALREADY_COMPILED: "untrusted" },
        command,
        sandbox,
        validationRoot: "/workspace/repository",
      });

      expect(result.exitCode).toBe(1);
      expect(run).toHaveBeenCalledExactlyOnceWith({
        command: `set +e
log=$(mktemp /tmp/app-builder-validation.XXXXXX) || exit $?
(
set -e
(
${sourceDeclaredToolchainActivationCommand()}
)
if [ -f '/tmp/autograph-app-runtime/b7a886d0cdd17479/example/environment.json' ]; then mise run --no-deps app:runtime run example repository-test 1/1; else ${command}; fi
) > "$log" 2>&1
status=$?
cat "$log"
rm -f "$log"
exit "$status"`,
        env: {
          ...(alreadyCompiled ? { APP_RUNTIME_ALREADY_COMPILED: "1" } : {}),
          APP_RUNTIME_STATE_DIR: path.posix.dirname(
            localRuntimeEnvironmentPath("/workspace/repository", "example"),
          ),
        },
        workingDirectory: "/workspace/repository",
      });
    },
  );

  it.each([
    [false, "mise run --no-deps --skip-tools app:test example 1/1", "repository-test 1/1"],
    [true, "mise run --no-deps --skip-tools app:test example 1/1", "repository-test 1/1"],
  ] as const)(
    "hands compiler inputs and the prepared state directory to mise with streaming=%s for %s",
    async (streaming, validationCommand, runtimeTask) => {
      const directory = mkdtempSync(path.join(tmpdir(), "builder-runtime-handoff-"));
      const environmentPath = localRuntimeEnvironmentPath(directory, "example");
      const stateDirectory = path.posix.dirname(environmentPath);
      mkdirSync(stateDirectory, { mode: 0o700, recursive: true });
      writeFileSync(environmentPath, "{}", { mode: 0o600 });
      mkdirSync(path.join(directory, ".config/mise"), { recursive: true });
      writeFileSync(path.join(directory, ".config/mise/config.toml"), "[tools]\n");
      writeFileSync(path.join(directory, "bun"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      writeFileSync(path.join(directory, "source-cue"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const mise = path.join(directory, "mise");
      writeFileSync(
        mise,
        `#!/bin/sh
case "$1" in
 trust) exit 0 ;;
 install) touch "$PWD/toolchain-ready"; exit 0 ;;
 which) printf '%s\\n' "$PWD/source-cue"; exit 0 ;;
esac
if [ ! -f "$PWD/toolchain-ready" ]; then exit 25; fi
if [ -n "$MISE_CONFIG_FILE" ]; then exit 26; fi
if [ "$*" != "run --no-deps app:runtime run example ${runtimeTask}" ]; then exit 21; fi
if [ "$APP_RUNTIME_STATE_DIR" != '${stateDirectory}' ]; then exit 22; fi
if [ ! -f "$APP_RUNTIME_STATE_DIR/environment.json" ]; then exit 23; fi
if [ "$APP_SCHEMA_TRANSITION_PREDECESSOR_FILES" != '["original.json"]' ]; then exit 24; fi
printf '%s\\n' "$APP_RUNTIME_STATE_DIR"
`,
        { mode: 0o755 },
      );
      const execute = ({ command, env }: Parameters<SandboxSession["run"]>[0]) => {
        const result = spawnSync("/bin/bash", ["-c", command], {
          cwd: directory,
          encoding: "utf-8",
          env: {
            ...process.env,
            APP_RUNTIME_STATE_DIR: "",
            ...env,
            PATH: `${directory}:${process.env.PATH ?? ""}`,
          },
          timeout: 1000,
        });
        if (result.error !== undefined) {
          throw result.error;
        }
        return { exitCode: result.status ?? -1, stderr: result.stderr, stdout: result.stdout };
      };
      expect(
        execute({ command: `mise run --no-deps app:runtime run example ${runtimeTask}` }).exitCode,
      ).toBe(25);
      const run = vi.fn((input: Parameters<SandboxSession["run"]>[0]) =>
        Promise.resolve(execute(input)),
      );
      const spawn = vi.fn((input: Parameters<SandboxSession["spawn"]>[0]) => {
        const result = execute(input);
        return Promise.resolve({
          kill: () => Promise.resolve(),
          stderr: outputStream(result.stderr),
          stdout: outputStream(result.stdout),
          wait: () => Promise.resolve({ exitCode: result.exitCode }),
        });
      });
      const chunks: string[] = [];
      try {
        const result = await sandboxValidationCommandExecutor()({
          appId: "example",
          command: validationCommand,
          environment: {
            APP_RUNTIME_STATE_DIR: "/untrusted-state-directory",
            APP_SCHEMA_TRANSITION_PREDECESSOR_FILES: '["original.json"]',
            OPTIONAL_INPUT: undefined,
          },
          onChunk: streaming
            ? (_channel, content) => {
                chunks.push(content);
                return Promise.resolve();
              }
            : undefined,
          sandbox: createSandbox({ run, spawn }),
          validationRoot: directory,
        });
        expect(result.exitCode).toBe(0);
        expect(streaming ? chunks.join("") : result.stdout).toContain(stateDirectory);
        expect(streaming ? spawn : run).toHaveBeenCalledOnce();
        expect((streaming ? spawn : run).mock.calls[0]?.[0].env).toEqual({
          APP_RUNTIME_STATE_DIR: stateDirectory,
          APP_SCHEMA_TRANSITION_PREDECESSOR_FILES: '["original.json"]',
        });
        expect(streaming ? run : spawn).not.toHaveBeenCalled();
      } finally {
        rmSync(stateDirectory, { force: true, recursive: true });
        rmSync(directory, { force: true, recursive: true });
      }
    },
  );

  it.each([
    { exitCode: 0, outcome: "build" },
    { alreadyCompiled: true as const, exitCode: 0, outcome: "already compiled" },
    { exitCode: 42, outcome: "native output rejected" },
    { exitCode: 43, outcome: "compile failed" },
    { exitCode: 0, outcome: "private runner with catalog helper", privateRunner: true },
    {
      exitCode: 0,
      legacyEnv: true,
      outcome: "oldest runner helper names",
      privateRunner: true,
    },
    { exitCode: 45, outcome: "catalog failed", privateRunner: true },
    { exitCode: 44, outcome: "build failed", privateRunner: true },
    { exitCode: 1, outcome: "private verifier rejected", privateRunner: true },
  ])("executes the selected checkout's build without lint: $outcome", async (scenario) => {
    const directory = mkdtempSync(path.join(tmpdir(), "builder-native-delivery-"));
    const environmentPath = localRuntimeEnvironmentPath(directory, "example");
    const stateDirectory = path.posix.dirname(environmentPath);
    try {
      mkdirSync(stateDirectory, { mode: 0o700, recursive: true });
      writeFileSync(
        environmentPath,
        JSON.stringify({
          BETTER_AUTH_SECRET: "local-only-fixture",
          UNRELATED_RUNTIME_VALUE: "must-not-enter-build",
        }),
        { mode: 0o600 },
      );
      mkdirSync(path.join(directory, ".config/mise/scripts/repository"), { recursive: true });
      writeFileSync(path.join(directory, ".config/mise/config.toml"), "[tools]\n");
      writeFileSync(path.join(directory, "source-cue"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      // Hosted repository CI provides Node. Use Bun when installed, otherwise
      // supply only the Bun.file operations needed by this executable fixture.
      writeFileSync(
        path.join(directory, "bun"),
        `#!/bin/sh
if PATH="$FIXTURE_SOURCE_PATH" command -v bun >/dev/null 2>&1; then
  PATH="$FIXTURE_SOURCE_PATH" exec bun "$@"
fi
preload="$PWD/fixture-bun-file.mjs"
if [ "$1" = -e ]; then
  shift
  exec "$FIXTURE_NODE" --conditions=source --import "$preload" --input-type=module -e "$@"
fi
exec "$FIXTURE_NODE" --conditions=source --import "$preload" "$@"
`,
        { mode: 0o755 },
      );
      writeFileSync(
        path.join(directory, "fixture-bun-file.mjs"),
        `import { access, readFile } from "node:fs/promises";
globalThis.Bun = {
  file: (path) => ({
    exists: () => access(path).then(() => true, () => false),
    json: async () => JSON.parse(await readFile(path, "utf8")),
  }),
};
`,
      );
      writeFileSync(
        path.join(directory, "mise"),
        `#!/bin/sh
case "$1" in
 trust|install) exit 0 ;;
 which) printf '%s\\n' "$PWD/source-cue"; exit 0 ;;
esac
if [ "$*" = "run --no-deps --skip-tools app:compile example" ]; then
  if [ -n "$BETTER_AUTH_SECRET" ]; then exit 51; fi
  if [ "$FIXTURE_OUTCOME" = "compile failed" ]; then exit 43; fi
  touch .compiled
  printf 'compiled selected schema\\n'
  exit 0
fi
if [ "$1" = exec ] && [ "$2" = --no-deps ] && [ "$3" = -- ]; then
  shift 3
  exec "$@"
fi
printf 'legacy app:check invoked\\n'
exit 134
`,
        { mode: 0o755 },
      );
      if (scenario.privateRunner === true) {
        writePrivateNativeRunnerFixture(directory, scenario.legacyEnv !== true);
      } else {
        writeFileSync(
          path.join(directory, ".config/mise/scripts/repository/app-validation.ts"),
          `export async function runApplicationTasks(root, appId, tasks) {
  if (root !== process.cwd() || appId !== "example" || tasks.join() !== "build") process.exit(134);
  if (process.env.BETTER_AUTH_SECRET !== "local-only-fixture") process.exit(52);
  if (process.env.UNRELATED_RUNTIME_VALUE || process.env.APP_RUNTIME_STATE_DIR) process.exit(53);
  if (!process.env.BUN_OPTIONS?.includes("--conditions=source")) process.exit(55);
  const compiled = await Bun.file(root + "/.compiled").exists();
  if (compiled === (process.env.FIXTURE_OUTCOME === "already compiled")) process.exit(54);
  if (process.env.FIXTURE_OUTCOME === "native output rejected") {
    console.error("native output verification rejected");
    process.exit(42);
  }
  console.log("verified selected native output");
}
  `,
        );
      }
      const run = vi.fn((input: Parameters<SandboxSession["run"]>[0]) => {
        const result = spawnSync("/bin/bash", ["-c", input.command], {
          cwd: directory,
          encoding: "utf-8",
          env: {
            ...process.env,
            ...input.env,
            BETTER_AUTH_SECRET: "",
            FIXTURE_OUTCOME: scenario.outcome,
            FIXTURE_NODE: process.execPath,
            FIXTURE_SOURCE_PATH: process.env.PATH ?? "",
            PATH: `${directory}:${process.env.PATH ?? ""}`,
          },
          timeout: 5000,
        });
        if (result.error !== undefined) {
          throw result.error;
        }
        return Promise.resolve({
          exitCode: result.status ?? -1,
          stderr: result.stderr,
          stdout: result.stdout,
        });
      });
      const command = repositoryDeliveryBuildCommand("example", scenario.alreadyCompiled);
      const result = await sandboxValidationCommandExecutor({
        alreadyCompiled: scenario.alreadyCompiled,
      })({
        appId: "example",
        command,
        sandbox: createSandbox({ run }),
        validationRoot: directory,
      });
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0]?.[0].command).toContain(command);
      expect(result.exitCode, result.stdout).toBe(scenario.exitCode);
      expect(result.stdout).not.toContain("legacy app:check invoked");
      expect(result.stdout).not.toContain("local-only-fixture");
      if (scenario.exitCode === 0) {
        expect(result.stdout).toContain("verified selected native output");
      }
      if (scenario.outcome === "already compiled") {
        expect(result.stdout).not.toContain("compiled selected schema");
      }
      if (scenario.privateRunner === true && scenario.exitCode === 0) {
        expect(result.stdout).toContain("generated selected catalog");
        expect(result.stdout).toContain("ran selected native build");
      }
      if (scenario.outcome === "catalog failed") {
        expect(result.stdout).not.toContain("ran selected native build");
      }
      if (scenario.outcome === "build failed") {
        expect(result.stdout).not.toContain("verified selected native output");
      }
      if (scenario.outcome === "private verifier rejected") {
        expect(result.stdout).toContain("native output verification rejected");
      }
    } finally {
      rmSync(stateDirectory, { force: true, recursive: true });
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("does not validate a resumed workspace when declared tool activation fails", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "builder-toolchain-failure-"));
    try {
      mkdirSync(path.join(directory, ".config/mise"), { recursive: true });
      writeFileSync(path.join(directory, ".config/mise/config.toml"), "[tools]\n");
      writeFileSync(path.join(directory, "bun"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      writeFileSync(
        path.join(directory, "mise"),
        `#!/bin/sh
case "$1" in
 trust) exit 0 ;;
 install) printf 'declared tool installation failed\\n' >&2; exit 13 ;;
esac
printf 'validation must not run\\n'
exit 99
`,
        { mode: 0o755 },
      );
      const run = vi.fn((input: Parameters<SandboxSession["run"]>[0]) => {
        const result = spawnSync("/bin/bash", ["-c", input.command], {
          cwd: directory,
          encoding: "utf-8",
          env: { ...process.env, ...input.env, PATH: `${directory}:/usr/bin:/bin` },
        });
        if (result.error) {
          throw result.error;
        }
        return Promise.resolve({
          exitCode: result.status ?? -1,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      });
      const result = await sandboxValidationCommandExecutor()({
        appId: "example",
        command: repositoryDeliveryBuildCommand("example"),
        sandbox: createSandbox({ run }),
        validationRoot: directory,
      });
      expect(result.exitCode).toBe(13);
      expect(result.stdout).toContain("declared tool installation failed");
      expect(result.stdout).not.toContain("validation must not run");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("returns a validation failure even when a local service keeps writing after the task exits", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "builder-validation-"));
    mkdirSync(path.join(directory, ".config/mise"), { recursive: true });
    writeFileSync(path.join(directory, ".config/mise/config.toml"), "[tools]\n");
    writeFileSync(path.join(directory, "bun"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(path.join(directory, "source-cue"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const mise = path.join(directory, "mise");
    writeFileSync(
      mise,
      "#!/bin/sh\ncase \"$1\" in trust|install) exit 0;; which) printf '%s\\n' \"$PWD/source-cue\"; exit 0;; esac\n(sleep 3; printf 'service log\\n') &\nprintf 'test failure\\n'\nexit 17\n",
    );
    chmodSync(mise, 0o755);
    try {
      // oxlint-disable-next-line eslint/require-await -- model the sandbox's async command API
      const run = vi.fn(async ({ command }: { command: string }) => {
        const result = spawnSync("/bin/bash", ["-c", command], {
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
        command: "mise run --no-deps --skip-tools app:test example 1/1",
        sandbox: createSandbox({ run }),
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
