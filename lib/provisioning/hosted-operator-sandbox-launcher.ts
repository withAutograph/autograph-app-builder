/* oxlint-disable sonarjs/max-union-size -- The closed worker transport enumerates all supported command families. */
import { isDeepStrictEqual } from "node:util";
import { verifyOperatorWorkerSourceCapture } from "./operator-worker-source-capture";
import type { OperatorWorkerSourceCapture } from "./operator-worker-source-capture";
import { centralHostCanonicalBytes } from "./central-integration-host-contract";
/* oxlint-disable eslint/sort-keys, eslint/no-await-in-loop, eslint/complexity, sonarjs/cognitive-complexity, sonarjs/expression-complexity -- Rust context serialization order and per-frame authority/checkpoint relay order are protocol contracts. */
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { Sandbox } from "@vercel/sandbox";
import type { Command } from "@vercel/sandbox";
import { getVercelOidcToken } from "@vercel/oidc";
import { z } from "zod";
import {
  observeRepositoryProductionPhase,
  reportRepositoryProductionFailure,
} from "./repository-production-diagnostic";

import {
  HostedOperatorError,
  hostedOperatorInstallationCustomerIds,
  operatorPlanDigest,
  selectHostedOperatorOwnedOrganizationSpec,
} from "./hosted-operator-contract";
import { hostedOperatorSandboxSourceOptions } from "./hosted-operator-sandbox-source";
import type { HostedOperatorSandboxSource } from "./hosted-operator-sandbox-source";
import type { HostedOperatorPlan, WorkerEffectCheckpointFrame } from "./hosted-operator-contract";
import type {
  HostedOperatorWorkerEffectContext,
  HostedOperatorEffectContext,
  RecordWorkerCheckpoint,
} from "./hosted-operator-service";

import {
  observeOperatorExecutionStage,
  projectAuthStartupDiagnostic,
  projectResourceReadbackDiagnostic,
} from "./hosted-operator-consent-diagnostic";
import type {
  HostedOperatorConsentDiagnosticSink,
  OperatorExecutionFailure,
} from "./hosted-operator-consent-diagnostic";

type LauncherExecution = Pick<
  OperatorExecutionFailure,
  | "stage"
  | "mode"
  | "commandExit"
  | "protocol"
  | "workerFailure"
  | "httpStatus"
  | "authStartup"
  | "resourceReadback"
>;

const MAX_PROTOCOL_FRAME_BYTES = 1024 * 1024;
const SPOOL_ROOT = "/vercel/sandbox/protected-installer";
const INITIAL_SANDBOX_TIMEOUT_MS = 15 * 60_000;
const EXTEND_SANDBOX_TIMEOUT_MS = 5 * 60_000;
const SANDBOX_RENEWAL_INTERVAL_MS = 4 * 60_000;
const AUTHORITY_REPLY_TIMEOUT_MS = 120_000;
const HC_APP_ID = "hc";
const VENDOR_APP_ID = "vendor";
const HC_LOOKUP_SHADOW_PREPARE = "lookup-shadow-prepare";
const HC_INSTALL_RELEASE_BUNDLE = "install-release-bundle";
const VENDOR_LOOKUP_SHADOW_BATCH = "lookup-shadow-batch";
const GENERATED_APP_SCOPE = "generated-app-release-install-v1";
const RESOURCES_SCOPE = "neon-resource-bootstrap-v1";
const RESOURCES_COMMAND = "neon-resource-bootstrap";
const RESOURCES_INSPECT_COMMAND = "neon-resource-inspect";
const RESOURCES_RETIRE_COMMAND = "neon-resource-retire";
const RESOURCES_RETIRED_INSPECT_COMMAND = "neon-resource-inspect-retired";
const ACCESS_SCOPE = "generated-app-access-v1";
const ACCESS_COMMAND = "protected-generated-app-access";
const ACCESS_INSPECT_COMMAND = "protected-generated-app-access-readback";
const AUTH_SCOPE = "auth-protected-schema-v1";
const AUTH_MEMBERSHIP_EFFECT = "auth-membership";
const AUTH_SIGNUP_POLICY_EFFECT = "auth-signup-policy";
const MEMBERSHIP_SCOPE = "auth-protected-membership-v1";
const MEMBERSHIP_COMMAND = "auth-protected-membership";
const SIGNUP_POLICY_COMMAND = "auth-protected-signup-policy";
const MEMBERSHIP_INSPECT_COMMAND = "auth-protected-membership-readback";
const HC_SCOPE = "hc-protected-install-v1";
const HC_COMMAND = "protected-install";
const VENDOR_COMMAND = "protected-materialize";
const GENERATED_COMMAND = "protected-generated-app-install";
const GENERATED_INSPECT_COMMAND = "protected-generated-app-install-readback";
const AUTH_COMMAND = "auth-protected-schema";
export const GENERATED_RELEASE_MEMBERS = [
  "app-artifact.json",
  "cue-to-sql-source-map.json",
  "data-operations.md",
  "data-operations.ts",
  "data-server.ts",
  "operation-manifest.json",
  "release-manifest.json",
  "runtime-coverage.json",
  "sql-bundle.sql",
  "sql-manifest.json",
  "transition-contract.json",
  "transition-plan.json",
] as const;
export type GeneratedAppReleaseFiles = {
  [Member in (typeof GENERATED_RELEASE_MEMBERS)[number]]: Buffer;
};
interface GeneratedAppReleaseMetadata {
  version: 1;
  app_id: string;
  release_id: string;
  release_manifest_sha256: string;
  app_artifact_sha256: string;
  sql_bundle_sha256: string;
}

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
const authResourceSchema = z.strictObject({
  version: z.literal(1),
  environment: z.literal("preview"),
  hostname: z.string(),
  port: z.literal(5432),
  database: z.string(),
  schema: z.literal("public"),
  runtimeRole: z.string(),
  migratorRole: z.string(),
  neon: z.strictObject({ projectId: z.string(), branchId: z.string() }),
});
const authPlanFrameSchema = z.strictObject({
  version: z.literal(1),
  proposal: z.literal("new-empty").optional(),
  resource: authResourceSchema,
  schemaPlan: z.looseObject({
    resource: authResourceSchema,
    planDigest: digestSchema,
    targetDigest: digestSchema,
  }),
});
const workerScopeSchema = z.enum([
  HC_SCOPE,
  "vendor-protected-materialize-v1",
  GENERATED_APP_SCOPE,
  AUTH_SCOPE,
  MEMBERSHIP_SCOPE,
  RESOURCES_SCOPE,
  ACCESS_SCOPE,
  "app-integration-bootstrap-v1",
  "central-integration-bootstrap-v1",
  "auth-app-access-v1",
]);
const workerSubcommandSchema = z.enum([
  HC_COMMAND,
  VENDOR_COMMAND,
  GENERATED_COMMAND,
  AUTH_COMMAND,
  MEMBERSHIP_COMMAND,
  SIGNUP_POLICY_COMMAND,
  MEMBERSHIP_INSPECT_COMMAND,
  RESOURCES_COMMAND,
  RESOURCES_INSPECT_COMMAND,
  RESOURCES_RETIRED_INSPECT_COMMAND,
  RESOURCES_RETIRE_COMMAND,
  ACCESS_COMMAND,
  ACCESS_INSPECT_COMMAND,
  GENERATED_INSPECT_COMMAND,
  "integration-control-schema",
  "integration-control-schema-readback",
  "integration-fence-app-authority",
  "integration-fence-app-authority-readback",
  "integration-service-memberships",
  "integration-service-memberships-readback",
  "integration-register-central-app",
  "integration-register-central-app-readback",
  "central-integration-schema",
  "central-integration-schema-readback",
  "central-integration-source-capture",
  "auth-protected-app-access",
  "auth-protected-app-access-readback",
]);

export interface ProtectedInstallerWorkerDescriptor {
  sourceCapture?: OperatorWorkerSourceCapture;
  executablePath: string;
  id: string;
  operationScope: z.infer<typeof workerScopeSchema>;
  sha256: string;
  subcommand: z.infer<typeof workerSubcommandSchema>;
}

