/* oxlint-disable eslint/sort-keys, eslint/no-await-in-loop, eslint/complexity, sonarjs/cognitive-complexity, sonarjs/expression-complexity -- Rust context serialization order and per-frame authority/checkpoint relay order are protocol contracts. */
import { createHash } from "node:crypto";
import path from "node:path";

import { Sandbox } from "@vercel/sandbox";
import type { Command } from "@vercel/sandbox";
import { getVercelOidcToken } from "@vercel/oidc";
import { z } from "zod";

import { HostedOperatorError, operatorPlanDigest } from "./hosted-operator-contract";
import type { HostedOperatorPlan, WorkerEffectCheckpointFrame } from "./hosted-operator-contract";
import type {
  HostedOperatorWorkerEffectContext,
  RecordWorkerCheckpoint,
} from "./hosted-operator-service";

const MAX_PROTOCOL_FRAME_BYTES = 1024 * 1024;
const SPOOL_ROOT = "/vercel/sandbox/protected-installer";
const INITIAL_SANDBOX_TIMEOUT_MS = 15 * 60_000;
const EXTEND_SANDBOX_TIMEOUT_MS = 5 * 60_000;
const SANDBOX_RENEWAL_INTERVAL_MS = 4 * 60_000;
const AUTHORITY_REPLY_TIMEOUT_MS = 120_000;

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const workerRunIdSchema = z.uuid();
const resourceSchema = z
  .strictObject({
    database: z.string().min(1),
    migratorRole: z.string().min(1),
    resourceId: z.string().min(1),
    runtimeRole: z.string().min(1),
  })
  .refine((resource) => resource.migratorRole !== resource.runtimeRole);

export interface ProtectedInstallerWorkerDescriptor {
  executablePath: string;
  id: string;
  sha256: string;
  subcommand: "protected-install" | "protected-materialize";
}

export interface HostedOperatorSandboxConfiguration {
  /** Project and team IDs are deployment-owned values used to obtain project OIDC. */
  projectId: string;
  teamId: string;
  /** Immutable control image and worker catalog are operator deployment configuration. */
  image: string;
  workers: Readonly<Record<string, ProtectedInstallerWorkerDescriptor>>;
}

export interface ProtectedInstallContextWire {
  version: 1;
  operation: {
    operation_id: string;
    approval_digest: string;
    fence_generation: number;
  };
  app_id: string;
  resource: {
    resource_id: string;
    environment: "preview";
    hostname: string;
    port: 5432;
    database: string;
    schema: "public";
    migrator_role: string;
    runtime_role: string;
    provider_project_id: string;
    provider_branch_id: string;
  };
  release: { id: string; sha256: string };
  installer: { id: string; sha256: string };
  tenant_targets: string[];
}

export interface HostedOperatorSandboxWorkerInput extends HostedOperatorWorkerEffectContext {
  database: "appDatabase" | "authDatabase";
  directDatabaseUrl: string;
  signal?: AbortSignal;
}

type SandboxFileSystem = Pick<Sandbox["fs"], "lstat" | "mkdir" | "readFile" | "rm">;
type OperatorSandbox = Pick<
  Sandbox,
  "delete" | "extendTimeout" | "readFileToBuffer" | "runCommand" | "writeFiles"
> & { fs: SandboxFileSystem };
interface SandboxCreateOptions {
  env: Record<string, string>;
  image: string;
  networkPolicy: "allow-all";
  persistent: false;
  ports: [];
  projectId: string;
  signal: AbortSignal;
  teamId: string;
  timeout: number;
}
type CreateSandbox = (options: SandboxCreateOptions) => Promise<OperatorSandbox>;

