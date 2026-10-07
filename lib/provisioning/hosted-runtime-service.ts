import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  decryptVersionedVercelToken,
  encryptVercelToken,
  VercelTokenDecryptionKeyError,
} from "../integrations/vercel-installation";
import type {
  VercelIntegrationConfig,
  VercelInstallationBinding,
  VercelTokenKeyringConfig,
} from "../integrations/vercel-installation";
import type { BuilderProvisionAuthority } from "./journal";
import {
  hostedRuntimeIdentity,
  hostedRuntimeProofSchema,
  hostedRuntimeTargetSchema,
  updateHostedRuntimeJournal,
} from "./hosted-runtime-journal";
import type {
  HostedRuntimeJournalStore,
  HostedRuntimeJournalRecord,
  HostedRuntimeTarget,
} from "./hosted-runtime-journal";
import {
  assertHostedRuntimeCluster,
  createHostedRuntimeVercelProvider,
  HostedRuntimeProviderError,
} from "./hosted-runtime-provider";

export type PrivateRuntimeFiles = Record<string, string>;
export type HostedRuntimeOperation = "checkpoint" | "prepare" | "verify" | "cleanup";
export type HostedRuntimeProof = z.infer<typeof hostedRuntimeProofSchema>;
const privateFilesSchema = z.record(z.string().regex(/^[A-Za-z0-9_.-]+\.json$/u), z.string());
export interface HostedRuntimeExecutor {
  capture: () => Promise<PrivateRuntimeFiles>;
  restore: (files: PrivateRuntimeFiles) => Promise<void>;
  run: (input: {
    operation: HostedRuntimeOperation;
    runtimeId: string;
    clusterUrl: string;
    productionDatabaseIdentity: string;
    signal?: AbortSignal;
  }) => Promise<HostedRuntimeProof | null>;
}

export class HostedRuntimeCommandError extends Error {
  readonly operation: HostedRuntimeOperation;
  readonly exitCode: number;
  constructor(operation: HostedRuntimeOperation, exitCode: number) {
    super(`The repository app:runtime ${operation} operation failed (${exitCode}).`);
    this.name = "HostedRuntimeCommandError";
    this.operation = operation;
    this.exitCode = exitCode;
  }
}

const associatedData = (authority: BuilderProvisionAuthority, target: HostedRuntimeTarget) =>
  JSON.stringify({
    ...hostedRuntimeIdentity(authority, target),
    purpose: "app-runtime-private-state-v1",
  });

export const encryptHostedRuntimeFiles = (input: {
  authority: BuilderProvisionAuthority;
  target: HostedRuntimeTarget;
  files: PrivateRuntimeFiles;
  config: VercelTokenKeyringConfig;
}) => ({
  ...encryptVercelToken({
    associatedData: associatedData(input.authority, input.target),
    key: input.config.tokenKey,
    token: JSON.stringify(privateFilesSchema.parse(input.files)),
  }),
  keyVersion: input.config.tokenKeyVersion,
});

export const decryptHostedRuntimeFiles = (input: {
  authority: BuilderProvisionAuthority;
  target: HostedRuntimeTarget;
  record: HostedRuntimeJournalRecord;
  config: VercelTokenKeyringConfig;
}): PrivateRuntimeFiles | undefined => {
  const state = input.record.privateState;
  if (!state) {
    return undefined;
  }
  try {
    return privateFilesSchema.parse(
      JSON.parse(
        decryptVersionedVercelToken({
          ...state,
          associatedData: associatedData(input.authority, input.target),
          config: input.config,
        }),
      ),
    );
  } catch (error) {
    if (error instanceof VercelTokenDecryptionKeyError) {
      throw new HostedRuntimeProviderError("authorization_required");
    }
    throw error;
  }
};

