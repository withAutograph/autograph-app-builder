import { browserEntryPathSchema } from "../repository/browser-entry-path";
import type { SandboxSession } from "eve/sandbox";
import path from "node:path";
import { z } from "zod";
import { localRuntimeEnvironmentPath } from "../repository/runtime-environment";
import type { PreparedRuntimeExecution } from "./prepared-runtime-execution-core";
import {
  browserTestSelectionArguments,
  browserTestSelectionSchema,
} from "./browser-test-selection";
import type { BrowserTestSelection } from "./browser-test-selection";

const privatePreviewPrerequisiteLine =
  "[private browser prerequisite] private-preview-refresh-required";

const appIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);

export const appBrowserTestCommand = (appId: string): string =>
  `mise run --no-deps app:runtime run ${appIdSchema.parse(appId)} test-e2e`;

const quoteBrowserArgument = (argument: string) => `'${argument.replaceAll("'", "'\\''")}'`;

const missingBrowserLibrary = /error while loading shared libraries: [A-Za-z0-9_.+-]+\.so/iu;
const browserDependencyProbe = `node -e 'const { chromium } = require("playwright"); chromium.launch().then((browser) => browser.close()).catch((error) => { process.exitCode = /error while loading shared libraries: [A-Za-z0-9_.+-]+\\.so/i.test(error.message) ? 42 : 1; });'`;

const needsBrowserDependencies = async (
  input: {
    sandbox: Pick<SandboxSession, "run">;
    root: string;
    privateBrowserEnvironment?: Readonly<Record<string, string>>;
    signal?: AbortSignal;
  },
  result: { exitCode: number | null; stdout: string; stderr: string },
): Promise<boolean> => {
  if (result.exitCode === 0) {
    return false;
  }
  if (missingBrowserLibrary.test(`${result.stderr}\n${result.stdout}`)) {
    return true;
  }
  if (input.privateBrowserEnvironment === undefined) {
    return false;
  }

  // The private reporter suppresses browser launch errors. Probe without app authority.
  const probe = await input.sandbox.run({
    command: browserDependencyProbe,
    workingDirectory: input.root,
    ...(input.signal === undefined ? {} : { abortSignal: input.signal }),
  });
  return probe.exitCode === 42;
};