const markerSchema = z.strictObject({
  version: z.literal(1),
  run_id: z.string().min(1),
  frame_id: z.number().int().nonnegative(),
});
const authorityNoticeSchema = z.strictObject({
  kind: z.literal("protected_installer_frame_ready"),
  version: z.literal(1),
  run_id: workerRunIdSchema,
  frame_id: z.number().int().positive(),
});
const lifecycleNoticeSchema = z.strictObject({
  kind: z.literal("protected_installer_lifecycle_ready"),
  version: z.literal(1),
  run_id: workerRunIdSchema,
  frame_id: z.number().int().positive(),
});
const lifecycleFactSchema = z.strictObject({
  version: z.literal(1),
  run_id: workerRunIdSchema,
  kind: z.enum(["worker_started", "worker_succeeded", "worker_failed"]),
  failure_code: z
    .enum([
      "startup_rejected",
      "authority_denied",
      "effect_failed",
      "readback_unknown",
      "protocol_failure",
      "cancelled",
      "timeout",
    ])
    .optional(),
});
const authorizationRequestSchema = z.strictObject({
  kind: z.literal("authorize_effect"),
  version: z.literal(1),
  operation_id: z.uuid(),
  approval_digest: digestSchema,
  context_digest: digestSchema,
  fence_generation: z.number().int().positive(),
  sequence: z.number().int().positive(),
  effect_id: z.string().min(1),
  app_id: z.string().min(1),
  resource_id: z.string().min(1),
  release_id: z.string().min(1),
  installer_id: z.string().min(1),
  installer_sha256: digestSchema,
  tenant_id: z.string().min(1).nullable(),
});
const checkpointRequestSchema = z.strictObject({
  kind: z.literal("checkpoint_effect"),
  version: z.literal(1),
  operation_id: z.uuid(),
  context_digest: digestSchema,
  fence_generation: z.number().int().positive(),
  sequence: z.number().int().positive(),
  effect_id: z.string().min(1),
  resource_id: z.string().min(1),
  tenant_id: z.string().min(1).nullable(),
  receipt: z.strictObject({
    state: z.enum(["applied", "no_change", "unknown"]),
    readback_sha256: digestSchema.optional(),
  }),
});

type AuthorizationRequest = z.infer<typeof authorizationRequestSchema>;
type CheckpointRequest = z.infer<typeof checkpointRequestSchema>;
interface ActiveEffect {
  effectId: string;
  sequence: number;
  tenantId: string | null;
}

interface SpoolReadyMarker {
  version: 1;
  run_id: string;
  frame_id: number;
}

interface EffectAuthorizedReply {
  kind: "effect_authorized";
  version: 1;
  operation_id: string;
  context_digest: string;
  fence_generation: number;
  sequence: number;
  effect_id: string;
  allowed: true;
}

interface CheckpointRecordedReply {
  kind: "checkpoint_recorded";
  version: 1;
  operation_id: string;
  context_digest: string;
  fence_generation: number;
  sequence: number;
  effect_id: string;
  recorded: true;
}

type PrivateProtocolDocument =
  | string
  | ProtectedInstallContextWire
  | SpoolReadyMarker
  | EffectAuthorizedReply
  | CheckpointRecordedReply;

const unavailable = () => new HostedOperatorError("operator_unavailable");
const resourceMismatch = () => new HostedOperatorError("resource_mismatch");
const reconciliationRequired = () => new HostedOperatorError("reconciliation_required");

const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");

/**
 * Builds the same closed struct order that protected-installer serializes before hashing its
 * frozen context. Optional provider IDs are present for hosted Preview resources.
 */
export const buildProtectedInstallContext = (input: {
  plan: HostedOperatorPlan;
  operationRef: string;
  fenceGeneration: number;
  database: "appDatabase" | "authDatabase";
}): ProtectedInstallContextWire => {
  const resource = resourceSchema.parse(input.plan[input.database]);
  const tenantTargets = [...new Set(input.plan.access.map((target) => target.organizationId))];
  if (tenantTargets.length === 0) {
    throw resourceMismatch();
  }
  const planDigest = operatorPlanDigest(input.plan);
  digestSchema.parse(planDigest);
  digestSchema.parse(input.plan.release.sha256);
  digestSchema.parse(input.plan.installer.sha256);
  workerRunIdSchema.parse(input.operationRef);
  if (!Number.isSafeInteger(input.fenceGeneration) || input.fenceGeneration <= 0) {
    throw resourceMismatch();
  }

  return {
    version: 1,
    operation: {
      operation_id: input.operationRef,
      approval_digest: planDigest,
      fence_generation: input.fenceGeneration,
    },
    app_id: input.plan.selection.appId,
    resource: {
      resource_id: resource.resourceId,
      environment: "preview",
      hostname: input.plan.neon.endpoint,
      port: 5432,
      database: resource.database,
      schema: "public",
      migrator_role: resource.migratorRole,
      runtime_role: resource.runtimeRole,
      provider_project_id: input.plan.neon.projectId,
      provider_branch_id: input.plan.neon.branchId,
    },
    release: { id: input.plan.release.id, sha256: input.plan.release.sha256 },
    installer: { id: input.plan.installer.reference, sha256: input.plan.installer.sha256 },
    tenant_targets: tenantTargets,
  };
};