export type HostedOperatorSandboxConfiguration = HostedOperatorSandboxSource & {
  /** Project and team IDs are deployment-owned values used to obtain project OIDC. */
  projectId: string;
  teamId: string;
  /** The immutable filesystem source and worker catalog are operator deployment configuration. */
  workers: Readonly<Record<string, ProtectedInstallerWorkerDescriptor>>;
  /** Shared Auth uses its own fixed catalog entry, separate from selected app workers. */
  authWorker?: ProtectedInstallerWorkerDescriptor;
  resourcesWorker?: ProtectedInstallerWorkerDescriptor;
  integrationResourcesWorker?: ProtectedInstallerWorkerDescriptor;
  integrationWorker?: ProtectedInstallerWorkerDescriptor;
  centralIntegrationWorker?: ProtectedInstallerWorkerDescriptor;
  accessWorker?: ProtectedInstallerWorkerDescriptor;
  membershipWorker?: ProtectedInstallerWorkerDescriptor;
};

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
    environment: "preview" | "production";
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

export interface ResourceBootstrapContextWire extends Omit<
  ProtectedInstallContextWire,
  "resource"
> {
  kind: "neon_resource_bootstrap";
  resource: Omit<ProtectedInstallContextWire["resource"], "schema"> & {
    scope: "app_database" | "auth_database" | "integration_control_database";
    maintenance_database: string;
    bootstrap_role: string;
    provider_endpoint_id: string;
    credentials_sha256: string;
  };
}
export interface CentralIntegrationContextWire extends ProtectedInstallContextWire {
  kind: "central_integration_schema";
  app_id: "integrations";
  resource: ProtectedInstallContextWire["resource"] & { provider_endpoint_id: string };
}
/** A fresh read-only protocol epoch; it carries no SQL connection or mutation grant. */
export interface CentralSourceCaptureContextWire extends Omit<
  CentralIntegrationContextWire,
  "kind"
> {
  kind: "central_source_capture";
  source: {
    repository_id: string;
    reviewed_source_sha: string;
    deployment_profile: "isolated-central-integrations-v1";
    services_manifest_sha256: string;
    build_receipt_sha256: string;
  };
}
type WorkerContext =
  | ProtectedInstallContextWire
  | ResourceBootstrapContextWire
  | CentralIntegrationContextWire
  | CentralSourceCaptureContextWire;

interface PrivateSandboxWorkerInput {
  database: "appDatabase" | "authDatabase";
  directDatabaseUrl: string;
  /** Prepared by the trusted credential closure; checkpoint must acknowledge before allocation. */
  resourceCredentials?: {
    bytes: Buffer;
    sha256: string;
    privateState: Parameters<HostedOperatorWorkerEffectContext["checkpoint"]>[0];
  };
  /** Private compiler-checked release resolved by the operator from plan.release.artifactRef. */
  generatedRelease?: { artifactRef: string; files: GeneratedAppReleaseFiles };
  /** Private reviewed Auth plan resolved from plan.authSchema.artifactRef. */
  authSchemaPlan?: { artifactRef: string; content: Buffer };
  membershipProof?: { proof?: string; oidcToken: string; organizationId?: string };
  accessConnections?: {
    appMigrator: string;
    appRuntime: string;
    authMigrator: string;
    authRuntime: string;
  };
  signal?: AbortSignal;
}

export interface HostedOperatorSandboxWorkerInput
  extends HostedOperatorWorkerEffectContext, PrivateSandboxWorkerInput {
  readbackOnly?: false;
}
export interface HostedOperatorSandboxReadbackInput
  extends HostedOperatorEffectContext, PrivateSandboxWorkerInput {
  readbackOnly: true;
}
type SandboxWorkerInput = HostedOperatorSandboxWorkerInput | HostedOperatorSandboxReadbackInput;
const accessReadbackSchema = z.strictObject({
  version: z.literal(1),
  operation_id: z.uuid(),
  context_digest: digestSchema,
  fence_generation: z.number().int().positive(),
  status: z.enum(["absent", "applied", "incomplete", "retryable"]),
  readback_sha256: digestSchema,
});

const removalReadbackSchema = z.strictObject({
  version: z.literal(1),
  operation_id: z.uuid(),
  context_digest: digestSchema,
  fence_generation: z.number().int().positive(),
  status: z.enum(["applied", "not-applied", "unknown"]),
  receipt: z
    .strictObject({
      operationRef: z.uuid(),
      active: z.literal(false),
      principalGeneration: z.number().int().positive(),
      priorGeneration: z.number().int().positive(),
      stoppedBindingsSha256: digestSchema,
    })
    .optional(),
  readback_sha256: digestSchema.optional(),
});
const resourceReadbackSchema = z
  .strictObject({
    version: z.literal(1),
    operation_id: z.uuid(),
    context_digest: digestSchema,
    fence_generation: z.number().int().positive(),
    resource_id: z.string().min(1),
    scope: z.enum(["app_database", "auth_database", "integration_control_database"]),
    status: z.enum(["applied", "absent", "unknown", "retryable"]),
    inspectionFailure: z.unknown().optional(),
    readback_sha256: digestSchema.optional(),
    databaseAbsent: z.boolean().optional(),
    retainedRoles: z
      .array(
        z.strictObject({
          name: z.string().min(1),
          globalAuthority: z.boolean(),
          reason: z.enum(["no_exclusive_owner_proof", "remaining_dependencies"]),
        }),
      )
      .optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.status === "unknown") !== (value.readback_sha256 === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "Only independently known resource facts have a readback digest.",
      });
    }
  });

type SandboxFileSystem = Pick<Sandbox["fs"], "lstat" | "mkdir" | "readFile" | "rm">;
type OperatorSandbox = Pick<
  Sandbox,
  "delete" | "extendTimeout" | "readFileToBuffer" | "runCommand" | "writeFiles"
> & { fs: SandboxFileSystem };
type SandboxCreateOptions = HostedOperatorSandboxSource & {
  env: Record<string, string>;
  networkPolicy: "allow-all";
  persistent: false;
  ports: [];
  projectId: string;
  signal: AbortSignal;
  teamId: string;
  timeout: number;
};
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
  auth_startup: z.unknown().optional(),
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
const fenceRequestSchema = authorizationRequestSchema
  .omit({ effect_id: true, sequence: true })
  .extend({
    kind: z.literal("check_fence"),
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

interface FenceCurrentReply {
  kind: "fence_current";
  version: 1;
  operation_id: string;
  context_digest: string;
  fence_generation: number;
  current: true;
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
  | WorkerContext
  | SpoolReadyMarker
  | EffectAuthorizedReply
  | FenceCurrentReply
  | CheckpointRecordedReply
  | GeneratedAppReleaseMetadata;

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
  subject?: "auth";
  purpose?: "install" | "access";
}): ProtectedInstallContextWire => {
  const resource = resourceSchema.parse(input.plan[input.database]);
  const auth = input.subject === "auth" ? input.plan.authSchema : undefined;
  if (input.subject === "auth" && (auth === undefined || input.database !== "authDatabase")) {
    throw resourceMismatch();
  }
  const appTenantTargets =
    input.purpose === "install"
      ? hostedOperatorInstallationCustomerIds(input.plan)
      : [...new Set(input.plan.access.map((target) => target.organizationId))];
  const tenantTargets = auth === undefined ? appTenantTargets : [];
  if (auth === undefined && tenantTargets.length === 0) {
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
    app_id: auth === undefined ? input.plan.selection.appId : "auth",
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
    release:
      auth === undefined
        ? { id: input.plan.release.id, sha256: input.plan.release.sha256 }
        : { id: auth.targetDigest, sha256: auth.planDigest },
    installer: {
      id: (auth?.installer ?? input.plan.installer).reference,
      sha256: (auth?.installer ?? input.plan.installer).sha256,
    },
    tenant_targets: tenantTargets,
  };
};

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

export const buildResourceBootstrapContext = (
  input: SandboxWorkerInput,
): ResourceBootstrapContextWire => {
  const { plan } = input;
  const { bootstrap } = plan;
  const installer = plan.resourcesInstaller;
  const credentials = input.resourceCredentials;
  const resource = resourceSchema.parse(plan[input.database]);
  if (
    !bootstrap ||
    !installer ||
    !credentials ||
    !["resources", "retire"].includes(input.effect.kind) ||
    (input.effect.kind === "retire" &&
      (plan.action !== "cleanup" || input.database !== "appDatabase")) ||
    input.effect.resourceId !== resource.resourceId ||
    !plan.effects.some(
      (effect) =>
        effect.id === input.effect.id &&
        effect.kind === input.effect.kind &&
        effect.resourceId === resource.resourceId,
    )
  ) {
    throw resourceMismatch();
  }
  const parsed = z
    .strictObject({
      migratorPassword: z
        .string()
        .min(32)
        .max(512)
        .refine((value) => !/[\0\r\n]/u.test(value)),
      runtimePassword: z
        .string()
        .min(32)
        .max(512)
        .refine((value) => !/[\0\r\n]/u.test(value)),
    })
    .safeParse(parseJsonBytes(credentials.bytes));
  if (
    !parsed.success ||
    !Buffer.from(JSON.stringify(parsed.data)).equals(credentials.bytes) ||
    sha256(credentials.bytes) !== credentials.sha256
  ) {
    throw resourceMismatch();
  }
  let url: URL;
  try {
    url = new URL(input.directDatabaseUrl);
  } catch {
    throw resourceMismatch();
  }
  if (
    url.protocol !== "postgresql:" ||
    url.hostname !== plan.neon.endpoint ||
    (url.port !== "" && url.port !== "5432") ||
    decodeURIComponent(url.username) !== bootstrap.role ||
    decodeURIComponent(url.pathname.slice(1)) !== bootstrap.maintenanceDatabase ||
    !url.password ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => !["sslmode", "channel_binding"].includes(key)) ||
    !["require", "verify-full"].includes(url.searchParams.get("sslmode") ?? "") ||
    url.hostname.includes("-pooler")
  ) {
    throw resourceMismatch();
  }
  workerRunIdSchema.parse(input.operationRef);
  if (!Number.isSafeInteger(input.fenceGeneration) || input.fenceGeneration <= 0) {
    throw resourceMismatch();
  }
  return {
    kind: "neon_resource_bootstrap",
    version: 1,
    operation: {
      operation_id: input.operationRef,
      approval_digest: operatorPlanDigest(plan),
      fence_generation: input.fenceGeneration,
    },
    app_id: input.database === "authDatabase" ? "auth" : plan.selection.appId,
    resource: {
      scope: input.database === "authDatabase" ? "auth_database" : "app_database",
      resource_id: resource.resourceId,
      environment: "preview",
      hostname: plan.neon.endpoint,
      port: 5432,
      database: resource.database,
      migrator_role: resource.migratorRole,
      runtime_role: resource.runtimeRole,
      maintenance_database: bootstrap.maintenanceDatabase,
      bootstrap_role: bootstrap.role,
      provider_project_id: plan.neon.projectId,
      provider_branch_id: plan.neon.branchId,
      provider_endpoint_id: bootstrap.endpointId,
      credentials_sha256: credentials.sha256,
    },
    release: { id: plan.release.id, sha256: plan.release.sha256 },
    installer: { id: installer.reference, sha256: installer.sha256 },
    tenant_targets: [],
  };
};

