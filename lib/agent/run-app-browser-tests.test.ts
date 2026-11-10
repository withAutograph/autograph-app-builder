/* oxlint-disable eslint/require-await -- Controlled asynchronous tool ports preserve real Promise and cancellation boundaries. */
import type { SandboxSession } from "eve/sandbox";
import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareAppLocalPreview } from "../../agent/tools/prepare-app-local-preview";
import { localRuntimeEnvironmentPath } from "../repository/runtime-environment";

import browserTool, {
  appBrowserTestCommand,
  runAppBrowserTests,
} from "../../agent/tools/run-app-browser-tests";
import { appBuilderWorkflowState } from "./workflow-state";
import type { AppBuilderWorkflowState } from "./workflow-state";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Spy on selected-app resolution while exercising the real standalone tool result.
import * as selectedApp from "./runnable-selected-app";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Supply an owned prior artifact without loading a provider workspace.
import * as priorArtifactReader from "./prior-validated-private-artifact";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Keep actual tool orchestration while controlling only the completed browser task.
import * as browserRunner from "./app-browser-test-runner";

// oxlint-disable-next-line sonarjs/no-wildcard-import -- Spy on the actual prepared runtime resolver for this local browser boundary.
import * as preparedRuntime from "./prepared-runtime-execution";
import { workingPreviewState } from "./working-preview-state";
import type { PreparedRuntimeExecution } from "./prepared-runtime-execution";
import { runAppBrowserTests as runResolvedAppBrowserTests } from "./app-browser-test-runner";

type SandboxRunOptions = Parameters<SandboxSession["run"]>[0];

// oxlint-disable-next-line anti-slop/no-module-mocking -- Exercise the authored execute function without launching the agent runtime.
vi.mock(import("eve/tools"), async (importOriginal) => ({
  ...(await importOriginal()),
  defineTool: <T>(definition: T) => definition,
}));

afterEach(() => vi.restoreAllMocks());

const browserToolFixture = (phase: "validated" | "applied" = "validated") => {
  // SAFETY: These controlled ports read only the workflow phase and accepted app identity.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The source selection port is replaced below; no incomplete receipt is admitted to production logic.
  const state = { phase, appSpec: { appId: "spend-review" } } as Extract<
    AppBuilderWorkflowState,
    { phase: "validated" | "applied" }
  >;
  const stateRead = vi.spyOn(appBuilderWorkflowState, "get").mockReturnValue(state);
  vi.spyOn(selectedApp, "runnableSelectedApp").mockResolvedValue({
    appId: "spend-review",
    root: "/workspace/repository",
    revision: "current-apply",
    reusable: true,
  });
  vi.spyOn(preparedRuntime, "resolvePreparedRuntimeExecution").mockResolvedValue(null);
  vi.spyOn(workingPreviewState, "get").mockReturnValue(null);
  const failure = {
    command: appBrowserTestCommand("spend-review"),
    diagnostic: { categories: ["assertion" as const], stages: [] },
    exitCode: 1,
    problem: "An app-owned browser assertion failed.",
    status: "failed" as const,
    stdout: "[private browser] failed: Save then reopen",
    stderr: "",
  };
  const browser = vi.spyOn(browserRunner, "runAppBrowserTests").mockResolvedValue(failure);
  const run = vi
    .fn<SandboxSession["run"]>()
    .mockResolvedValue({ exitCode: 0, stdout: "null", stderr: "" });
  const controller = new AbortController();
  // SAFETY: The real execute path reads only these session, Sandbox and cancellation capabilities.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The fixture supplies every capability reached by the controlled browser path.
  const ctx = {
    abortSignal: controller.signal,
    getSandbox: async () => ({ id: "owned", run }),
    session: { auth: null, id: "owner-session" },
  } as never;
  return { browser, controller, ctx, failure, state, stateRead };
};