const safeOutput = (value: string): string =>
  value
    .replaceAll(/\p{Cc}/gu, (character) =>
      character === "\n" || character === "\t" ? character : "",
    )
    .replaceAll(/\b(?:https?|postgres(?:ql)?):\/\/[^\s"'<>]+/giu, "[URL REDACTED]")
    .replaceAll(/Bearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replaceAll(
      /\b(?:authorization|cookie|password|passwd|secret|token|api[-_]?key)\s*[:=]\s*[^\s,;]+/giu,
      "[CREDENTIAL REDACTED]",
    )
    .replaceAll(
      /\b(?:gh[oprsu]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/gu,
      "[REDACTED]",
    )
    .slice(-8000)
    .trim();

export const runAppBrowserTests = async (input: {
  appId: string;
  root: string;
  sandbox: Pick<SandboxSession, "run">;
  signal?: AbortSignal;
  resolveRuntime?: () => Promise<PreparedRuntimeExecution | null>;
  runtime?: PreparedRuntimeExecution | null;
  selection?: BrowserTestSelection;
  privateBrowserEnvironment?: Readonly<Record<string, string>>;
  continuation?: {
    commandId?: string;
    commandCheckpoint: (commandId: string) => Promise<void>;
    allowDispatch: boolean;
  };
}) => {
  const selection =
    input.selection === undefined ? undefined : browserTestSelectionSchema.parse(input.selection);
  const command =
    appBrowserTestCommand(input.appId) + (selection === undefined ? "" : " (focused selection)");
  try {
    const runtime = input.runtime ?? (input.resolveRuntime ? await input.resolveRuntime() : null);
    if (runtime?.browserTestEntryPath === null) {
      return {
        command,
        exitCode: null,
        problem:
          "Browser verification needs an app-owned catalog entry. Declare autograph.browserEntryPath for ambiguous routes, then refresh the runtime binding. App creation, runtime preparation and release remain available.",
        status: "failed" as const,
        stderr: "",
        stdout: "",
      };
    }
    const entryPath =
      runtime?.browserTestEntryPath === undefined
        ? undefined
        : browserEntryPathSchema.parse(runtime.browserTestEntryPath);
    const browserEnvironment: Record<string, string> = {};
    if (runtime?.browserTestBaseUrl !== undefined) {
      browserEnvironment.APP_TEST_BASE_URL = runtime.browserTestBaseUrl;
    }
    if (entryPath !== undefined) {
      browserEnvironment.APP_TEST_ENTRY_PATH = entryPath;
    }
    const runTask = async () => {
      if (runtime) {
        const taskOptions: Parameters<typeof runtime.runTask>[0] = {
          signal: input.signal,
          task: "test-e2e",
        };
        if (selection !== undefined) {
          taskOptions.browserSelection = selection;
        }
        const continuedOptions = { ...taskOptions, ...input.continuation };
        if (Object.keys(browserEnvironment).length > 0) {
          continuedOptions.environment = browserEnvironment;
        }
        return await runtime.runTask(continuedOptions);
      }
      const privateCommand =
        selection === undefined
          ? command
          : [
              appBrowserTestCommand(input.appId),
              ...browserTestSelectionArguments(selection).map(quoteBrowserArgument),
            ].join(" ");
      const env = {
        ...input.privateBrowserEnvironment,
        APP_RUNTIME_STATE_DIR: path.posix.dirname(
          localRuntimeEnvironmentPath(input.root, input.appId),
        ),
      };
      return input.signal === undefined
        ? await input.sandbox.run({ command: privateCommand, env, workingDirectory: input.root })
        : await input.sandbox.run({
            abortSignal: input.signal,
            command: privateCommand,
            env,
            workingDirectory: input.root,
          });
    };
    let result = await runTask();
    if (await needsBrowserDependencies(input, result)) {
      const dependencyCommand =
        'sudo env PATH="$PATH" ./node_modules/.bin/playwright install-deps chromium';
      const dependencies = await input.sandbox.run({
        command: dependencyCommand,
        workingDirectory: input.root,
      });
      if (dependencies.exitCode !== 0) {
        return {
          command: dependencyCommand,
          exitCode: dependencies.exitCode,
          problem:
            "Chromium could not start because a system library is missing, and Playwright could not install its Linux dependencies. Check package manager access in the private sandbox, then rerun the browser task.",
          status: "failed" as const,
          stderr: safeOutput(dependencies.stderr),
          stdout: safeOutput(dependencies.stdout),
        };
      }
      result = await runTask();
    }
    const stdout = safeOutput(result.stdout);
    const stderr = safeOutput(result.stderr);
    if (result.exitCode !== 0) {
      // Parse the original line so display redaction cannot manufacture a marker.
      if (result.stdout.split(/\r?\n/u).includes(privatePreviewPrerequisiteLine)) {
        return {
          command,
          exitCode: result.exitCode,
          problem:
            "Refresh the selected app's owner-bound private preview at its current Auth origin before browser verification. Private tests require trace off and the supported bounded reporter.",
          reason: "private-preview-refresh-required",
          status: "failed" as const,
          stderr,
          stdout,
        };
      }
      return {
        command,
        exitCode: result.exitCode,
        problem: `The selected app's browser test task exited with status ${result.exitCode}. Read the test name, assertion, server startup error, or missing browser/runtime dependency in the output. Fix that cause, then rerun this task in the private sandbox. A ready preview alone does not establish the requested behavior.`,
        status: "failed" as const,
        stderr,
        stdout,
      };
    }
    return {
      command,
      exitCode: 0,
      status: "passed" as const,
      stderr,
      stdout,
    };
  } catch (error) {
    const detail = safeOutput(error instanceof Error ? error.message : String(error));
    return {
      command,
      exitCode: null,
      problem: `The private sandbox could not run the selected app's repository-owned browser test task. Cause: ${detail || "No provider detail was returned."} Check the sandbox checkout, task discovery, and command runner, then retry.`,
      status: "failed" as const,
      stderr: "",
      stdout: "",
    };
  }
};