const canonicalContextBytes = (context: WorkerContext) =>
  "kind" in context &&
  (context.kind === "central_integration_schema" || context.kind === "central_source_capture")
    ? centralHostCanonicalBytes(z.json().parse(context))
    : Buffer.from(JSON.stringify(context), "utf-8");

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
  try {
    await verifyOperatorWorkerSourceCapture({
      worker,
      readFile: async (file) => await sandbox.fs.readFile(file, { signal }),
    });
  } catch {
    signal.throwIfAborted();
    throw resourceMismatch();
  }
};

const requestMatchesContext = (
  request: AuthorizationRequest | z.infer<typeof fenceRequestSchema>,
  context: WorkerContext,
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
  context: WorkerContext,
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

const requestMatchesWorkerScope = (
  effectId: string,
  tenantId: string | null,
  context: WorkerContext,
  worker: ProtectedInstallerWorkerDescriptor,
) => {
  if (worker.operationScope === "auth-app-access-v1") {
    return effectId === "auth-app-invitation" && tenantId === null;
  }
  if (worker.operationScope === RESOURCES_SCOPE) {
    return (
      [RESOURCES_COMMAND, RESOURCES_RETIRE_COMMAND].includes(worker.subcommand) &&
      "kind" in context &&
      context.kind === "neon_resource_bootstrap" &&
      tenantId === null &&
      ([RESOURCES_RETIRE_COMMAND, RESOURCES_RETIRED_INSPECT_COMMAND].includes(worker.subcommand)
        ? context.resource.scope === "app_database" && effectId === "resources:retire"
        : ["resources:roles", "resources:database", "resources:acl"].includes(effectId))
    );
  }
  if (worker.operationScope === "central-integration-bootstrap-v1") {
    return (
      "kind" in context &&
      context.kind === "central_integration_schema" &&
      context.app_id === "integrations" &&
      context.tenant_targets.length === 0 &&
      tenantId === null &&
      worker.subcommand === "central-integration-schema" &&
      effectId === "install-central-schema"
    );
  }
  if (worker.operationScope === "app-integration-bootstrap-v1") {
    const effects = {
      "integration-control-schema": "install-control-schema",
      "integration-service-memberships": "bind-service-memberships",
      "integration-register-central-app": "register-central-app",
      "integration-fence-app-authority": "fence-app-integration-authority",
    } as const;
    return (
      tenantId === null &&
      Object.entries(effects).some(
        ([command, effect]) => worker.subcommand === command && effectId === effect,
      )
    );
  }
  if (worker.operationScope === ACCESS_SCOPE) {
    return (
      worker.subcommand === ACCESS_COMMAND &&
      tenantId === null &&
      ["generated_app.grant_access", "generated_app.revoke_access"].includes(effectId)
    );
  }
  if (worker.operationScope === MEMBERSHIP_SCOPE) {
    return (
      [MEMBERSHIP_COMMAND, SIGNUP_POLICY_COMMAND].includes(worker.subcommand) &&
      context.app_id === "auth" &&
      context.tenant_targets.length === 0 &&
      tenantId === null &&
      ((worker.subcommand === MEMBERSHIP_COMMAND && effectId === AUTH_MEMBERSHIP_EFFECT) ||
        (worker.subcommand === SIGNUP_POLICY_COMMAND && effectId === AUTH_SIGNUP_POLICY_EFFECT))
    );
  }
  if (worker.operationScope === AUTH_SCOPE) {
    return (
      worker.subcommand === AUTH_COMMAND &&
      context.app_id === "auth" &&
      context.tenant_targets.length === 0 &&
      tenantId === null &&
      effectId === "auth:apply-schema-plan"
    );
  }
  if (worker.operationScope === GENERATED_APP_SCOPE) {
    if (worker.subcommand !== GENERATED_COMMAND) {
      return false;
    }
    const tenantEffects = new Set([
      "generated_app.prepare_schema_revision",
      "generated_app.validate_readiness",
      "generated_app.bind_runtime_scope",
    ]);
    const groupedEffects = new Set([
      "generated_app.install_bundle",
      "generated_app.activate_app_base",
      "generated_app.grant_runtime_capability",
    ]);
    return tenantEffects.has(effectId)
      ? tenantId !== null && context.tenant_targets.includes(tenantId)
      : groupedEffects.has(effectId) && tenantId === null;
  }
  if (worker.operationScope === HC_SCOPE) {
    if (context.app_id !== HC_APP_ID || worker.subcommand !== HC_COMMAND) {
      return false;
    }
    const match = /^hc:(?<operation>[a-z-]+):(?<tenant>[^:]+)(?::(?<suffix>[^:]+))?$/u.exec(
      effectId,
    );
    const operation = match?.groups?.operation;
    const tenant = match?.groups?.tenant;
    const suffix = match?.groups?.suffix;
    const allowedOperations = new Set([
      "prepare-schema",
      "validate-readiness",
      "activate-schema",
      "repair-schema",
      "ensure-mutation-replay",
      "verify-installed-release",
      "claim-legacy-schema-hash",
      HC_LOOKUP_SHADOW_PREPARE,
      "lookup-shadow-validate",
      "lookup-shadow-activate",
      HC_INSTALL_RELEASE_BUNDLE,
    ]);
    if (
      operation === undefined ||
      tenant === undefined ||
      !allowedOperations.has(operation) ||
      !context.tenant_targets.includes(tenant)
    ) {
      return false;
    }
    const validSuffix =
      (operation === HC_LOOKUP_SHADOW_PREPARE && suffix !== undefined && /^\d+$/u.test(suffix)) ||
      (operation === HC_INSTALL_RELEASE_BUNDLE && (suffix === "initial" || suffix === "final"));
    if (
      (operation === HC_LOOKUP_SHADOW_PREPARE || operation === HC_INSTALL_RELEASE_BUNDLE) !==
      (suffix !== undefined)
    ) {
      return false;
    }
    if (suffix !== undefined && !validSuffix) {
      return false;
    }
    const targetMayBeNull =
      operation === "ensure-mutation-replay" || operation === HC_INSTALL_RELEASE_BUNDLE;
    return tenantId === tenant || (targetMayBeNull && tenantId === null);
  }

  if (context.app_id !== VENDOR_APP_ID || worker.subcommand !== VENDOR_COMMAND) {
    return false;
  }
  const match = /^vendor:(?<tenant>[^/]+)\/(?<operation>[a-z-]+)(?::(?<suffix>[^:]+))?$/u.exec(
    effectId,
  );
  const tenant = match?.groups?.tenant;
  const operation = match?.groups?.operation;
  const suffix = match?.groups?.suffix;
  const allowedOperations = new Set([
    "legacy-seed-cleanup",
    "release-bundle-install",
    "prepare-release",
    "readiness",
    "activate-release",
    "trusted-replay-table",
    "lookup-shadow-schema-hash",
    VENDOR_LOOKUP_SHADOW_BATCH,
    "lookup-shadow-activate",
  ]);
  const validSuffix =
    operation === VENDOR_LOOKUP_SHADOW_BATCH && suffix !== undefined && /^\d+$/u.test(suffix);
  return (
    tenant !== undefined &&
    operation !== undefined &&
    allowedOperations.has(operation) &&
    (operation === VENDOR_LOOKUP_SHADOW_BATCH) === (suffix !== undefined) &&
    (suffix === undefined || validSuffix) &&
    context.tenant_targets.includes(tenant) &&
    tenantId === tenant
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
  reply: EffectAuthorizedReply | CheckpointRecordedReply | FenceCurrentReply,
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
  input: SandboxWorkerInput,
  execution: LauncherExecution,
) => {
  const assertCurrent =
    input.readbackOnly === true
      ? (input.assertCurrentObservation ?? input.assertCurrent)
      : input.assertCurrent;
  const runId =
    input.readbackOnly === true ? randomUUID() : workerRunIdSchema.parse(input.workerAttemptId);
  const resources = input.effect.kind === "resources" || input.effect.kind === "retire";
  const access = input.effect.kind === "access" || input.effect.kind === "revoke";
  const membership =
    input.effect.kind === AUTH_MEMBERSHIP_EFFECT || input.effect.kind === AUTH_SIGNUP_POLICY_EFFECT;
  const installReadback =
    input.readbackOnly === true &&
    input.effect.kind === "install" &&
    input.database === "appDatabase";
  if (input.readbackOnly === true && !access && !resources && !installReadback && !membership) {
    throw resourceMismatch();
  }
  const auth = !resources && !access && input.database === "authDatabase";
  let worker: ProtectedInstallerWorkerDescriptor | undefined =
    configuration.workers[input.plan.selection.appId];
  let installer: HostedOperatorPlan["resourcesInstaller"] = input.plan.installer;
  if (resources) {
    worker = configuration.resourcesWorker;
    installer = input.plan.resourcesInstaller;
  } else if (access) {
    worker = configuration.accessWorker;
  } else if (membership) {
    worker = configuration.membershipWorker;
    installer = worker === undefined ? undefined : { reference: worker.id, sha256: worker.sha256 };
  } else if (auth) {
    worker = configuration.authWorker;
    installer = input.plan.authSchema?.installer;
  }
  let resourceCommand: ProtectedInstallerWorkerDescriptor["subcommand"] = RESOURCES_COMMAND;
  if (input.effect.kind === "retire") {
    resourceCommand = RESOURCES_RETIRE_COMMAND;
  }
  if (input.readbackOnly === true) {
    resourceCommand =
      input.effect.kind === "retire"
        ? RESOURCES_RETIRED_INSPECT_COMMAND
        : RESOURCES_INSPECT_COMMAND;
  }
  if (worker !== undefined && resources) {
    worker = { ...worker, subcommand: resourceCommand };
  } else if (worker !== undefined && access) {
    worker = {
      ...worker,
      subcommand: input.readbackOnly === true ? ACCESS_INSPECT_COMMAND : ACCESS_COMMAND,
    };
  }
  if (worker !== undefined && membership && input.readbackOnly === true) {
    worker = { ...worker, subcommand: MEMBERSHIP_INSPECT_COMMAND };
  } else if (worker !== undefined && input.effect.kind === AUTH_SIGNUP_POLICY_EFFECT) {
    worker = { ...worker, subcommand: SIGNUP_POLICY_COMMAND };
  }
  if (worker !== undefined && installReadback) {
    worker = { ...worker, subcommand: GENERATED_INSPECT_COMMAND };
  }
  if (
    worker === undefined ||
    (resources &&
      (worker.operationScope !== RESOURCES_SCOPE ||
        worker.id !== RESOURCES_SCOPE ||
        worker.subcommand !== resourceCommand)) ||
    (!resources && worker.operationScope === RESOURCES_SCOPE) ||
    (access &&
      (worker.operationScope !== ACCESS_SCOPE ||
        input.database !== "appDatabase" ||
        worker.id !== "generated-app-protected-installer-v1")) ||
    (resources &&
      input.effect.kind === "retire" &&
      (input.plan.action !== "cleanup" || input.database !== "appDatabase")) ||
    installer === undefined ||
    !workerScopeSchema.safeParse(worker.operationScope).success ||
    !workerSubcommandSchema.safeParse(worker.subcommand).success ||
    (worker.operationScope === AUTH_SCOPE && !auth) ||
    (((auth && !membership) || worker.operationScope === GENERATED_APP_SCOPE) &&
      input.effect.kind !== "install") ||
    worker.id !== installer?.reference ||
    worker.sha256 !== installer.sha256 ||
    (!resources &&
      !access &&
      !auth &&
      !membership &&
      input.plan.installer.sourceCapture !== undefined &&
      !isDeepStrictEqual(input.plan.installer.sourceCapture, worker.sourceCapture)) ||
    (auth &&
      !membership &&
      (worker.operationScope !== AUTH_SCOPE ||
        worker.id !== "auth-protected-schema-v1" ||
        worker.subcommand !== AUTH_COMMAND)) ||
    (worker.operationScope === HC_SCOPE && worker.subcommand !== HC_COMMAND) ||
    (worker.operationScope === "vendor-protected-materialize-v1" &&
      worker.subcommand !== VENDOR_COMMAND) ||
    (worker.operationScope === GENERATED_APP_SCOPE &&
      ((worker.subcommand !== GENERATED_COMMAND &&
        !(installReadback && worker.subcommand === GENERATED_INSPECT_COMMAND)) ||
        input.database !== "appDatabase"))
  ) {
    throw resourceMismatch();
  }
  const contextInput: Parameters<typeof buildProtectedInstallContext>[0] = {
    database: input.database,
    fenceGeneration: input.fenceGeneration,
    operationRef: input.operationRef,
    plan: input.plan,
    purpose:
      input.effect.kind === "install" && input.database === "appDatabase" ? "install" : "access",
  };
  if (auth) {
    contextInput.subject = "auth";
  }
  const context = resources
    ? buildResourceBootstrapContext(input)
    : buildProtectedInstallContext(contextInput);
  if (membership) {
    const { authMembership } = input.plan;
    const membershipProof = input.membershipProof?.proof;
    const organizationSelection =
      input.membershipProof?.organizationId === undefined
        ? undefined
        : { organizationId: input.membershipProof.organizationId };
    const organization =
      authMembership === undefined
        ? undefined
        : selectHostedOperatorOwnedOrganizationSpec(authMembership, organizationSelection);
    const selectedOrganizationId =
      organization === undefined
        ? input.plan.authSignupPolicy?.organizationId
        : organization.organizationId;
    if (
      worker.operationScope !== MEMBERSHIP_SCOPE ||
      ![MEMBERSHIP_COMMAND, SIGNUP_POLICY_COMMAND, MEMBERSHIP_INSPECT_COMMAND].includes(
        worker.subcommand,
      ) ||
      worker.id !== "auth-owned-organization-v1" ||
      selectedOrganizationId === undefined ||
      (input.effect.kind === AUTH_MEMBERSHIP_EFFECT &&
        (authMembership === undefined || membershipProof === undefined)) ||
      (input.effect.kind === AUTH_SIGNUP_POLICY_EFFECT && input.plan.authSignupPolicy === undefined)
    ) {
      throw resourceMismatch();
    }
    let releaseSha256 = operatorPlanDigest(input.plan);
    if (input.effect.kind === AUTH_MEMBERSHIP_EFFECT) {
      if (organization === undefined || membershipProof === undefined) {
        throw resourceMismatch();
      }
      releaseSha256 = organization.identityProof.sha256;
      if (sha256(Buffer.from(membershipProof, "utf-8")) !== releaseSha256) {
        throw resourceMismatch();
      }
    }
    context.release = { id: operatorPlanDigest(input.plan), sha256: releaseSha256 };
    context.installer = { id: worker.id, sha256: worker.sha256 };
  }
  let generatedMetadata: GeneratedAppReleaseMetadata | undefined;
  let generatedFiles: { member: string; content: Buffer }[] = [];
  let authPlanBytes: Buffer | undefined;
  if (auth && !membership) {
    const artifact = input.authSchemaPlan;
    if (artifact === undefined || artifact.artifactRef !== input.plan.authSchema?.artifactRef) {
      throw resourceMismatch();
    }
    const parsed = authPlanFrameSchema.safeParse(parseJsonBytes(artifact.content));
    if (!parsed.success) {
      throw resourceMismatch();
    }
    const { resource, schemaPlan } = parsed.data;
    if (
      schemaPlan.planDigest !== context.release.sha256 ||
      schemaPlan.targetDigest !== context.release.id ||
      JSON.stringify(resource) !== JSON.stringify(schemaPlan.resource) ||
      resource.hostname !== context.resource.hostname ||
      resource.database !== context.resource.database ||
      resource.runtimeRole !== context.resource.runtime_role ||
      resource.migratorRole !== context.resource.migrator_role ||
      resource.neon.projectId !== context.resource.provider_project_id ||
      resource.neon.branchId !== context.resource.provider_branch_id
    ) {
      throw resourceMismatch();
    }
    authPlanBytes = Buffer.from(artifact.content);
  }
  if (
    worker.operationScope === GENERATED_APP_SCOPE ||
    access ||
    (resources && input.effect.kind === "retire")
  ) {
    const release = input.generatedRelease;
    if (
      release === undefined ||
      release.artifactRef !== input.plan.release.artifactRef ||
      Object.keys(release.files).length !== GENERATED_RELEASE_MEMBERS.length ||
      GENERATED_RELEASE_MEMBERS.some((member) => !Buffer.isBuffer(release.files[member]))
    ) {
      throw resourceMismatch();
    }
    const manifestDigest = sha256(release.files["release-manifest.json"]);
    if (manifestDigest !== context.release.sha256) {
      throw resourceMismatch();
    }
    generatedMetadata = {
      version: 1,
      app_id: context.app_id,
      release_id: context.release.id,
      release_manifest_sha256: manifestDigest,
      app_artifact_sha256: sha256(release.files["app-artifact.json"]),
      sql_bundle_sha256: sha256(release.files["sql-bundle.sql"]),
    };
    generatedFiles = GENERATED_RELEASE_MEMBERS.map((member) => ({
      member,
      content: Buffer.from(release.files[member]),
    }));
  }
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
  const resourceCredentialBytes =
    resources && input.resourceCredentials
      ? Buffer.from(input.resourceCredentials.bytes)
      : undefined;
  if (resources) {
    if (!input.resourceCredentials) {
      throw resourceMismatch();
    }
    if (input.readbackOnly !== true) {
      await input.checkpoint(input.resourceCredentials.privateState);
    }
  }
  const recordCheckpoint =
    input.readbackOnly === true ? undefined : await input.bindWorkerContext({ contextDigest });
  const allowedResources = new Set([
    input.plan.appDatabase.resourceId,
    input.plan.authDatabase.resourceId,
  ]);
  const allowedTenants = new Set(context.tenant_targets);
  if (!allowedResources.has(context.resource.resource_id)) {
    throw resourceMismatch();
  }

  // oxlint-disable-next-line eslint/no-use-before-define -- Both fixed entry points share the transport declared below.
  return await runPinnedFileSpoolTransport(
    configuration,
    createSandbox,
    {
      ...input,
      legacyPlan: input.plan,
      legacyEffect: input.effect,
      effectKind: input.effect.kind,
    },
    execution,
    {
      context,
      contextDigest,
      worker,
      runId,
      assertCurrent,
      allowedResources,
      allowedTenants,
      resourceCredentialBytes,
      recordCheckpoint,
      resources,
      access,
      membership,
      installReadback,
      generatedMetadata,
      generatedFiles,
      authPlanBytes,
    },
  );
};

type SharedSpoolInput = Pick<SandboxWorkerInput, "signal" | "readbackOnly" | "fenceGeneration"> & {
  directDatabaseUrl?: string;
  legacyPlan?: HostedOperatorPlan;
  legacyEffect?: SandboxWorkerInput["effect"];
  effectKind?: string;
  membershipProof?: PrivateSandboxWorkerInput["membershipProof"];
  accessConnections?: PrivateSandboxWorkerInput["accessConnections"];
  startupFiles?: Readonly<Record<string, Buffer>>;
  /** Only the closed repository Production wrapper can supply these fixed worker files. */
  repositoryProduction?: true;
};
interface SharedSpoolSetup {
  context: WorkerContext;
  contextDigest: string;
  worker: ProtectedInstallerWorkerDescriptor;
  runId: string;
  assertCurrent: () => Promise<void>;
  allowedResources: Set<string>;
  allowedTenants: Set<string>;
  resourceCredentialBytes?: Buffer;
  recordCheckpoint?: RecordWorkerCheckpoint;
  authorizeAppIntegrationRemoval?: () => Promise<void>;
  resources: boolean;
  access: boolean;
  membership: boolean;
  installReadback: boolean;
  authPlanBytes?: Buffer;
  generatedMetadata?: GeneratedAppReleaseMetadata;
  generatedFiles: readonly { member: string; content: Buffer }[];
}
const runPinnedFileSpoolTransport = async (
  configuration: HostedOperatorSandboxConfiguration,
  createSandbox: CreateSandbox,
  input: SharedSpoolInput,
  execution: LauncherExecution,
  setup: SharedSpoolSetup,
) => {
  const {
    context,
    contextDigest,
    worker,
    runId,
    assertCurrent,
    allowedResources,
    allowedTenants,
    resourceCredentialBytes,
    recordCheckpoint,
    resources,
    access,
    membership,
    installReadback,
    generatedMetadata,
    generatedFiles,
    authPlanBytes,
  } = setup;
  if (membership && !input.legacyPlan && !input.repositoryProduction) {
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
        execution.workerFailure = fact.failure_code;
        if (
          input.effectKind === "resources" &&
          input.readbackOnly === true &&
          fact.failure_code === "readback_unknown" &&
          "kind" in context &&
          context.kind === "neon_resource_bootstrap"
        ) {
          try {
            const observation = resourceReadbackSchema.safeParse(
              await readSpoolJson(
                requireSandbox(),
                path.posix.join(SPOOL_ROOT, runId, "resource-observation.json"),
                signal,
              ),
            );
            if (
              observation.success &&
              observation.data.status === "unknown" &&
              observation.data.operation_id === context.operation.operation_id &&
              observation.data.context_digest === contextDigest &&
              observation.data.fence_generation === input.fenceGeneration &&
              observation.data.resource_id === context.resource.resource_id &&
              observation.data.scope === context.resource.scope
            ) {
              const diagnostic = projectResourceReadbackDiagnostic(
                observation.data.inspectionFailure,
              );
              if (diagnostic !== undefined) {
                execution.resourceReadback = diagnostic;
              }
            }
          } catch {
            // Missing or malformed advisory metadata cannot replace the worker failure.
          }
        }
        if (fact.failure_code === "startup_rejected") {
          const authStartup = projectAuthStartupDiagnostic(fact.auth_startup);
          if (authStartup !== undefined) {
            execution.authStartup = authStartup;
          }
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
        await assertCurrent();
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
    if (frameId !== expectedAuthorityFrame || terminal) {
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
    const fence = fenceRequestSchema.safeParse(requestValue);
    if (fence.success) {
      const request = fence.data;
      if (
        unknownSeen ||
        !requestMatchesContext(request, context, contextDigest) ||
        !allowedResources.has(request.resource_id)
      ) {
        throw resourceMismatch();
      }
      await assertCurrent();
      await atomicReply(
        requireSandbox(),
        path.posix.join(SPOOL_ROOT, runId),
        runId,
        frameId,
        {
          kind: "fence_current",
          version: 1,
          operation_id: request.operation_id,
          context_digest: request.context_digest,
          fence_generation: request.fence_generation,
          current: true,
        },
        signal,
      );
      expectedAuthorityFrame += 1;
      return;
    }
    if (!started) {
      throw resourceMismatch();
    }
    const authorization = authorizationRequestSchema.safeParse(requestValue);
    if (authorization.success) {
      if (input.readbackOnly === true) {
        throw resourceMismatch();
      }
      const request = authorization.data;
      if (
        unknownSeen ||
        activeEffect !== null ||
        request.sequence !== expectedEffectSequence ||
        !requestMatchesContext(request, context, contextDigest) ||
        !requestMatchesWorkerScope(request.effect_id, request.tenant_id, context, worker) ||
        !allowedResources.has(request.resource_id) ||
        (request.tenant_id !== null && !allowedTenants.has(request.tenant_id))
      ) {
        throw unknownSeen ? reconciliationRequired() : resourceMismatch();
      }
      await assertCurrent();
      if (worker.subcommand === "integration-fence-app-authority") {
        if (
          setup.authorizeAppIntegrationRemoval === undefined ||
          request.effect_id !== "fence-app-integration-authority" ||
          request.tenant_id !== null
        ) {
          throw resourceMismatch();
        }
        await setup.authorizeAppIntegrationRemoval();
        await assertCurrent();
      }
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

    if (input.readbackOnly === true || recordCheckpoint === undefined) {
      throw resourceMismatch();
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
    await assertCurrent();
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
    await assertCurrent();
    const create = createSandbox;
    execution.stage = "sandbox_create";
    sandbox = await create({
      env: {},
      ...hostedOperatorSandboxSourceOptions(configuration),
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

    execution.stage = "worker_pin";
    await verifyWorkerPin(sandbox, worker, signal);
    execution.stage = "spool_setup";
    await assertCurrent();
    const spool = path.posix.join(SPOOL_ROOT, runId);
    const startup = path.posix.join(spool, "startup");
    await sandbox.fs.mkdir(startup, { recursive: true, signal });
    await writePrivateJson(sandbox, path.posix.join(startup, "context.json"), context, signal);
    if (input.directDatabaseUrl !== undefined) {
      await writePrivateJson(
        sandbox,
        path.posix.join(startup, "direct-database-url.json"),
        input.directDatabaseUrl,
        signal,
      );
    }
    if (input.startupFiles) {
      const allowed = new Set([
        ...(input.repositoryProduction
          ? [
              "approved-access-plan.json",
              "access-connections.json",
              "operator-plan.json",
              "membership-effect.json",
              "auth-database-resource.json",
              "realm-identity-proof.json",
              "gateway-readback-oidc.json",
            ]
          : []),
        "app-integration-approved-plan.json",
        "app-integration-connections.json",
        "app-integration-authority.json",
        ...([
          "integration-fence-app-authority",
          "integration-fence-app-authority-readback",
        ].includes(worker.subcommand)
          ? [
              "app-integration-removal-approved-plan.json",
              "app-integration-removal-source-plan.json",
              "app-integration-removal-connections.json",
            ]
          : []),
        ...(worker.operationScope === "central-integration-bootstrap-v1"
          ? ["central-integration-approved-plan.json", "central-integration-connections.json"]
          : []),
      ]);
      if (Object.keys(input.startupFiles).some((name) => !allowed.has(name))) {
        throw resourceMismatch();
      }
      await sandbox.writeFiles(
        Object.entries(input.startupFiles).map(([name, content]) => ({
          path: path.posix.join(startup, name),
          content,
          mode: 0o600,
        })),
        { signal },
      );
    }
    if (resourceCredentialBytes !== undefined) {
      await sandbox.writeFiles(
        [
          {
            content: resourceCredentialBytes,
            mode: 0o600,
            path: path.posix.join(startup, "resource-credentials.json"),
          },
        ],
        { signal },
      );
    }
    if (membership && input.membershipProof !== undefined) {
      const legacyPlan = input.legacyPlan;
      const legacyEffect = input.legacyEffect;
      if (legacyPlan === undefined || legacyEffect === undefined) {
        throw resourceMismatch();
      }
      await sandbox.writeFiles(
        [
          ...(legacyPlan.authMembership?.kind === "create-owned-organizations"
            ? [
                {
                  content: Buffer.from(
                    JSON.stringify({ organizationId: input.membershipProof.organizationId }),
                  ),
                  mode: 0o600,
                  path: path.posix.join(startup, "membership-target.json"),
                },
              ]
            : []),
          {
            content: Buffer.from(JSON.stringify(legacyPlan)),
            mode: 0o600,
            path: path.posix.join(startup, "operator-plan.json"),
          },
          {
            content: Buffer.from(
              JSON.stringify({
                version: 1,
                effectId: legacyEffect.id,
                kind: input.effectKind,
              }),
            ),
            mode: 0o600,
            path: path.posix.join(startup, "membership-effect.json"),
          },
          {
            content: Buffer.from(
              JSON.stringify({
                version: 1,
                environment: "preview",
                hostname: legacyPlan.neon.endpoint,
                port: 5432,
                database: legacyPlan.authDatabase.database,
                schema: "public",
                migratorRole: legacyPlan.authDatabase.migratorRole,
                runtimeRole: legacyPlan.authDatabase.runtimeRole,
                neon: {
                  projectId: legacyPlan.neon.projectId,
                  branchId: legacyPlan.neon.branchId,
                },
              }),
            ),
            mode: 0o600,
            path: path.posix.join(startup, "auth-database-resource.json"),
          },
          ...(input.membershipProof.proof === undefined
            ? []
            : [
                {
                  content: Buffer.from(JSON.stringify({ proof: input.membershipProof.proof })),
                  mode: 0o600,
                  path: path.posix.join(startup, "realm-identity-proof.json"),
                },
              ]),
          {
            content: Buffer.from(JSON.stringify({ token: input.membershipProof.oidcToken })),
            mode: 0o600,
            path: path.posix.join(startup, "gateway-readback-oidc.json"),
          },
        ],
        { signal },
      );
    }
    if (authPlanBytes !== undefined) {
      const legacyPlan = input.legacyPlan;
      if (legacyPlan === undefined) {
        throw resourceMismatch();
      }
      await sandbox.writeFiles(
        [
          {
            content: Buffer.from(JSON.stringify(legacyPlan)),
            mode: 0o600,
            path: path.posix.join(startup, "operator-plan.json"),
          },
        ],
        { signal },
      );
      await sandbox.writeFiles(
        [
          {
            content: authPlanBytes,
            mode: 0o600,
            path: path.posix.join(startup, "auth-schema-plan.json"),
          },
        ],
        { signal },
      );
    }
    const needsAccessConnections =
      access || installReadback || (resources && input.effectKind === "retire");
    if (
      (worker.operationScope === GENERATED_APP_SCOPE || needsAccessConnections) &&
      !input.repositoryProduction
    ) {
      const legacyPlan = input.legacyPlan;
      if (legacyPlan === undefined) {
        throw resourceMismatch();
      }
      const files = [
        {
          path: path.posix.join(startup, "approved-access-plan.json"),
          content: Buffer.from(JSON.stringify(legacyPlan)),
          mode: 0o600,
        },
      ];
      if (needsAccessConnections) {
        if (
          input.accessConnections === undefined ||
          (input.accessConnections.appMigrator !== input.directDatabaseUrl &&
            (access || installReadback))
        ) {
          throw resourceMismatch();
        }
        files.push({
          path: path.posix.join(startup, "access-connections.json"),
          content: Buffer.from(JSON.stringify(input.accessConnections)),
          mode: 0o600,
        });
      }
      await sandbox.writeFiles(files, { signal });
    }
    const releaseDirectory = path.posix.join(spool, "release");
    if (generatedMetadata !== undefined) {
      await sandbox.fs.mkdir(releaseDirectory, { recursive: true, signal });
      await sandbox.writeFiles(
        generatedFiles.map(({ member, content }) => ({
          content,
          mode: 0o600,
          path: path.posix.join(releaseDirectory, member),
        })),
        { signal },
      );
      await writePrivateJson(
        sandbox,
        path.posix.join(startup, "generated-app-release.json"),
        generatedMetadata,
        signal,
      );
    }
    await writePrivateJson(
      sandbox,
      path.posix.join(startup, "ready.json"),
      { version: 1, run_id: runId, frame_id: 0 },
      signal,
    );

    const timeout = String(AUTHORITY_REPLY_TIMEOUT_MS);
    const releaseArguments = [RESOURCES_RETIRE_COMMAND, RESOURCES_RETIRED_INSPECT_COMMAND].includes(
      worker.subcommand,
    )
      ? [releaseDirectory]
      : ["--release-directory", releaseDirectory];
    execution.stage = "command_start";
    command = await sandbox.runCommand({
      args: [
        worker.subcommand,
        "--file-spool",
        spool,
        runId,
        timeout,
        ...(generatedMetadata === undefined ? [] : releaseArguments),
      ],
      cmd: worker.executablePath,
      cwd: SPOOL_ROOT,
      detached: true,
      env: {},
      signal,
    });
    execution.stage = "command_stream";
    const runningCommand = command;
    for await (const log of runningCommand.logs({ signal })) {
      if (log.stream === "stderr") {
        continue;
      }
      execution.stage = "worker_protocol";
      await processOutputChunk(log.data);
      execution.stage = "command_stream";
    }
    execution.stage = "worker_protocol";
    if (bufferedStdout.length !== 0) {
      throw resourceMismatch();
    }
    execution.stage = "command_wait";
    const finished = await runningCommand.wait({ signal });
    execution.commandExit = finished.exitCode === 0 ? "zero" : "nonzero";
    if (finished.exitCode !== 0 || !started || !succeeded || !terminal || unknownSeen) {
      if (unknownSeen) {
        execution.protocol = "unknown";
      } else if (!started || !succeeded || !terminal) {
        execution.protocol = "incomplete";
      }
      throw unknownSeen ? reconciliationRequired() : unavailable();
    }
    execution.stage = "readback";
    if (
      (input.readbackOnly === true || worker.operationScope === "auth-app-access-v1") &&
      (access ||
        installReadback ||
        membership ||
        worker.operationScope === "app-integration-bootstrap-v1" ||
        worker.operationScope === "central-integration-bootstrap-v1" ||
        worker.operationScope === "auth-app-access-v1")
    ) {
      await assertCurrent();
      const raw = await readSpoolJson(sandbox, path.posix.join(spool, "readback.json"), signal);
      /* oxlint-disable eslint/no-nested-ternary, sonarjs/no-nested-conditional -- Preserve the existing three wire-protocol readback selections. */
      const schema =
        worker.subcommand === "integration-fence-app-authority-readback"
          ? removalReadbackSchema
          : ["app-integration-bootstrap-v1", "central-integration-bootstrap-v1"].includes(
                worker.operationScope,
              )
            ? accessReadbackSchema.extend({ receipt: z.unknown() })
            : worker.operationScope === "auth-app-access-v1"
              ? accessReadbackSchema.extend({ result: z.json() })
              : accessReadbackSchema;
      /* oxlint-enable eslint/no-nested-ternary, sonarjs/no-nested-conditional */
      const observed = schema.parse(raw);
      if (
        observed.operation_id !== context.operation.operation_id ||
        observed.context_digest !== contextDigest ||
        observed.fence_generation !== input.fenceGeneration
      ) {
        throw resourceMismatch();
      }
      await assertCurrent();
      return observed;
    }
    if (
      input.readbackOnly === true &&
      resources &&
      "kind" in context &&
      context.kind === "neon_resource_bootstrap"
    ) {
      await assertCurrent();
      const observed = resourceReadbackSchema.parse(
        await readSpoolJson(sandbox, path.posix.join(spool, "resource-observation.json"), signal),
      );
      if (
        observed.operation_id !== context.operation.operation_id ||
        observed.context_digest !== contextDigest ||
        observed.fence_generation !== input.fenceGeneration ||
        observed.resource_id !== context.resource.resource_id ||
        observed.scope !== context.resource.scope
      ) {
        throw resourceMismatch();
      }
      await assertCurrent();
      return observed;
    }
  } catch (error) {
    try {
      for (const field of ["status", "statusCode"]) {
        const status: unknown = Object.getOwnPropertyDescriptor(error, field)?.value;
        const parsed = z.number().int().min(100).max(599).safeParse(status);
        if (parsed.success) {
          execution.httpStatus = parsed.data;
          break;
        }
      }
    } catch {
      /* Diagnostic extraction cannot change SDK failure handling. */
    }
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
      if (operationError === null) {
        execution.stage = "sandbox_cleanup";
      }
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
  return null;
};

/** Runs a trusted already-approved fixed worker through the existing framed Sandbox transport. */
export const runAppIntegrationFileSpool = async (
  configuration: HostedOperatorSandboxConfiguration,
  input: {
    worker: ProtectedInstallerWorkerDescriptor;
    context: WorkerContext;
    resourceCredentialBytes?: Buffer;
    runId: string;
    directDatabaseUrl?: string;
    startupFiles: Readonly<Record<string, Buffer>>;
    readOnly: boolean;
    signal: AbortSignal;
    assertCurrent: () => Promise<void>;
    recordCheckpoint?: RecordWorkerCheckpoint;
    authorizeAppIntegrationRemoval?: () => Promise<void>;
  },
  dependencies: { createSandbox?: CreateSandbox } = {},
) => {
  const worker = z
    .strictObject({
      executablePath: z.string().min(1),
      id: z.string().min(1),
      operationScope: workerScopeSchema,
      sha256: digestSchema,
      subcommand: workerSubcommandSchema,
    })
    .parse(input.worker);
  if (
    !(
      (worker.operationScope === "app-integration-bootstrap-v1" &&
        worker.id === "app-integration-bootstrap-v1" &&
        !("kind" in input.context)) ||
      (worker.operationScope === RESOURCES_SCOPE &&
        "kind" in input.context &&
        input.context.kind === "neon_resource_bootstrap" &&
        input.context.app_id === "integrations" &&
        input.context.resource.scope === "integration_control_database" &&
        [RESOURCES_COMMAND, RESOURCES_INSPECT_COMMAND].includes(worker.subcommand) &&
        input.resourceCredentialBytes !== undefined) ||
      (worker.operationScope === "central-integration-bootstrap-v1" &&
        worker.id === "central-integration-bootstrap-v1" &&
        "kind" in input.context &&
        input.context.app_id === "integrations" &&
        input.context.tenant_targets.length === 0 &&
        ((input.context.kind === "central_integration_schema" &&
          ["central-integration-schema", "central-integration-schema-readback"].includes(
            worker.subcommand,
          )) ||
          (input.context.kind === "central_source_capture" &&
            worker.subcommand === "central-integration-source-capture" &&
            input.readOnly &&
            input.directDatabaseUrl === undefined &&
            input.resourceCredentialBytes === undefined &&
            input.recordCheckpoint === undefined &&
            Object.keys(input.startupFiles).every(
              (key) => key === "central-integration-approved-plan.json",
            ))))
    )
  ) {
    throw resourceMismatch();
  }
  if (
    !("kind" in input.context && input.context.kind === "central_source_capture") &&
    (input.directDatabaseUrl === undefined || input.directDatabaseUrl.length === 0)
  ) {
    throw resourceMismatch();
  }
  const removal = worker.subcommand === "integration-fence-app-authority";
  if (
    (removal && (!input.authorizeAppIntegrationRemoval || input.readOnly)) ||
    (!removal && input.authorizeAppIntegrationRemoval !== undefined)
  ) {
    throw resourceMismatch();
  }
  const context = input.context;
  if (context.installer.id !== worker.id || context.installer.sha256 !== worker.sha256) {
    throw resourceMismatch();
  }
  const bytes = canonicalContextBytes(context);
  if (bytes.length > MAX_PROTOCOL_FRAME_BYTES) {
    throw resourceMismatch();
  }
  return await runPinnedFileSpoolTransport(
    configuration,
    dependencies.createSandbox ??
      (async (options) =>
        await Sandbox.create({
          ...options,
          token: await getVercelOidcToken({ project: options.projectId, team: options.teamId }),
        })),
    {
      directDatabaseUrl: input.directDatabaseUrl,
      readbackOnly: input.readOnly ? true : undefined,
      fenceGeneration: context.operation.fence_generation,
      signal: input.signal,
      startupFiles: input.startupFiles,
    },
    { stage: "sandbox_create", mode: input.readOnly ? "inspect" : "execute" },
    {
      context,
      contextDigest: sha256(bytes),
      worker,
      runId: workerRunIdSchema.parse(input.runId),
      assertCurrent: input.assertCurrent,
      allowedResources: new Set([context.resource.resource_id]),
      allowedTenants: new Set(context.tenant_targets),
      recordCheckpoint: input.recordCheckpoint,
      authorizeAppIntegrationRemoval: input.authorizeAppIntegrationRemoval,
      resources: "kind" in input.context && input.context.kind === "neon_resource_bootstrap",
      resourceCredentialBytes: input.resourceCredentialBytes,
      access: false,
      membership: false,
      installReadback: false,
      generatedFiles: [],
    },
  );
};

/** Creates a source-free, project-OIDC Sandbox and runs only a catalog-pinned installer. */
export const createHostedOperatorSandboxLauncher = (
  configuration: HostedOperatorSandboxConfiguration,
  dependencies: {
    createSandbox?: CreateSandbox;
    diagnosticSink?: HostedOperatorConsentDiagnosticSink;
  } = {},
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
  const run = async (input: SandboxWorkerInput) => {
    const execution: LauncherExecution = {
      stage: "worker_preparation",
      mode: input.readbackOnly === true ? "inspect" : "execute",
    };
    return await observeOperatorExecutionStage(
      input.plan.selection.sessionId,
      execution.stage,
      async () => await runSandboxWorker(configuration, createSandbox, input, execution),
      dependencies.diagnosticSink,
      execution,
    );
  };
  return {
    inspect: async (input: HostedOperatorSandboxReadbackInput) => await run(input),
    execute: async (input: HostedOperatorSandboxWorkerInput) => {
      await run(input);
    },
  };
};

/** Global central schema uses a distinct closed context through the same lease/checkpoint transport. */
export const runCentralIntegrationFileSpool = async (
  configuration: HostedOperatorSandboxConfiguration,
  input: Omit<Parameters<typeof runAppIntegrationFileSpool>[1], "context"> & {
    context: CentralIntegrationContextWire | CentralSourceCaptureContextWire;
  },
  dependencies: Parameters<typeof runAppIntegrationFileSpool>[2] = {},
) => {
  if (
    input.worker.operationScope !== "central-integration-bootstrap-v1" ||
    !["central_integration_schema", "central_source_capture"].includes(input.context.kind)
  ) {
    throw resourceMismatch();
  }
  return await runAppIntegrationFileSpool(configuration, input, dependencies);
};

/** An explicit Production entry point for the same fixed, credential-isolated worker transport.
 * It cannot repurpose a Preview context, launch arbitrary commands, or mutate shared Auth schema.
 */
export const runRepositoryProductionFileSpool = async (
  configuration: HostedOperatorSandboxConfiguration,
  input: {
    operation: "storage" | "schema" | "access" | "membership" | "auth-management";
    worker: ProtectedInstallerWorkerDescriptor;
    context: ProtectedInstallContextWire | ResourceBootstrapContextWire;
    startupFiles: Readonly<Record<string, Buffer>>;
    directDatabaseUrl: string;
    resourceCredentialBytes?: Buffer;
    generatedRelease?: GeneratedAppReleaseFiles;
    readOnly: boolean;
    runId: string;
    signal: AbortSignal;
    assertCurrent: () => Promise<void>;
    recordCheckpoint?: RecordWorkerCheckpoint;
  },
  dependencies: { createSandbox?: CreateSandbox } = {},
) => {
  const invalidContext = () => {
    reportRepositoryProductionFailure("worker_transport_validation", "scope_mismatch");
    return resourceMismatch();
  };
  const modes = {
    storage: {
      scope: RESOURCES_SCOPE,
      id: RESOURCES_SCOPE,
      command: RESOURCES_COMMAND,
      read: RESOURCES_INSPECT_COMMAND,
    },
    schema: {
      scope: GENERATED_APP_SCOPE,
      id: "generated-app-protected-installer-v1",
      command: GENERATED_COMMAND,
      read: GENERATED_INSPECT_COMMAND,
    },
    access: {
      scope: ACCESS_SCOPE,
      id: "generated-app-protected-installer-v1",
      command: ACCESS_COMMAND,
      read: ACCESS_INSPECT_COMMAND,
    },
    membership: {
      scope: MEMBERSHIP_SCOPE,
      id: "auth-owned-organization-v1",
      command: MEMBERSHIP_COMMAND,
      read: MEMBERSHIP_INSPECT_COMMAND,
    },
    "auth-management": {
      scope: "auth-app-access-v1",
      id: "auth-app-access-v1",
      command: "auth-protected-app-access",
      read: "auth-protected-app-access-readback",
    },
  } as const;
  const mode = modes[input.operation];
  const worker = { ...input.worker, subcommand: input.readOnly ? mode.read : mode.command };
  const { context } = input;
  if (
    context.resource.environment !== "production" ||
    worker.operationScope !== mode.scope ||
    worker.id !== mode.id ||
    context.installer.id !== worker.id ||
    context.installer.sha256 !== worker.sha256 ||
    !Number.isSafeInteger(context.operation.fence_generation) ||
    context.operation.fence_generation < 1 ||
    !input.directDatabaseUrl ||
    /[\0\r\n]/u.test(input.directDatabaseUrl) ||
    (input.readOnly ? input.recordCheckpoint !== undefined : input.recordCheckpoint === undefined)
  ) {
    throw invalidContext();
  }
  if (
    input.operation === "storage" &&
    (!("kind" in context) ||
      context.kind !== "neon_resource_bootstrap" ||
      context.resource.scope !== "app_database" ||
      input.resourceCredentialBytes === undefined ||
      sha256(input.resourceCredentialBytes) !== context.resource.credentials_sha256)
  ) {
    throw invalidContext();
  }
  if (input.operation !== "storage" && "kind" in context) {
    throw invalidContext();
  }
  let required: string[];
  if (input.operation === "membership") {
    required = [
      "operator-plan.json",
      "membership-effect.json",
      "auth-database-resource.json",
      "realm-identity-proof.json",
      "gateway-readback-oidc.json",
    ];
  } else if (input.operation === "auth-management") {
    required = ["operator-plan.json", "auth-database-resource.json"];
  } else if (input.operation === "storage") {
    required = [];
  } else {
    required = ["approved-access-plan.json"];
    if (input.operation === "access" || input.readOnly) {
      required.push("access-connections.json");
    }
  }
  const allowed = new Set(required);
  if (
    required.some((name) => input.startupFiles[name] === undefined) ||
    Object.keys(input.startupFiles).some((name) => !allowed.has(name))
  ) {
    throw invalidContext();
  }
  const release = input.generatedRelease;
  let generatedMetadata: GeneratedAppReleaseMetadata | undefined;
  let generatedFiles: { member: string; content: Buffer }[] = [];
  if (input.operation === "schema" || input.operation === "access") {
    if (!release || GENERATED_RELEASE_MEMBERS.some((name) => !Buffer.isBuffer(release[name]))) {
      throw invalidContext();
    }
    const manifest = sha256(release["release-manifest.json"]);
    if (manifest !== context.release.sha256) {
      throw invalidContext();
    }
    generatedMetadata = {
      version: 1,
      app_id: context.app_id,
      release_id: context.release.id,
      release_manifest_sha256: manifest,
      app_artifact_sha256: sha256(release["app-artifact.json"]),
      sql_bundle_sha256: sha256(release["sql-bundle.sql"]),
    };
    generatedFiles = GENERATED_RELEASE_MEMBERS.map((member) => ({
      member,
      content: release[member],
    }));
  }
  const bytes = canonicalContextBytes(context);
  if (bytes.length > MAX_PROTOCOL_FRAME_BYTES) {
    throw invalidContext();
  }
  const assertCurrent = () =>
    observeRepositoryProductionPhase(
      "worker_authority",
      "authorization_unavailable",
      input.assertCurrent,
    );
  const createSandbox: CreateSandbox = async (options) => {
    const injectedCreate = dependencies.createSandbox;
    if (injectedCreate !== undefined) {
      return await observeRepositoryProductionPhase("sandbox_create", "provider_unavailable", () =>
        injectedCreate(options),
      );
    }
    const token = await observeRepositoryProductionPhase(
      "sandbox_oidc_acquire",
      "workload_unavailable",
      () => getVercelOidcToken({ project: options.projectId, team: options.teamId }),
    );
    return await observeRepositoryProductionPhase("sandbox_create", "provider_unavailable", () =>
      Sandbox.create({ ...options, token }),
    );
  };
  await observeRepositoryProductionPhase("worker_authority", "authorization_unavailable", () =>
    input.assertCurrent(),
  );
  return await runPinnedFileSpoolTransport(
    configuration,
    createSandbox,
    {
      directDatabaseUrl: input.directDatabaseUrl,
      readbackOnly: input.readOnly ? true : undefined,
      fenceGeneration: context.operation.fence_generation,
      signal: input.signal,
      startupFiles: input.startupFiles,
      repositoryProduction: true,
    },
    { stage: "sandbox_create", mode: input.readOnly ? "inspect" : "execute" },
    {
      context,
      contextDigest: sha256(bytes),
      worker,
      runId: workerRunIdSchema.parse(input.runId),
      assertCurrent,
      allowedResources: new Set([context.resource.resource_id]),
      allowedTenants: new Set(context.tenant_targets),
      recordCheckpoint: input.recordCheckpoint,
      resources: input.operation === "storage",
      resourceCredentialBytes: input.resourceCredentialBytes,
      access: input.operation === "access",
      membership: input.operation === "membership",
      installReadback: input.operation === "schema" && input.readOnly,
      generatedMetadata,
      generatedFiles,
    },
  );
};