describe("standalone browser failure continuation", () => {
  it("adds requested-delivery draft review after technical validation without changing browser failure facts", async () => {
    const f = browserToolFixture();
    const result = await browserTool.execute({}, f.ctx);
    expect(result).toMatchObject({
      ...f.failure,
      draftReview: {
        status: "available",
        nextCall: { tool: "prepare_github_draft_review", input: {} },
      },
    });
    expect(result).toHaveProperty(
      "draftReview.guidance",
      expect.stringContaining("For requested GitHub delivery"),
    );
  });

  it("does not add draft review for unvalidated current source", async () => {
    const f = browserToolFixture("applied");
    const result = await browserTool.execute({}, f.ctx);
    expect(result).toMatchObject(f.failure);
    expect(result).not.toHaveProperty("draftReview");
  });

  it("keeps a passing browser result unchanged", async () => {
    const f = browserToolFixture();
    const passed = {
      command: f.failure.command,
      exitCode: 0,
      status: "passed" as const,
      stdout: "passed",
      stderr: "",
    };
    f.browser.mockResolvedValue(passed);
    expect(await browserTool.execute({}, f.ctx)).toEqual(passed);
  });

  it("never recommends current draft review from a failed prior-validated artifact", async () => {
    const f = browserToolFixture();
    vi.spyOn(priorArtifactReader, "priorValidatedPrivateArtifact").mockResolvedValue({
      appId: "spend-review",
      root: "/workspace/prior-artifact",
      revision: "prior-apply",
      validationDigest: "prior-validation",
      reusable: true,
      assertCurrent: () => {},
      verifyCurrent: async () => {},
    });
    const result = await browserTool.execute({ artifact: "prior-validated" }, f.ctx);
    expect(result).toMatchObject({ status: "failed", reason: "private-preview-refresh-required" });
    expect(result).not.toHaveProperty("draftReview");
  });

  it("does not attach another app's current draft to the completed browser result", async () => {
    const f = browserToolFixture();
    f.browser.mockImplementation(async () => {
      f.stateRead.mockReturnValue({
        ...f.state,
        appSpec: { ...f.state.appSpec, appId: "other-app" },
      });
      return f.failure;
    });
    const result = await browserTool.execute({}, f.ctx);
    expect(result).toMatchObject(f.failure);
    expect(result).not.toHaveProperty("draftReview");
  });

  it("preserves cancellation instead of turning the result into a review continuation", async () => {
    const f = browserToolFixture();
    const cancellation = new Error("cancelled by owner");
    f.browser.mockImplementation(async () => {
      f.controller.abort(cancellation);
      return f.failure;
    });
    await expect(browserTool.execute({}, f.ctx)).rejects.toBe(cancellation);
  });
});