/** Native installer credentials remain in private state. Only restricted runtime bindings are eligible for publication. */
export const hostedRuntimeBindings = (files: PrivateRuntimeFiles, appId: string) => {
  const raw = files["environment.json"];
  if (!raw) {
    throw new Error("The prepared runtime has no protected environment.");
  }
  const environment = z.record(z.string(), z.string()).parse(JSON.parse(raw));
  const appKey = `${appId.toUpperCase().replaceAll("-", "_")}_DATABASE_URL`;
  const keys = [
    appKey,
    "PLATFORM_AUTH_DATABASE_URL",
    "BETTER_AUTH_APP_NAME",
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_URL",
  ];
  if (keys.some((key) => !environment[key]) || environment.BETTER_AUTH_APP_NAME !== "apps") {
    throw new Error("The prepared runtime is missing an app or authentication binding.");
  }
  const state = z
    .object({
      clusterUrl: z.string(),
      plan: z.object({
        appId: z.literal(appId),
        authDatabase: z.string(),
        database: z.string(),
        principal: z.string(),
      }),
    })
    .parse(JSON.parse(files["state.json"] ?? "null"));
  const cluster = new URL(state.clusterUrl);
  for (const [key, database, principal] of [
    [appKey, state.plan.database, state.plan.principal],
    ["PLATFORM_AUTH_DATABASE_URL", state.plan.authDatabase, `${state.plan.principal}_auth`],
  ]) {
    const url = new URL(environment[key]);
    const ownsRestrictedDatabase =
      url.hostname === cluster.hostname &&
      url.pathname === `/${database}` &&
      decodeURIComponent(url.username) === principal;
    const excludesInstaller = url.username !== cluster.username && url.password !== "";
    if (
      !ownsRestrictedDatabase ||
      !excludesInstaller ||
      url.searchParams.get("sslmode") !== "verify-full"
    ) {
      throw new Error(
        "The prepared environment contains an installer or unrelated database binding.",
      );
    }
  }
  return Object.fromEntries(keys.map((key) => [key, environment[key]]));
};

/** Server-only Sandbox launch projection; never pass this result to a tool, event or model. */
export const hostedRuntimeExecutionEnvironment = (files: PrivateRuntimeFiles, appId: string) => {
  const bindings = hostedRuntimeBindings(files, appId);
  const environment = z.record(z.string(), z.string()).parse(JSON.parse(files["environment.json"]));
  const runtime = { ...environment, ...bindings };
  delete runtime.APP_RUNTIME_STATE_DIR;
  delete runtime.APP_RUNTIME_CLUSTER_DATABASE_URL;
  runtime.DATABASE_URL = bindings.PLATFORM_AUTH_DATABASE_URL;
  runtime.DATABASE_URL_UNPOOLED = bindings.PLATFORM_AUTH_DATABASE_URL;
  return runtime;
};

