import type { Sandbox } from "@vercel/sandbox";
import { z } from "zod";

import { readHostedRuntimeExecutionBinding } from "../provisioning/hosted-runtime-deployment";
import { HostedRuntimeProviderError } from "../provisioning/hosted-runtime-provider";
import type { PrivateRuntimeFiles } from "../provisioning/hosted-runtime-service";
import { hostedRuntimeProofSchema } from "../provisioning/hosted-runtime-journal";
import { appDescriptionSchema } from "../repository/app-description";
import { assertHostedSandboxCommandAuthority } from "../sandbox/deployment-execution-lease";
import { getVercelPreviewProvider } from "../sandbox/vercel-preview-provider";
import { sanitizeValidationDiagnosticText } from "../repository/validation-output-sanitize";
import { preparedRuntimeSelections } from "./prepared-runtime-selection";
import type { PreparedRuntimeSelection } from "./prepared-runtime-selection";

interface RuntimeCommand {
  exitCode: number | null;
  stdout: (options?: { signal?: AbortSignal }) => Promise<string>;
  logs: (options?: {
    signal?: AbortSignal;
  }) => AsyncIterable<{ stream: "stdout" | "stderr"; data: string }> & { close: () => void };
  wait: (options?: { signal?: AbortSignal }) => Promise<{ exitCode: number }>;
  kill: (signal: "SIGTERM", options?: { abortSignal?: AbortSignal }) => Promise<void>;
}
export type RuntimeTransport = Pick<Sandbox, "writeFiles"> & {
  fs: Pick<Sandbox["fs"], "mkdir">;
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
    shard?: string;
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
  root: string;
  binding: NonNullable<Awaited<ReturnType<typeof readHostedRuntimeExecutionBinding>>>;
  provider: RuntimeTransport;
  signal?: AbortSignal;
}): Promise<PreparedRuntimeExecution> => {
  const environmentPath = `${input.binding.stateDirectory}/environment.json`;
  let files: PrivateRuntimeFiles = {
    ...input.binding.files,
    "environment.json": JSON.stringify({
      ...input.binding.environment,
      APP_RUNTIME_STATE_DIR: input.binding.stateDirectory,
    }),
  };
  const restore = async () => {
    await input.provider.fs.mkdir(input.binding.stateDirectory, {
      recursive: true,
      signal: input.signal,
    });
    await input.provider.writeFiles(
      Object.entries(files).map(([name, content]) => ({
        content,
        mode: 0o600,
        path: `${input.binding.stateDirectory}/${name}`,
      })),
      { signal: input.signal },
    );
  };
  await restore();
  const privatePlan = z
    .object({
      plan: z.object({
        appId: z.literal(input.appId),
        environment: z.literal("preview"),
        roles: z.array(z.string()),
        runtimeId: z.string(),
      }),
    })
    .parse(JSON.parse(files["state.json"] ?? "null")).plan;
  const verification = await input.provider.runCommand({
    args: ["run", "app:runtime", "verify", input.appId, "preview"],
    cmd: "mise",
    cwd: input.root,
    env: {
      APP_RUNTIME_ID: privatePlan.runtimeId,
      APP_RUNTIME_ROLES: privatePlan.roles.join(","),
      APP_RUNTIME_STATE_DIR: input.binding.stateDirectory,
    },
    signal: input.signal,
  });
  if (verification.exitCode !== 0) {
    throw new HostedRuntimeProviderError("resource_mismatch");
  }
  const verificationOutput = await verification.stdout({ signal: input.signal });
  const proof = z
    .object({
      ...hostedRuntimeProofSchema.shape,
      appId: z.literal(input.appId),
      environment: z.literal("preview"),
    })
    .parse(JSON.parse(verificationOutput.trim().split("\n").at(-1) ?? "null"));
  const described = await input.provider.runCommand({
    args: ["run", "app:describe", input.appId],
    cmd: "mise",
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
  const secretValues = new Set<string>();
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
  return {
    environmentPath,
    installationProof: {
      ...proof,
      branch: input.binding.branch,
      observation: "database-verification",
      observedAt: new Date().toISOString(),
    },
    async prepareAuthenticatedOrigin(origin) {
      files = runtimeFilesForOrigin(files, origin);
      await input.binding.persistFiles(files);
      await restore();
    },
    async runTask({ task, shard, onChunk, signal }) {
      const command = await input.provider.runCommand({
        args: [
          "run",
          "app:runtime",
          "run",
          input.appId,
          task,
          ...(shard !== undefined && shard !== "" ? [shard] : []),
        ],
        cmd: "mise",
        cwd: input.root,
        detached: true,
        env: { APP_RUNTIME_STATE_DIR: input.binding.stateDirectory },
        signal: signal ?? input.signal,
      });
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
        throw error;
      } finally {
        logs.close();
      }
    },
    stateDirectory: input.binding.stateDirectory,
  };
};

export interface PreparedRuntimeExecutionDependencies {
  readBinding: typeof readHostedRuntimeExecutionBinding;
  assertAuthority: typeof assertHostedSandboxCommandAuthority;
  getProvider: (id: string, signal?: AbortSignal) => Promise<RuntimeTransport>;
}
const executionDependencies: PreparedRuntimeExecutionDependencies = {
  assertAuthority: assertHostedSandboxCommandAuthority,
  getProvider: getVercelPreviewProvider,
  readBinding: readHostedRuntimeExecutionBinding,
};

export const resolvePreparedRuntimeExecution = async (
  input: PreparedRuntimeExecutionContext,
  selectionInput?: PreparedRuntimeSelection | null,
  dependencies = executionDependencies,
): Promise<PreparedRuntimeExecution | null> => {
  let selection = selectionInput;
  if (selection === undefined) {
    const selections = preparedRuntimeSelections.get();
    selection = Object.hasOwn(selections, input.appId) ? selections[input.appId] : null;
  }
  const sourceRef =
    "githubSource" in input.state ? input.state.githubSource?.resolvedRef : undefined;
  const branch =
    selection?.branch ??
    (sourceRef !== undefined && sourceRef.startsWith("refs/heads/")
      ? sourceRef.slice("refs/heads/".length)
      : undefined);
  if (branch === undefined || branch === "") {
    return null;
  }
  if (selection && (selection.appId !== input.appId || selection.sessionId !== input.sessionId)) {
    throw new HostedRuntimeProviderError("authorization_required");
  }
  const binding = await dependencies.readBinding({
    appId: input.appId,
    branch,
    optionalProject: !selection,
    sessionAuth: input.sessionAuth,
    sessionId: input.sessionId,
  });
  if (!binding) {
    if (selection) {
      throw new HostedRuntimeProviderError("connection_required");
    }
    return null;
  }
  if (selection && selection.projectId !== binding.projectId) {
    throw new HostedRuntimeProviderError("resource_mismatch");
  }
  await dependencies.assertAuthority({ sessionId: input.sessionId });
  const provider = await dependencies.getProvider(input.sandboxId, input.signal);
  return await restorePreparedRuntimeExecution({
    appId: input.appId,
    binding,
    provider,
    root: input.root,
    signal: input.signal,
  });
};