describe("private app browser tests", () => {
  const marker = "[private browser prerequisite] private-preview-refresh-required";

  it.each([
    { exitCode: 1, refresh: true, stdout: `other line\n${marker}\n[private browser] run failed` },
    { exitCode: 1, refresh: true, stdout: `other line\r\n${marker}\r\n` },
    {
      exitCode: 1,
      refresh: false,
      stdout: `[private browser] failed: ${marker} (tests/e2e/page.spec.ts:28)`,
    },
    { exitCode: 1, refresh: false, stdout: `\u001B${marker}` },
    { exitCode: 1, refresh: false, stdout: `${marker} extra` },
    { exitCode: 1, refresh: false, stdout: "[private browser stage] preview-refresh-required" },
    { exitCode: 0, refresh: false, stdout: marker },
  ])(
    "only classifies an exact standalone failure marker ($stdout)",
    async ({ stdout, exitCode, refresh }) => {
      const result = await runResolvedAppBrowserTests({
        appId: "spend-review",
        root: "/workspace/repository",
        sandbox: { run: vi.fn().mockResolvedValue({ exitCode, stderr: "", stdout }) },
      });
      expect(result).toMatchObject({ exitCode, status: exitCode === 0 ? "passed" : "failed" });
      if (refresh) {
        expect(result).toHaveProperty("reason", "private-preview-refresh-required");
      } else {
        expect(result).not.toHaveProperty("reason");
      }
    },
  );

  it.each([
    {
      origin: "https://stale-private.vercel.run",
      readExit: 0,
      runBrowser: false,
      status: "failed",
    },
    { origin: "http://localhost:3000", readExit: 0, runBrowser: true, status: "passed" },
    { origin: null, readExit: 0, runBrowser: true, status: "passed" },
    { origin: null, readExit: 1, runBrowser: false, status: "failed" },
  ])(
    "uses the owned local Auth origin before unbound browser dispatch ($origin, $readExit)",
    async ({ origin, readExit, status, runBrowser }) => {
      const runtime = vi
        .spyOn(preparedRuntime, "resolvePreparedRuntimeExecution")
        .mockResolvedValue(null);
      const preview = vi.spyOn(workingPreviewState, "get").mockReturnValue(null);
      try {
        const run = vi
          .fn<SandboxSession["run"]>()
          .mockResolvedValueOnce({ exitCode: readExit, stderr: "", stdout: JSON.stringify(origin) })
          .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "2 passed" });
        const appId = "spend-review";
        const root = "/workspace/repository";
        const result = await runAppBrowserTests({
          appId,
          root,
          sandbox: { run },
          execution: {
            appId,
            root,
            sessionId: "owner-session",
            sandboxId: "owned",
            sessionAuth: {},
            state: { phase: "validated" },
          },
        });
        expect(result).toMatchObject({ status });
        if (runBrowser) {
          expect(run.mock.calls[1]?.[0].command).toBe(appBrowserTestCommand(appId));
        } else {
          expect(result).toMatchObject({
            exitCode: null,
            reason: "private-preview-refresh-required",
            stdout: "",
          });
          expect(run).toHaveBeenCalledTimes(1);
        }
      } finally {
        runtime.mockRestore();
        preview.mockRestore();
      }
    },
  );

  it("requires an exact prior-artifact preview before any browser command", async () => {
    const preview = vi.spyOn(workingPreviewState, "get").mockReturnValue({
      sandboxId: "owned",
      providerSessionId: "provider",
      commandId: "ordinary",
      receipt: {
        appId: "spend-review",
        expiresAt: "2026-11-06T00:00:00Z",
        verifiedAt: "2026-11-05T00:00:00Z",
        url: "https://preview.example",
        status: "ready",
      },
    });
    const run = vi.fn<SandboxSession["run"]>();
    const verifyCurrent = vi.fn<() => Promise<void>>();
    try {
      const result = await runAppBrowserTests({
        appId: "spend-review",
        root: "/workspace/repository",
        sandbox: { run },
        execution: {
          appId: "spend-review",
          root: "/workspace/repository",
          sessionId: "owner-session",
          sandboxId: "owned",
          sessionAuth: {},
          state: { phase: "planned" },
        },
        priorArtifact: {
          appId: "spend-review",
          root: "/workspace/repository",
          revision: "prior-apply",
          validationDigest: "prior-validation",
          reusable: true,
          assertCurrent: vi.fn<() => void>(),
          verifyCurrent,
        },
      });
      expect(result).toMatchObject({ exitCode: null, reason: "private-preview-refresh-required" });
      expect(run).not.toHaveBeenCalled();
      expect(verifyCurrent).not.toHaveBeenCalled();
    } finally {
      preview.mockRestore();
    }
  });

  it("forwards the focused selection through the prepared hosted runtime", async () => {
    const runTask = vi
      .fn<PreparedRuntimeExecution["runTask"]>()
      .mockResolvedValue({ exitCode: 0, stderr: "", stdout: "selected passed" });
    const runtime: PreparedRuntimeExecution = {
      environmentPath: "/private/environment.json",
      installationProof: {
        actors: 1,
        appId: "spend-review",
        artifactHash: "a".repeat(64),
        authenticatedBehavior: "unassessed",
        branch: "draft",
        environment: "preview",
        observation: "database-verification",
        observedAt: "2026-10-20T00:00:00Z",
        releaseId: "release",
        tenants: 1,
      },
      prepareAuthenticatedOrigin: vi.fn(),
      runTask,
      stateDirectory: "/private",
    };
    const selection = { maxFailures: 1, retries: 0, testName: "@acceptance", workers: 1 };
    const result = await runAppBrowserTests({
      appId: "spend-review",
      root: "/workspace/published",
      sandbox: { run: vi.fn() },
      runtime,
      selection,
    });
    expect(result).toMatchObject({ status: "passed" });
    expect(runTask).toHaveBeenCalledWith(
      expect.objectContaining({ browserSelection: selection, task: "test-e2e" }),
    );
  });
  it("passes a literal focused selection to the private browser task", async () => {
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
    const run = vi.fn(() => Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }));
    const result = await runAppBrowserTests({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run },
      selection: { testName: "@acceptance", workers: 1 },
    });
    expect(result).toMatchObject({ exitCode: 0, status: "passed" });
    expect(run).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        command:
          "mise run --no-deps app:runtime run spend-review test-e2e '--grep' '@acceptance' '--workers=1'",
      }),
    );
  });
  it("recovers a missing browser library when the private reporter hides the loader error", async () => {
    const run = vi
      .fn<
        (
          options: SandboxRunOptions,
        ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
      >()
      .mockResolvedValueOnce({ exitCode: 1, stderr: "", stdout: "[private browser] run failed" })
      .mockResolvedValueOnce({ exitCode: 42, stderr: "", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "[private browser] run passed" });
    const result = await runResolvedAppBrowserTests({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run },
      privateBrowserEnvironment: { APP_TEST_PREVIEW_AUTHORITY_FILE: "/workspace/private.json" },
    });
    expect(result).toMatchObject({ status: "passed" });
    expect(run.mock.calls[1]?.[0]?.command).toContain("chromium.launch");
    expect(run.mock.calls[2]?.[0]?.command).toContain("playwright install-deps chromium");
  });
  it.each([false, true])(
    "reuses prepared local state with explicit signal %s and preserves it across dependency recovery",
    async (withSignal) => {
      const appId = "spend-review";
      const root = "/workspace/repository";
      const signal = withSignal ? new AbortController().signal : undefined;
      const environmentPath = localRuntimeEnvironmentPath(root, appId);
      const files = new Map<string, string>();
      let browserAttempts = 0;
      // Arrusted e927002 defaults to app-validation-runtime when the override is absent.
      const defaultStateDirectory = path.posix.join(
        // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Models the pinned repository CLI default without filesystem writes.
        "/tmp/app-validation-runtime",
        createHash("sha256").update(root).digest("hex").slice(0, 16),
        appId,
      );
      const executeCommand = (options: SandboxRunOptions) => {
        if (options.command === `mise run --no-deps app:describe ${appId}`) {
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              app: { id: appId, routes: ["/spend-review"], workspacePath: "apps/spend-review" },
              backend: {
                authorization: "declared-policy",
                kind: "generated-postgres",
                release: { artifactHash: "hash", directory: "release", id: "v1" },
                roles: ["member"],
                runtime: { databaseEnvironment: "SPEND_REVIEW_DATABASE_URL" },
                schemaReceipt: null,
              },
              validation: {
                browser: null,
                check: { task: "check" },
                test: { shards: 1, task: "test" },
              },
              version: 1,
            }),
          };
        }
        const stateDirectory = options.env?.APP_RUNTIME_STATE_DIR ?? defaultStateDirectory;
        const statePath = path.posix.join(stateDirectory, "environment.json");
        if (options.command.includes(`app:runtime prepare ${appId} local`)) {
          files.set(statePath, "prepared local environment");
          return { exitCode: 0, stderr: "", stdout: "prepared" };
        }
        if (options.command.includes("playwright install-deps chromium")) {
          return { exitCode: 0, stderr: "", stdout: "installed" };
        }
        if (!files.has(statePath)) {
          return { exitCode: 1, stderr: `ENOENT: ${statePath}`, stdout: "" };
        }
        browserAttempts += 1;
        return browserAttempts === 1
          ? {
              exitCode: 1,
              stderr: "error while loading shared libraries: libglib-2.0.so.0",
              stdout: "",
            }
          : { exitCode: 0, stderr: "", stdout: files.get(statePath) ?? "" };
      };
      const run = vi.fn(
        async (options: SandboxRunOptions) => await Promise.resolve(executeCommand(options)),
      );
      const input = { appId, root, sandbox: { run }, signal };
      expect(await prepareAppLocalPreview(input)).toMatchObject({ status: "prepared" });
      expect(files.has(environmentPath)).toBe(true);
      const unbound = await run({ command: appBrowserTestCommand(appId), workingDirectory: root });
      expect(unbound.exitCode).toBe(1);
      expect(unbound.stderr).toContain("ENOENT");
      const result = await runAppBrowserTests(input);
      expect(result).toMatchObject({ status: "passed", stdout: "prepared local environment" });
      const browserCalls = run.mock.calls
        .map(([options]) => options)
        .filter((options) => options.command === appBrowserTestCommand(appId))
        .slice(1);
      expect(browserCalls).toHaveLength(2);
      const expected: SandboxRunOptions = {
        command: appBrowserTestCommand(appId),
        env: { APP_RUNTIME_STATE_DIR: path.posix.dirname(environmentPath) },
        workingDirectory: root,
      };
      if (signal !== undefined) {
        expected.abortSignal = signal;
      }
      for (const options of browserCalls) {
        expect(options).toEqual(expected);
      }
      expect(files.size).toBe(1);
    },
  );

  it.each([undefined, "https://canonical.example.test"])(
    "retains the hosted test origin %s across dependency recovery",
    async (browserTestBaseUrl) => {
      const run = vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "installed" });
      const runTask = vi
        .fn<PreparedRuntimeExecution["runTask"]>()
        .mockResolvedValueOnce({
          exitCode: 1,
          stderr: "error while loading shared libraries: libglib-2.0.so.0",
          stdout: "",
        })
        .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "8 passed" });
      const { signal } = new AbortController();
      const result = await runAppBrowserTests({
        appId: "spend-review",
        root: "/workspace/repository",
        runtime: {
          browserTestBaseUrl,
          environmentPath: "/private-state/environment.json",
          installationProof: {
            actors: 8,
            appId: "spend-review",
            artifactHash: "a".repeat(64),
            authenticatedBehavior: "unassessed",
            branch: "builder/spend-review",
            environment: "preview",
            observation: "database-verification",
            observedAt: "2026-09-29T12:00:00Z",
            releaseId: "release_1",
            tenants: 2,
          },
          prepareAuthenticatedOrigin: vi.fn(),
          runTask,
          stateDirectory: "/private-state",
        },
        sandbox: { run },
        signal,
      });
      expect(result).toMatchObject({ status: "passed", stdout: "8 passed" });
      for (const [request] of runTask.mock.calls) {
        expect(request.task).toBe("test-e2e");
        expect(request.signal).toBe(signal);
        expect(request.environment).toEqual(
          browserTestBaseUrl === undefined ? undefined : { APP_TEST_BASE_URL: browserTestBaseUrl },
        );
      }
      expect(runTask).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith({
        command: 'sudo env PATH="$PATH" ./node_modules/.bin/playwright install-deps chromium',
        workingDirectory: "/workspace/repository",
      });
    },
  );
  it("uses only the selected app's test-e2e task in the applied checkout", async () => {
    const run = vi.fn().mockResolvedValue({
      exitCode: 0,
      stderr: "",
      stdout: "5 passed",
    });
    const result = await runAppBrowserTests({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run },
    });
    expect(run).toHaveBeenCalledWith({
      command: "mise run --no-deps app:runtime run spend-review test-e2e",
      env: {
        APP_RUNTIME_STATE_DIR: path.posix.dirname(
          localRuntimeEnvironmentPath("/workspace/repository", "spend-review"),
        ),
      },
      workingDirectory: "/workspace/repository",
    });
    expect(result).toMatchObject({ exitCode: 0, status: "passed", stdout: "5 passed" });
    expect(() => {
      appBrowserTestCommand("other-app; deploy");
    }).toThrow();
  });

  it("reports failing browser assertions and redacts private runtime addresses", async () => {
    const result = await runAppBrowserTests({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: {
        run: vi.fn().mockResolvedValue({
          exitCode: 1,
          stderr:
            "Error: expected one audit event at postgres://postgres:secret@127.0.0.1:52016/demo",
          stdout: "1 failed: create-refresh-decide-reset",
        }),
      },
    });
    expect(result).toMatchObject({ exitCode: 1, status: "failed" });
    expect(result.problem).toContain("browser test task exited");
    expect(result.stdout).toContain("create-refresh-decide-reset");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it.each([
    {
      reporterLine: "[private browser stage] auth-session",
      stages: ["auth-session"],
      categories: [],
      instruction: "access setup",
    },
    {
      reporterLine: "[private browser category] browser-launch",
      stages: [],
      categories: ["browser-launch"],
      instruction: "browser could not launch",
    },
    {
      reporterLine: "[private browser category] navigation",
      stages: [],
      categories: ["navigation"],
      instruction: "navigation failed",
    },
    {
      reporterLine: "[private browser category] assertion",
      stages: [],
      categories: ["assertion"],
      instruction: "application assertion failed",
    },
    {
      reporterLine: "[private browser category] timeout",
      stages: [],
      categories: ["timeout"],
      instruction: "operation timed out",
    },
    {
      reporterLine: "[private browser category] unknown",
      stages: [],
      categories: [],
      instruction: "did not identify",
    },
    {
      reporterLine: "test title [private browser stage] auth-session",
      stages: [],
      categories: [],
      instruction: "did not identify",
    },
    {
      reporterLine: "\u001B[private browser category] assertion",
      stages: [],
      categories: [],
      instruction: "did not identify",
    },
  ])(
    "returns safe recovery for $reporterLine",
    async ({ reporterLine, stages, categories, instruction }) => {
      const result = await runResolvedAppBrowserTests({
        appId: "notes",
        root: "/workspace/repository",
        sandbox: {
          run: vi.fn().mockResolvedValue({
            exitCode: 1,
            stdout: `${reporterLine}\r\n[private browser failure] tests/notes.spec.ts:12\n`,
            stderr: "token=private-token https://private.example/?secret=value",
          }),
        },
      });
      expect(result).toMatchObject({
        status: "failed",
        diagnostic: { categories, stages },
      });
      expect(result.problem).toContain(instruction);
      expect(result.stdout).toContain("tests/notes.spec.ts:12");
      expect(JSON.stringify(result)).not.toContain("private-token");
      expect(JSON.stringify(result)).not.toContain("private.example");
      expect(JSON.stringify(result)).not.toContain("secret=value");
    },
  );

  it("keeps access setup failures distinct from assertions", async () => {
    const result = await runResolvedAppBrowserTests({
      appId: "notes",
      root: "/workspace/repository",
      sandbox: {
        run: vi.fn().mockResolvedValue({
          exitCode: 1,
          stdout: "[private browser category] assertion\n[private browser stage] auth-ui\n",
          stderr: "",
        }),
      },
    });
    expect(result.problem).toContain("access setup");
  });

  it.each(["throw", "return"])(
    "preserves cancellation when the sandbox %s completes",
    async (completion) => {
      const controller = new AbortController();
      const cancellation = new Error("browser run cancelled");
      const run = vi.fn().mockImplementation(() => {
        controller.abort(cancellation);
        if (completion === "throw") {
          throw cancellation;
        }
        return { exitCode: 0, stdout: "passed", stderr: "" };
      });
      await expect(
        runResolvedAppBrowserTests({
          appId: "notes",
          root: "/workspace/repository",
          sandbox: { run },
          signal: controller.signal,
        }),
      ).rejects.toBe(cancellation);
    },
  );

  it("repairs missing Chromium libraries once and reruns the browser journey", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 1,
        stderr: "error while loading shared libraries: libglib-2.0.so.0",
        stdout: "",
      })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "installed" })
      .mockResolvedValueOnce({ exitCode: 0, stderr: "", stdout: "4 passed" });
    const result = await runAppBrowserTests({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run },
    });
    expect(run).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        command: "mise run --no-deps app:runtime run spend-review test-e2e",
      }),
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: 'sudo env PATH="$PATH" ./node_modules/.bin/playwright install-deps chromium',
      }),
    );
    expect(run).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ status: "passed", stdout: "4 passed" });
  });

  it("keeps runtime resolution failure inside the shared runner's private error projection", async () => {
    const run = vi.fn<SandboxSession["run"]>();
    const resolveRuntime = vi
      .fn<() => Promise<PreparedRuntimeExecution | null>>()
      .mockRejectedValue(
        new Error(
          "Binding failed at postgres://user:private-value@database.example/app token=private-token",
        ),
      );
    const result = await runResolvedAppBrowserTests({
      appId: "reports",
      root: "/workspace/repository",
      sandbox: { run },
      resolveRuntime,
    });
    expect(result).toMatchObject({ exitCode: null, status: "failed" });
    expect(result.problem).toContain("Binding failed");
    expect(JSON.stringify(result)).not.toContain("private-value");
    expect(JSON.stringify(result)).not.toContain("private-token");
    expect(run).not.toHaveBeenCalled();
    expect(resolveRuntime).toHaveBeenCalledOnce();
  });
  it("runs an already resolved task through the shared path with retained command continuation", async () => {
    const runTask = vi
      .fn<PreparedRuntimeExecution["runTask"]>()
      .mockResolvedValue({ exitCode: 0, stderr: "", stdout: "scenario passed" });
    const resolveRuntime = vi.fn<() => Promise<PreparedRuntimeExecution | null>>();
    const checkpoint = vi.fn<(commandId: string) => Promise<void>>();
    const runtime: PreparedRuntimeExecution = {
      environmentPath: "/private-state/environment.json",
      installationProof: {
        actors: 1,
        appId: "reports",
        artifactHash: "a".repeat(64),
        authenticatedBehavior: "unassessed",
        branch: "review",
        environment: "preview",
        observation: "database-verification",
        observedAt: "2026-10-20T00:00:00Z",
        releaseId: "release",
        tenants: 1,
      },
      prepareAuthenticatedOrigin: vi.fn(),
      runTask,
      stateDirectory: "/private-state",
    };
    const result = await runResolvedAppBrowserTests({
      appId: "reports",
      root: "/workspace/repository",
      sandbox: { run: vi.fn<SandboxSession["run"]>() },
      runtime,
      resolveRuntime,
      continuation: {
        commandId: "retained-command",
        commandCheckpoint: checkpoint,
        allowDispatch: false,
      },
    });
    expect(result).toMatchObject({ status: "passed", stdout: "scenario passed" });
    expect(runTask).toHaveBeenCalledWith(
      expect.objectContaining({
        allowDispatch: false,
        commandCheckpoint: checkpoint,
        commandId: "retained-command",
        task: "test-e2e",
      }),
    );
    expect(resolveRuntime).not.toHaveBeenCalled();
  });
  it("names sandbox command failures", async () => {
    const result = await runAppBrowserTests({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run: vi.fn().mockRejectedValue(new Error("checkout missing")) },
    });
    expect(result).toMatchObject({ exitCode: null, status: "failed" });
    expect(result.problem).toContain("checkout missing");
    expect(result.problem).toContain("command runner");
  });
});