const canonicalContextBytes = (context: ProtectedInstallContextWire) =>
  Buffer.from(JSON.stringify(context), "utf-8");

const parseJsonBytes = (buffer: Buffer) => {
  if (buffer.length > MAX_PROTOCOL_FRAME_BYTES) {
    throw resourceMismatch();
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
    return parsed;
  } catch {
    throw resourceMismatch();
  }
};

const readSpoolJson = async (sandbox: OperatorSandbox, filePath: string, signal: AbortSignal) => {
  const stat = await sandbox.fs.lstat(filePath, { signal });
  if (!stat.isFile() || stat.size > MAX_PROTOCOL_FRAME_BYTES) {
    throw resourceMismatch();
  }
  const value = await sandbox.readFileToBuffer({ path: filePath }, { signal });
  if (value === null) {
    throw resourceMismatch();
  }
  return parseJsonBytes(value);
};

const readReadyMarker = async (
  sandbox: OperatorSandbox,
  pathValue: string,
  runId: string,
  frameId: number,
  signal: AbortSignal,
) => {
  const marker = markerSchema.parse(await readSpoolJson(sandbox, pathValue, signal));
  if (marker.run_id !== runId || marker.frame_id !== frameId) {
    throw resourceMismatch();
  }
};

const writePrivateJson = async (
  sandbox: OperatorSandbox,
  filePath: string,
  value: PrivateProtocolDocument,
  signal: AbortSignal,
) => {
  const content = Buffer.from(JSON.stringify(value), "utf-8");
  if (content.length > MAX_PROTOCOL_FRAME_BYTES) {
    throw resourceMismatch();
  }
  await sandbox.writeFiles([{ content, mode: 0o600, path: filePath }], { signal });
};

const verifyWorkerPin = async (
  sandbox: OperatorSandbox,
  worker: ProtectedInstallerWorkerDescriptor,
  signal: AbortSignal,
) => {
  const result = await sandbox.runCommand({
    args: ["--", worker.executablePath],
    cmd: "sha256sum",
    env: {},
    signal,
  });
  if (result.exitCode !== 0) {
    throw unavailable();
  }
  const stdout = await result.stdout({ signal });
  const match = /^(?<digest>[a-f0-9]{64})[ \t]+\*?[^\r\n]+\n?$/u.exec(stdout);
  if (match?.groups?.digest !== worker.sha256) {
    throw resourceMismatch();
  }
};

const requestMatchesContext = (
  request: AuthorizationRequest,
  context: ProtectedInstallContextWire,
  contextDigest: string,
) => {
  const identityMatches = [
    request.operation_id === context.operation.operation_id,
    request.approval_digest === context.operation.approval_digest,
    request.context_digest === contextDigest,
    request.fence_generation === context.operation.fence_generation,
    request.app_id === context.app_id,
    request.resource_id === context.resource.resource_id,
    request.release_id === context.release.id,
    request.installer_id === context.installer.id,
    request.installer_sha256 === context.installer.sha256,
  ].every(Boolean);
  return (
    identityMatches &&
    (request.tenant_id === null || context.tenant_targets.includes(request.tenant_id))
  );
};

const checkpointMatchesContext = (
  request: CheckpointRequest,
  context: ProtectedInstallContextWire,
  contextDigest: string,
  active: ActiveEffect,
) => {
  const identityMatches = [
    request.operation_id === context.operation.operation_id,
    request.context_digest === contextDigest,
    request.fence_generation === context.operation.fence_generation,
    request.resource_id === context.resource.resource_id,
    request.effect_id === active.effectId,
    request.sequence === active.sequence,
    request.tenant_id === active.tenantId,
  ].every(Boolean);
  return (
    identityMatches &&
    (request.tenant_id === null || context.tenant_targets.includes(request.tenant_id))
  );
};

const checkpointReceipt = (request: CheckpointRequest): WorkerEffectCheckpointFrame["receipt"] => {
  const receipt: WorkerEffectCheckpointFrame["receipt"] = { state: request.receipt.state };
  if (request.receipt.readback_sha256 !== undefined) {
    receipt.readbackSha256 = request.receipt.readback_sha256;
  }
  return receipt;
};

const checkpointFrame = (request: CheckpointRequest) => ({
  contextDigest: request.context_digest,
  effectId: request.effect_id,
  fenceGeneration: request.fence_generation,
  operationId: request.operation_id,
  receipt: checkpointReceipt(request),
  resourceId: request.resource_id,
  sequence: request.sequence,
  tenantId: request.tenant_id,
});

