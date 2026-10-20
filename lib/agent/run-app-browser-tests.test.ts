import type { SandboxSession } from "eve/sandbox";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { prepareAppLocalPreview } from "../../agent/tools/prepare-app-local-preview";
import { localRuntimeEnvironmentPath } from "../repository/runtime-environment";

import { appBrowserTestCommand, runAppBrowserTests } from "../../agent/tools/run-app-browser-tests";

import type { PreparedRuntimeExecution } from "./prepared-runtime-execution";
import { runAppBrowserTests as runResolvedAppBrowserTests } from "./app-browser-test-runner";

type SandboxRunOptions = Parameters<SandboxSession["run"]>[0];

describe("private app browser tests", () => {
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
      .mockResolvedValue({ exitCode: 0, stdout: "scenario passed", stderr: "" });
    const resolveRuntime = vi.fn<() => Promise<PreparedRuntimeExecution | null>>();
    const checkpoint = vi.fn<(commandId: string) => Promise<void>>();
    const runtime: PreparedRuntimeExecution = {
      environmentPath: "/private-state/environment.json",
      stateDirectory: "/private-state",
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
        task: "test-e2e",
        commandId: "retained-command",
        commandCheckpoint: checkpoint,
        allowDispatch: false,
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
