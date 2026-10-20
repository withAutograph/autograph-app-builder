/** Shared execution over approved private bindings; this module does not resolve agent state or define tools. */
import type { Sandbox } from "@vercel/sandbox";
import { z } from "zod";
import { HostedOperatorError } from "../provisioning/hosted-operator-contract";
import { HostedRuntimeProviderError } from "../provisioning/hosted-runtime-provider";
import type {
  PrivateRuntimeFiles,
  HostedRuntimeProof,
} from "../provisioning/hosted-runtime-service";
import { hostedRuntimeProofSchema } from "../provisioning/hosted-runtime-journal";
import { appDescriptionSchema } from "../repository/app-description";
import { sanitizeValidationDiagnosticText } from "../repository/validation-output-sanitize";
import { normalActorBrowserFiles } from "./normal-actor-browser-state";
import type { NormalActorRuntimeProjection } from "../provisioning/hosted-operator-normal-actor-program";

export interface PreparedRuntimeExecutionBinding {
  branch: string;
  environment: Record<string, string>;
  files: PrivateRuntimeFiles;
  projectId: string;
  stateDirectory: string;
  persistFiles: (files: PrivateRuntimeFiles) => Promise<void>;
}

export interface RuntimeCommand {
  cmdId?: string;
  exitCode: number | null;
  stdout: (options?: { signal?: AbortSignal }) => Promise<string>;
  logs: (options?: {
    signal?: AbortSignal;
  }) => AsyncIterable<{ stream: "stdout" | "stderr"; data: string }> & { close: () => void };
  wait: (options?: { signal?: AbortSignal }) => Promise<{ exitCode: number }>;
  kill: (signal: "SIGTERM", options?: { abortSignal?: AbortSignal }) => Promise<void>;
}
export type RuntimeTransport = Pick<Sandbox, "writeFiles"> & {
  fs: Pick<Sandbox["fs"], "mkdir" | "rm">;
  runCommand: (input: {
    args: string[];
    cmd: string;
    cwd: string;
    detached?: boolean;
    env?: Record<string, string>;
    signal?: AbortSignal;
  }) => Promise<RuntimeCommand>;
};
export interface PreparedRuntimeExecutionContext {
  appId: string;
  root: string;
  sandboxId: string;
  sessionAuth: unknown;
  sessionId: string;
  state: { phase: string; githubSource?: { resolvedRef: string } };
  signal?: AbortSignal;
}
export interface PreparedRuntimeExecution {
  /** Canonical native browser origin from the protected bindings read, for test commands only. */
  readonly browserTestBaseUrl?: string;
  installationProof: {
    appId: string;
    branch: string;
    environment: "preview";
    releaseId: string;
    artifactHash: string;
    actors: number;
    tenants: number;
    observedAt: string;
    observation: "database-verification";
    authenticatedBehavior: "unassessed";
  };
  environmentPath: string;
  stateDirectory: string;
  prepareAuthenticatedOrigin: (origin: string) => Promise<void>;
  runTask: (input: {
    task: "test-e2e" | "repository-check" | "repository-test";
    commandId?: string;
    commandCheckpoint?: (commandId: string) => Promise<void>;
    allowDispatch?: boolean;
    shard?: string;
    environment?: Readonly<Record<string, string | undefined>>;
    onChunk?: (channel: "stdout" | "stderr", content: string) => Promise<void>;
    signal?: AbortSignal;
  }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/** Changes browser origin only; database credentials, session tokens and release stay intact. */
export const runtimeFilesForOrigin = (files: PrivateRuntimeFiles, origin: string) => {
  const authOrigin = z
    .string()
    .regex(/^https:\/\/[a-z0-9-]+\.vercel\.run$/u)
    .parse(origin);
  const url = new URL(authOrigin);
  const environment = z
    .record(z.string(), z.string())
    .parse(JSON.parse(files["environment.json"] ?? "null"));
  const previousOrigin = environment.BETTER_AUTH_URL;
  environment.BETTER_AUTH_URL = authOrigin;
  environment.APP_TEST_BASE_URL = authOrigin;
  environment.PLATFORM_AUTH_TRUSTED_ORIGINS = authOrigin;
  const updated: PrivateRuntimeFiles = {
    ...files,
    "environment.json": JSON.stringify(environment),
  };
  for (const [name, content] of Object.entries(files)) {
    if (!name.endsWith(".storage.json")) {
      continue;
    }
    const storage = z
      .object({
        cookies: z.array(z.looseObject({ domain: z.string(), secure: z.boolean() })),
        origins: z.array(z.looseObject({ origin: z.string() })),
      })
      .parse(JSON.parse(content));
    storage.cookies = storage.cookies.map((cookie) => ({
      ...cookie,
      domain: url.hostname,
      secure: true,
    }));
    storage.origins = storage.origins.map((entry) =>
      entry.origin === previousOrigin ? { ...entry, origin: authOrigin } : entry,
    );
    updated[name] = JSON.stringify(storage);
  }
  return updated;
};

/** Server-only capability. Do not expose this object or its private paths in tool results. */
export const restorePreparedRuntimeExecution = async (input: {
  appId: string;
  browserTestBaseUrl?: string;
  root: string;
  normalActors?: NormalActorRuntimeProjection;
  /** Additional server-owned values that must never enter diagnostics or streamed output. */
  privateValues?: readonly string[];
  binding: PreparedRuntimeExecutionBinding;
  provider: RuntimeTransport;
  observeInstallation: (files: PrivateRuntimeFiles) => Promise<HostedRuntimeProof>;
  resumeCommand?: (commandId: string) => Promise<RuntimeCommand>;
  signal?: AbortSignal;
}): Promise<PreparedRuntimeExecution> => {
  const environmentPath = `${input.binding.stateDirectory}/environment.json`;
  let files: PrivateRuntimeFiles = {
    ...input.binding.files,
    "environment.json": JSON.stringify({
      ...input.binding.environment,
    }),
  };
  const normalActors =
    input.normalActors === undefined
      ? undefined
      : normalActorBrowserFiles(
          input.normalActors,
          input.binding.stateDirectory,
          input.browserTestBaseUrl ?? input.normalActors.origin,
        );
  const privateValues = new Set(
    [...(input.privateValues ?? []), ...(normalActors?.privateValues ?? [])].filter(
      (value) => value !== "",
    ),
  );
  const safePrivateError = (error: Error) => {
    if (privateValues.size === 0) {
      return error;
    }
    let detail = error.message;
    for (const value of [...privateValues].toSorted((left, right) => right.length - left.length)) {
      detail = detail.replaceAll(value, "[REDACTED]");
    }
    detail = sanitizeValidationDiagnosticText(detail);
    return detail === error.message ? error : new Error(detail);
  };
  const runCommand = async (commandInput: Parameters<RuntimeTransport["runCommand"]>[0]) => {
    try {
      return await input.provider.runCommand(commandInput);
    } catch (error) {
      throw safePrivateError(
        error instanceof Error ? error : new Error("normal_actor_runtime_failed"),
      );
    }
  };
  const restore = async () => {
    try {
      // Remove installer files left by an older consumer before reusing its app Sandbox.
      await input.provider.fs.rm(`${input.binding.stateDirectory}/state.json`, {
        force: true,
        signal: input.signal,
      });
      await input.provider.fs.mkdir(input.binding.stateDirectory, {
        recursive: true,
        signal: input.signal,
      });
      await input.provider.writeFiles(
        Object.entries(files).flatMap(([name, content]) =>
          name === "environment.json" ||
          name === "identities.json" ||
          name.endsWith(".storage.json")
            ? [{ content, mode: 0o600, path: `${input.binding.stateDirectory}/${name}` }]
            : [],
        ),
        { signal: input.signal },
      );
      if (normalActors) {
        for (const directory of new Set(
          normalActors.files.map((file) => file.path.slice(0, file.path.lastIndexOf("/"))),
        )) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- Create private parent directories before writing captured files.
          await input.provider.fs.mkdir(directory, { recursive: true, signal: input.signal });
        }
        await input.provider.writeFiles(normalActors.files, { signal: input.signal });
      }
    } catch (error) {
      throw safePrivateError(
        error instanceof Error ? error : new Error("normal_actor_runtime_failed"),
      );
    }
  };
  await restore();
  const proof = {
    ...hostedRuntimeProofSchema.parse(await input.observeInstallation(files)),
    appId: input.appId,
    environment: "preview" as const,
  };
  // Resolve mise inside the Sandbox environment, not the SDK launcher's PATH.
  const described = await runCommand({
    args: ["mise", "run", "app:describe", input.appId],
    cmd: "/usr/bin/env",
    cwd: input.root,
    signal: input.signal,
  });
  if (described.exitCode !== 0) {
    throw new HostedRuntimeProviderError("resource_mismatch");
  }
  const description = appDescriptionSchema.parse(
    JSON.parse(await described.stdout({ signal: input.signal })),
  );
  if (
    description.app.id !== input.appId ||
    description.backend.kind !== "generated-postgres" ||
    description.backend.release.id !== proof.releaseId ||
    description.backend.release.artifactHash.replace(/^sha256:/u, "") !== proof.artifactHash
  ) {
    throw new HostedRuntimeProviderError("resource_mismatch");
  }
  const secretValues = new Set(privateValues);
  const jsonSchema = z.json();
  const collect = (value: z.infer<typeof jsonSchema>, key = "") => {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The recursive value is already parsed by z.json at its protected file boundary.
    if (typeof value === "string") {
      if (value !== "" && /secret|password|token|database_url|clusterUrl|^value$/iu.test(key)) {
        secretValues.add(value);
      }
      if (/^postgres(?:ql)?:\/\//u.test(value)) {
        secretValues.add(value);
        const password = decodeURIComponent(new URL(value).password);
        if (password !== "") {
          secretValues.add(password);
        }
      }
    } else if (Array.isArray(value)) {
      for (const child of value) {
        collect(child, key);
      }
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON permits only its parsed object/array/scalar alternatives.
    } else if (value !== null && typeof value === "object") {
      for (const [name, child] of Object.entries(value)) {
        collect(child, name);
      }
    }
  };
  for (const content of Object.values(files)) {
    collect(jsonSchema.parse(JSON.parse(content)));
  }
  const secrets = [...secretValues].toSorted((left, right) => right.length - left.length);
  const carrySize = secrets[0]?.length ?? 1;
  const redact = (content: string) => {
    let safe = sanitizeValidationDiagnosticText(content).replaceAll(
      /postgres(?:ql)?:\/\/[^\s"'<>]+/giu,
      "[DATABASE URL REDACTED]",
    );
    for (const value of secrets) {
      safe = safe.replaceAll(value, "[REDACTED]");
    }
    return safe;
  };
  const resolveTaskCommand = async (
    continuation: Pick<
      Parameters<PreparedRuntimeExecution["runTask"]>[0],
      "commandId" | "commandCheckpoint" | "allowDispatch"
    >,
    commandInput: Parameters<RuntimeTransport["runCommand"]>[0],
  ) => {
    const { commandId, commandCheckpoint, allowDispatch } = continuation;
    if (commandId === undefined && allowDispatch === false) {
      throw new HostedOperatorError("reconciliation_required");
    }
    let command: RuntimeCommand;
    if (commandId === undefined) {
      command = await runCommand(commandInput);
    } else {
      if (input.resumeCommand === undefined) {
        throw new HostedOperatorError("reconciliation_required");
      }
      command = await input.resumeCommand(commandId);
    }
    if (commandCheckpoint !== undefined && commandId === undefined) {
      if (command.cmdId === undefined) {
        throw new HostedOperatorError("reconciliation_required");
      }
      await commandCheckpoint(command.cmdId);
    }
    return command;
  };
  const withPrivateTaskErrors =
    (operation: PreparedRuntimeExecution["runTask"]): PreparedRuntimeExecution["runTask"] =>
    async (taskInput) => {
      try {
        return await operation(taskInput);
      } catch (error) {
        throw safePrivateError(
          error instanceof Error ? error : new Error("normal_actor_runtime_failed"),
        );
      }
    };
  return {
    ...((input.browserTestBaseUrl ?? input.normalActors?.origin) === undefined
      ? {}
      : { browserTestBaseUrl: input.browserTestBaseUrl ?? input.normalActors?.origin }),
    environmentPath,
    installationProof: {
      ...proof,
      branch: input.binding.branch,
      observation: "database-verification",
      observedAt: new Date().toISOString(),
    },
    async prepareAuthenticatedOrigin(origin) {
      if (input.normalActors) {
        if (origin !== input.normalActors.origin) {
          throw new Error("normal_actor_browser_origin_mismatch");
        }
        await restore();
        return;
      }
      files = runtimeFilesForOrigin(files, origin);
      await input.binding.persistFiles(files);
      await restore();
    },
    runTask: withPrivateTaskErrors(
      async ({
        task,
        shard,
        environment,
        onChunk,
        signal,
        commandId,
        commandCheckpoint,
        allowDispatch,
      }) => {
        const command = await resolveTaskCommand(
          { commandId, commandCheckpoint, allowDispatch },
          {
            args: [
              "mise",
              "run",
              "app:runtime",
              "run",
              input.appId,
              task,
              ...(shard !== undefined && shard !== "" ? [shard] : []),
            ],
            cmd: "/usr/bin/env",
            cwd: input.root,
            detached: true,
            env: {
              ...Object.fromEntries(
                Object.entries(environment ?? {}).filter(
                  (entry): entry is [string, string] => entry[1] !== undefined,
                ),
              ),
              APP_RUNTIME_STATE_DIR: input.binding.stateDirectory,
              ...(task === "test-e2e" && normalActors
                ? {
                    APP_TEST_BASE_URL: normalActors.origin,
                    APP_TEST_IDENTITIES_FILE: normalActors.identitiesPath,
                  }
                : {}),
            },
            signal: signal ?? input.signal,
          },
        );
        let stdout = "";
        let stderr = "";
        const pending = { stderr: "", stdout: "" };
        const emit = async (channel: "stdout" | "stderr", raw: string) => {
          const content = redact(raw);
          if (channel === "stdout") {
            stdout = (stdout + content).slice(-8000);
          } else {
            stderr = (stderr + content).slice(-8000);
          }
          await onChunk?.(channel, content);
        };
        const logs = command.logs({ signal: signal ?? input.signal });
        try {
          for await (const chunk of logs) {
            const raw = pending[chunk.stream] + chunk.data;
            let boundary = Math.max(0, raw.length - carrySize);
            for (const value of secretValues) {
              const start = raw.lastIndexOf(value, boundary);
              if (start !== -1 && start < boundary && start + value.length > boundary) {
                boundary = start;
              }
            }
            pending[chunk.stream] = raw.slice(boundary);
            // oxlint-disable-next-line eslint/no-await-in-loop -- Await durable writes to apply log backpressure.
            if (boundary > 0) {
              await emit(chunk.stream, raw.slice(0, boundary));
            }
          }
          if (pending.stdout !== "") {
            await emit("stdout", pending.stdout);
          }
          if (pending.stderr !== "") {
            await emit("stderr", pending.stderr);
          }
          const result = await command.wait({ signal: signal ?? input.signal });
          return { exitCode: result.exitCode, stderr, stdout };
        } catch (error) {
          await command.kill("SIGTERM", { abortSignal: AbortSignal.timeout(20_000) });
          throw safePrivateError(
            error instanceof Error ? error : new Error("normal_actor_runtime_failed"),
          );
        } finally {
          logs.close();
        }
      },
    ),
    stateDirectory: input.binding.stateDirectory,
  };
};