/** The caller must already have an effect-specific approval and freshly verified tenant membership. */
export const prepareHostedRuntime = async (input: {
  authority: BuilderProvisionAuthority;
  target: HostedRuntimeTarget;
  approvedByCallId: string;
  store: HostedRuntimeJournalStore;
  config: VercelIntegrationConfig;
  readCredential: () => Promise<{ binding: VercelInstallationBinding; token: string } | undefined>;
  executor: HostedRuntimeExecutor;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  now?: () => number;
}) => {
  const target = hostedRuntimeTargetSchema.parse(input.target);
  const now = input.now ?? Date.now;
  const identity = hostedRuntimeIdentity(input.authority, target);
  const executionAbort = new AbortController();
  const executionSignal = input.signal
    ? AbortSignal.any([input.signal, executionAbort.signal])
    : executionAbort.signal;
  const leaseId = randomUUID();
  const update = async (
    change: (record: HostedRuntimeJournalRecord) => HostedRuntimeJournalRecord,
  ) =>
    await updateHostedRuntimeJournal({
      authority: input.authority,
      now,
      store: input.store,
      target,
      update: change,
    });
  let claimed = false;
  let leaseLost = false;
  let leasePending: Promise<void> | null = null;
  const settleLeaseRenewal = async () => {
    if (leasePending !== null) {
      await leasePending;
    }
  };
  const leaseDuration = 15 * 60_000;
  const ownedUpdate = async (
    change: (record: HostedRuntimeJournalRecord) => HostedRuntimeJournalRecord,
  ) => {
    // oxlint-disable-next-line react-doctor/async-defer-await -- durable ownership must be checked before reporting loss during an in-flight operation.
    const row = await update((record) => {
      if (record.leaseId !== leaseId) {
        throw new Error("Another caller owns this runtime preparation.");
      }
      record.leaseExpiresAt = new Date(now() + leaseDuration).toISOString();
      return change(record);
    });
    if (leaseLost) {
      throw new Error("Runtime preparation lost its durable lease.");
    }
    return row;
  };
  const checkpoint = async (
    step: HostedRuntimeJournalRecord["step"],
    proof?: z.infer<typeof hostedRuntimeProofSchema>,
  ) => {
    const files = privateFilesSchema.parse(await input.executor.capture());
    if (!files["state.json"]) {
      throw new Error(
        "The repository did not checkpoint its runtime credentials before database mutation.",
      );
    }
    return await ownedUpdate((record) => {
      record.privateState = {
        ...encryptVercelToken({
          associatedData: associatedData(input.authority, target),
          key: input.config.tokenKey,
          token: JSON.stringify(files),
        }),
        keyVersion: input.config.tokenKeyVersion,
      };
      if (proof !== undefined) {
        record.proof = proof;
      }
      record.step = step;
      return record;
    });
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    const credential = await input.readCredential();
    if (!credential) {
      throw new HostedRuntimeProviderError("authorization_required");
    }
    const provider = createHostedRuntimeVercelProvider({
      credential,
      fetch: input.fetch,
      signal: input.signal,
      target,
    });
    await provider.assertProject();
    await provider.assertEnvironmentAvailability(
      [
        `${target.appId.toUpperCase().replaceAll("-", "_")}_DATABASE_URL`,
        "PLATFORM_AUTH_DATABASE_URL",
        "BETTER_AUTH_APP_NAME",
        "BETTER_AUTH_SECRET",
      ],
      identity.runtimeId,
    );
    await input.store.reserve({
      approvedByCallId: input.approvedByCallId,
      authority: input.authority,
      now: new Date(now()),
      target,
    });
    const row = await update((record) => {
      if (
        record.leaseId !== undefined &&
        record.leaseExpiresAt !== undefined &&
        Date.parse(record.leaseExpiresAt) > now()
      ) {
        return record;
      }
      return {
        ...record,
        approvedByCallId: input.approvedByCallId,
        environmentBound: record.environmentBound ?? record.step === "bound",
        leaseExpiresAt: new Date(now() + leaseDuration).toISOString(),
        leaseId,
        status: "pending",
      };
    });
    if (row.record.leaseId !== leaseId) {
      return { appId: target.appId, status: "pending" as const };
    }
    claimed = true;
    timer = setInterval(() => {
      if (leasePending) {
        return;
      }
      // This renewal never carries provider payloads, credentials or model input.
      leasePending = (async () => {
        try {
          await ownedUpdate((record) => record);
        } catch {
          leaseLost = true;
          executionAbort.abort();
        } finally {
          leasePending = null;
        }
      })();
    }, 5 * 60_000);
    const original = decryptHostedRuntimeFiles({
      authority: input.authority,
      config: input.config,
      record: row.record,
      target,
    });
    const cluster = await provider.readClusterCredential();
    await ownedUpdate((record) => ({ ...record, credentialReference: cluster.reference }));
    if (original) {
      const state = z
        .object({ clusterUrl: z.string() })
        .parse(JSON.parse(original["state.json"] ?? "null"));
      if (state.clusterUrl !== cluster.clusterUrl) {
        throw new HostedRuntimeProviderError("resource_mismatch");
      }
      await input.executor.restore(original);
    }
    await input.executor.run({
      clusterUrl: cluster.clusterUrl,
      operation: "checkpoint",
      productionDatabaseIdentity: cluster.productionDatabaseIdentity,
      runtimeId: identity.runtimeId,
      signal: executionSignal,
    });
    await checkpoint("planned");
    input.signal?.throwIfAborted();
    await ownedUpdate((record) => record);
    // Revocation is checked immediately before remote database writes and
    // again before environment changes; a long private preparation is not a
    // reusable provider grant.
    const prepareCredential = await input.readCredential();
    if (!prepareCredential) {
      throw new HostedRuntimeProviderError("authorization_required");
    }
    const prepareProvider = createHostedRuntimeVercelProvider({
      credential: prepareCredential,
      fetch: input.fetch,
      signal: executionSignal,
      target,
    });
    await prepareProvider.assertProject();
    await assertHostedRuntimeCluster(prepareProvider, cluster.clusterUrl);
    await input.executor.run({
      clusterUrl: cluster.clusterUrl,
      operation: "prepare",
      productionDatabaseIdentity: cluster.productionDatabaseIdentity,
      runtimeId: identity.runtimeId,
      signal: executionSignal,
    });
    await checkpoint("prepared");
    const observed = await input.executor.run({
      clusterUrl: cluster.clusterUrl,
      operation: "verify",
      productionDatabaseIdentity: cluster.productionDatabaseIdentity,
      runtimeId: identity.runtimeId,
      signal: executionSignal,
    });
    const proof = hostedRuntimeProofSchema.parse(observed);
    const verified = await checkpoint("verified", proof);
    const files = decryptHostedRuntimeFiles({
      authority: input.authority,
      config: input.config,
      record: verified.record,
      target,
    });
    if (!files) {
      throw new Error("Prepared credentials were not durably saved.");
    }
    const bindings = hostedRuntimeBindings(files, target.appId);
    // Sandbox-origin fixture cookies are private validation state. Native
    // Vercel retains its own auth origin and integration-owned installer URL.
    delete bindings.BETTER_AUTH_URL;
    const bindingCredential = await input.readCredential();
    if (!bindingCredential) {
      throw new HostedRuntimeProviderError("authorization_required");
    }
    const bindingProvider = createHostedRuntimeVercelProvider({
      credential: bindingCredential,
      fetch: input.fetch,
      signal: executionSignal,
      target,
    });
    await bindingProvider.assertProject();
    await assertHostedRuntimeCluster(bindingProvider, cluster.clusterUrl);
    const keys = await bindingProvider.bindEnvironment(bindings, { runtimeId: identity.runtimeId });
    await ownedUpdate((record) => ({
      ...record,
      environmentBound: true,
      status: "prepared",
      step: "bound",
    }));
    return {
      appId: target.appId,
      branch: target.branch,
      environment: target.environment,
      keys,
      projectId: target.projectId,
      proof,
      status: "prepared" as const,
    };
  } catch (error) {
    if (claimed && !leaseLost) {
      await ownedUpdate((record) => ({ ...record, status: "failed" }));
    }
    if (error instanceof HostedRuntimeProviderError) {
      return { appId: target.appId, code: error.code, status: "blocked" as const };
    }
    if (error instanceof HostedRuntimeCommandError) {
      return {
        appId: target.appId,
        exitCode: error.exitCode,
        operation: error.operation,
        status: "failed" as const,
      };
    }
    // Repository/provider exceptions can contain secrets; only known safe codes leave this boundary.
    return { appId: target.appId, code: "runtime_preparation_failed", status: "failed" as const };
  } finally {
    if (timer) {
      clearInterval(timer);
    }
    await settleLeaseRenewal();
    if (claimed && !leaseLost) {
      await ownedUpdate((record) => {
        delete record.leaseId;
        delete record.leaseExpiresAt;
        return record;
      });
    }
  }
};