const atomicReply = async (
  sandbox: OperatorSandbox,
  spool: string,
  runId: string,
  frameId: number,
  reply: EffectAuthorizedReply | CheckpointRecordedReply,
  signal: AbortSignal,
) => {
  const responses = path.posix.join(spool, "responses");
  await writePrivateJson(sandbox, path.posix.join(responses, `${frameId}.json`), reply, signal);
  await writePrivateJson(
    sandbox,
    path.posix.join(responses, `${frameId}.ready`),
    { version: 1, run_id: runId, frame_id: frameId },
    signal,
  );
};

const parseNoticeLine = (line: string) => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw resourceMismatch();
  }
  const authority = authorityNoticeSchema.safeParse(value);
  if (authority.success) {
    return { channel: "authority" as const, notice: authority.data };
  }
  const lifecycle = lifecycleNoticeSchema.safeParse(value);
  if (lifecycle.success) {
    return { channel: "lifecycle" as const, notice: lifecycle.data };
  }
  throw resourceMismatch();
};

const runSandboxWorker = async (
  configuration: HostedOperatorSandboxConfiguration,
  createSandbox: CreateSandbox,
  input: HostedOperatorSandboxWorkerInput,
) => {
  const runId = workerRunIdSchema.parse(input.workerAttemptId);
  const worker = configuration.workers[input.plan.selection.appId];
  if (
    worker === undefined ||
    worker.id !== input.plan.installer.reference ||
    worker.sha256 !== input.plan.installer.sha256
  ) {
    throw resourceMismatch();
  }
  const context = buildProtectedInstallContext({
    database: input.database,
    fenceGeneration: input.fenceGeneration,
    operationRef: input.operationRef,
    plan: input.plan,
  });
  if (
    !input.plan.effects.some(
      (effect) => effect.id === input.effect.id && effect.kind === input.effect.kind,
    )
  ) {
    throw resourceMismatch();
  }
  if (input.directDatabaseUrl.length === 0 || /[\0\r\n]/u.test(input.directDatabaseUrl)) {
    throw resourceMismatch();
  }
  const contextBytes = canonicalContextBytes(context);
  if (contextBytes.length > MAX_PROTOCOL_FRAME_BYTES) {
    throw resourceMismatch();
  }
  const contextDigest = sha256(contextBytes);
  const recordCheckpoint = await input.bindWorkerContext({ contextDigest });
  const allowedResources = new Set([
    input.plan.appDatabase.resourceId,
    input.plan.authDatabase.resourceId,
  ]);
  const allowedTenants = new Set(context.tenant_targets);
  if (!allowedResources.has(context.resource.resource_id)) {
    throw resourceMismatch();
  }

  const leaseAbort = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([input.signal, leaseAbort.signal])
    : leaseAbort.signal;
  let sandbox: OperatorSandbox | undefined;
  let command: Command | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let renewal: Promise<void> | null = null;
  let started = false;
  let succeeded = false;
  let terminal = false;
  let unknownSeen = false;
  let activeEffect: ActiveEffect | null = null;
  let expectedAuthorityFrame = 1;
  let expectedEffectSequence = 1;
  let expectedLifecycleFrame = 1;
  let bufferedStdout = "";
  let operationError: HostedOperatorError | null = null;

  const failOnAbort = () => {
    if (signal.aborted) {
      throw unavailable();
    }
  };

  const requireSandbox = () => {
    if (sandbox === undefined) {
      throw unavailable();
    }
    return sandbox;
  };

  const processLifecycleNotice = async (frameId: number) => {
    if (frameId !== expectedLifecycleFrame || terminal) {
      throw resourceMismatch();
    }
    const directory = path.posix.join(SPOOL_ROOT, runId, "lifecycle");
    await readReadyMarker(
      requireSandbox(),
      path.posix.join(directory, `${frameId}.ready`),
      runId,
      frameId,
      signal,
    );
    const fact = lifecycleFactSchema.parse(
      await readSpoolJson(requireSandbox(), path.posix.join(directory, `${frameId}.json`), signal),
    );
    if (fact.run_id !== runId) {
      throw resourceMismatch();
    }
    expectedLifecycleFrame += 1;
    switch (fact.kind) {
      case "worker_started": {
        if (started || frameId !== 1 || fact.failure_code !== undefined || activeEffect !== null) {
          throw resourceMismatch();
        }
        started = true;
        return;
      }
      case "worker_failed": {
        if (fact.failure_code === undefined) {
          throw resourceMismatch();
        }
        terminal = true;
        if (unknownSeen || fact.failure_code === "readback_unknown") {
          throw reconciliationRequired();
        }
        throw unavailable();
      }
      case "worker_succeeded": {
        if (
          !started ||
          terminal ||
          activeEffect !== null ||
          fact.failure_code !== undefined ||
          unknownSeen
        ) {
          throw unknownSeen ? reconciliationRequired() : resourceMismatch();
        }
        await input.assertCurrent();
        terminal = true;
        succeeded = true;
        return;
      }
      default: {
        throw resourceMismatch();
      }
    }
  };

  const processAuthorityNotice = async (frameId: number) => {
    if (frameId !== expectedAuthorityFrame || terminal || !started) {
      throw resourceMismatch();
    }
    const directory = path.posix.join(SPOOL_ROOT, runId, "requests");
    await readReadyMarker(
      requireSandbox(),
      path.posix.join(directory, `${frameId}.ready`),
      runId,
      frameId,
      signal,
    );
    const requestValue = await readSpoolJson(
      requireSandbox(),
      path.posix.join(directory, `${frameId}.json`),
      signal,
    );
    const authorization = authorizationRequestSchema.safeParse(requestValue);
    if (authorization.success) {
      const request = authorization.data;
      if (
        unknownSeen ||
        activeEffect !== null ||
        request.sequence !== expectedEffectSequence ||
        request.effect_id !== input.effect.id ||
        !requestMatchesContext(request, context, contextDigest) ||
        !allowedResources.has(request.resource_id) ||
        (request.tenant_id !== null && !allowedTenants.has(request.tenant_id))
      ) {
        throw unknownSeen ? reconciliationRequired() : resourceMismatch();
      }
      await input.assertCurrent();
      await atomicReply(
        requireSandbox(),
        path.posix.join(SPOOL_ROOT, runId),
        runId,
        frameId,
        {
          kind: "effect_authorized",
          version: 1,
          operation_id: request.operation_id,
          context_digest: request.context_digest,
          fence_generation: request.fence_generation,
          sequence: request.sequence,
          effect_id: request.effect_id,
          allowed: true,
        },
        signal,
      );
      activeEffect = {
        effectId: request.effect_id,
        sequence: request.sequence,
        tenantId: request.tenant_id,
      };
      expectedAuthorityFrame += 1;
      return;
    }

    const checkpoint = checkpointRequestSchema.safeParse(requestValue);
    if (!checkpoint.success) {
      throw resourceMismatch();
    }
    const request = checkpoint.data;
    if (
      activeEffect === null ||
      request.sequence !== activeEffect?.sequence ||
      !checkpointMatchesContext(request, context, contextDigest, activeEffect) ||
      !allowedResources.has(request.resource_id) ||
      (request.tenant_id !== null && !allowedTenants.has(request.tenant_id)) ||
      (request.receipt.state === "unknown" && request.receipt.readback_sha256 !== undefined) ||
      (request.receipt.state !== "unknown" && request.receipt.readback_sha256 === undefined)
    ) {
      throw resourceMismatch();
    }
    await input.assertCurrent();
    const recordWorkerCheckpoint: RecordWorkerCheckpoint = recordCheckpoint;
    await recordWorkerCheckpoint(checkpointFrame(request));
    await atomicReply(
      requireSandbox(),
      path.posix.join(SPOOL_ROOT, runId),
      runId,
      frameId,
      {
        kind: "checkpoint_recorded",
        version: 1,
        operation_id: request.operation_id,
        context_digest: request.context_digest,
        fence_generation: request.fence_generation,
        sequence: request.sequence,
        effect_id: request.effect_id,
        recorded: true,
      },
      signal,
    );
    unknownSeen ||= request.receipt.state === "unknown";
    activeEffect = null;
    expectedAuthorityFrame += 1;
    expectedEffectSequence += 1;
  };

  const processStdoutLine = async (line: string) => {
    failOnAbort();
    const { channel, notice } = parseNoticeLine(line);
    if (notice.run_id !== runId) {
      throw resourceMismatch();
    }
    await (channel === "authority"
      ? processAuthorityNotice(notice.frame_id)
      : processLifecycleNotice(notice.frame_id));
  };

  const processOutputChunk = async (chunk: string) => {
    bufferedStdout += chunk;
    while (true) {
      const newline = bufferedStdout.indexOf("\n");
      if (newline === -1) {
        if (Buffer.byteLength(bufferedStdout, "utf-8") > MAX_PROTOCOL_FRAME_BYTES) {
          throw resourceMismatch();
        }
        return;
      }
      const line = bufferedStdout.slice(0, newline);
      bufferedStdout = bufferedStdout.slice(newline + 1);
      if (line.length === 0 || line.endsWith("\r")) {
        throw resourceMismatch();
      }
      await processStdoutLine(line);
    }
  };

  try {
    failOnAbort();
    await input.assertCurrent();
    const create = createSandbox;
    sandbox = await create({
      env: {},
      image: configuration.image,
      networkPolicy: "allow-all",
      persistent: false,
      ports: [],
      projectId: configuration.projectId,
      signal,
      teamId: configuration.teamId,
      timeout: INITIAL_SANDBOX_TIMEOUT_MS,
    });

    const ownedSandbox = sandbox;
    timer = setInterval(() => {
      if (renewal !== null) {
        return;
      }
      renewal = (async () => {
        try {
          await ownedSandbox.extendTimeout(EXTEND_SANDBOX_TIMEOUT_MS, {
            signal: AbortSignal.timeout(10_000),
          });
        } catch {
          leaseAbort.abort();
        } finally {
          renewal = null;
        }
      })();
    }, SANDBOX_RENEWAL_INTERVAL_MS);

    await verifyWorkerPin(sandbox, worker, signal);
    await input.assertCurrent();
    const spool = path.posix.join(SPOOL_ROOT, runId);
    const startup = path.posix.join(spool, "startup");
    await sandbox.fs.mkdir(startup, { recursive: true, signal });
    await writePrivateJson(sandbox, path.posix.join(startup, "context.json"), context, signal);
    await writePrivateJson(
      sandbox,
      path.posix.join(startup, "direct-database-url.json"),
      input.directDatabaseUrl,
      signal,
    );
    await writePrivateJson(
      sandbox,
      path.posix.join(startup, "ready.json"),
      { version: 1, run_id: runId, frame_id: 0 },
      signal,
    );

    const timeout = String(AUTHORITY_REPLY_TIMEOUT_MS);
    command = await sandbox.runCommand({
      args: [worker.subcommand, "--file-spool", spool, runId, timeout],
      cmd: worker.executablePath,
      cwd: SPOOL_ROOT,
      detached: true,
      env: {},
      signal,
    });
    const runningCommand = command;
    for await (const log of runningCommand.logs({ signal })) {
      if (log.stream === "stderr") {
        continue;
      }
      await processOutputChunk(log.data);
    }
    if (bufferedStdout.length !== 0) {
      throw resourceMismatch();
    }
    const finished = await runningCommand.wait({ signal });
    if (finished.exitCode !== 0 || !started || !succeeded || !terminal || unknownSeen) {
      throw unknownSeen ? reconciliationRequired() : unavailable();
    }
  } catch (error) {
    operationError = error instanceof HostedOperatorError ? error : unavailable();
    throw operationError;
  } finally {
    if (timer !== undefined) {
      clearInterval(timer);
    }
    if (renewal !== null) {
      await Promise.resolve(renewal);
    }
    if (command !== undefined && (!terminal || !succeeded || operationError !== null)) {
      try {
        await command.kill("SIGTERM", { abortSignal: AbortSignal.timeout(10_000) });
      } catch {
        // Sandbox deletion below is the final process termination boundary.
      }
    }
    if (sandbox !== undefined) {
      try {
        await sandbox.fs.rm(path.posix.join(SPOOL_ROOT, runId), {
          force: true,
          recursive: true,
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        operationError ??= unavailable();
      }
      try {
        await sandbox.delete({ deleteOrphanSnapshots: true, signal: AbortSignal.timeout(10_000) });
      } catch {
        operationError ??= unavailable();
      }
    }
  }
  if (operationError !== null) {
    throw operationError;
  }
};

/** Creates a source-free, project-OIDC Sandbox and runs only a catalog-pinned installer. */
export const createHostedOperatorSandboxLauncher = (
  configuration: HostedOperatorSandboxConfiguration,
  dependencies: { createSandbox?: CreateSandbox } = {},
) => {
  const createSandbox: CreateSandbox =
    dependencies.createSandbox ??
    (async (options) =>
      await Sandbox.create({
        ...options,
        token: await getVercelOidcToken({
          project: options.projectId,
          team: options.teamId,
        }),
      }));
  return {
    execute: async (input: HostedOperatorSandboxWorkerInput) => {
      await runSandboxWorker(configuration, createSandbox, input);
    },
  };
};