it.each(["/actual-catalog-route", null, undefined])(
  "keeps browser entry %s separate from Auth origin and never tests the Shell for an unresolved app",
  async (browserTestEntryPath) => {
    const runTask = vi
      .fn<PreparedRuntimeExecution["runTask"]>()
      .mockResolvedValue({ exitCode: 0, stderr: "", stdout: "passed" });
    const runtime: PreparedRuntimeExecution = {
      browserTestBaseUrl: "https://public-owned.example",
      browserTestEntryPath,
      environmentPath: "/private/environment.json",
      installationProof: {
        actors: 1,
        appId: "spend-review",
        artifactHash: "a".repeat(64),
        authenticatedBehavior: "unassessed",
        branch: "draft",
        environment: "preview",
        observation: "database-verification",
        observedAt: "2026-10-20T00:00:00Z",
        releaseId: "release",
        tenants: 1,
      },
      prepareAuthenticatedOrigin: vi.fn(),
      runTask,
      stateDirectory: "/private",
    };
    const result = await runResolvedAppBrowserTests({
      appId: "spend-review",
      root: "/workspace/repository",
      sandbox: { run: vi.fn() },
      runtime,
    });
    if (browserTestEntryPath === null) {
      expect(result.status).toBe("failed");
      expect(runTask).not.toHaveBeenCalled();
      return;
    }
    expect(result.status).toBe("passed");
    interface ExpectedBrowserEnvironment {
      APP_TEST_BASE_URL: string;
      APP_TEST_ENTRY_PATH?: string;
    }
    const expectedEnvironment: ExpectedBrowserEnvironment = {
      APP_TEST_BASE_URL: "https://public-owned.example",
    };
    if (browserTestEntryPath !== undefined) {
      expectedEnvironment.APP_TEST_ENTRY_PATH = browserTestEntryPath;
    }
    expect(runTask).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: expectedEnvironment,
      }),
    );
    expect(runtime.prepareAuthenticatedOrigin).not.toHaveBeenCalled();
  },
);
