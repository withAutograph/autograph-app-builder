import type { prepareHostedRuntime } from "./hosted-runtime-service";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { hostedRuntimeIdentity, updateHostedRuntimeJournal } from "./hosted-runtime-journal";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";
import {
  assertHostedRuntimeCluster,
  createHostedRuntimeVercelProvider,
  HostedRuntimeProviderError,
} from "./hosted-runtime-provider";
import {
  decryptHostedRuntimeFiles,
  HostedRuntimeCommandError,
  hostedRuntimeBindings,
} from "./hosted-runtime-service";

const cleanupFailure = (error: Error | null, appId: string) => {
  if (error instanceof HostedRuntimeProviderError) {
    return { appId, code: error.code, status: "blocked" as const };
  }
  if (error instanceof HostedRuntimeCommandError) {
    return {
      appId,
      exitCode: error.exitCode,
      operation: error.operation,
      status: "failed" as const,
    };
  }
  return { appId, code: "runtime_cleanup_failed", status: "failed" as const };
};

/** Separate effect-specific approval; stopping a turn preserves recoverable resources. */
export const cleanupHostedRuntime = async (input: Parameters<typeof prepareHostedRuntime>[0]) => {
  const { target } = input;
  const now = input.now ?? Date.now;
  const identity = hostedRuntimeIdentity(input.authority, target);
  const leaseId = randomUUID();
  const abort = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, abort.signal]) : abort.signal;
  let claimed = false;
  let leaseLost = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let renewal: Promise<void> | null = null;
  const settleRenewal = async () => {
    if (renewal !== null) {
      await renewal;
    }
  };
  const update = async (
    change: (record: HostedRuntimeJournalRecord) => HostedRuntimeJournalRecord,
  ) => await updateHostedRuntimeJournal({ ...input, now, update: change });
  const ownedUpdate = async (
    change: (record: HostedRuntimeJournalRecord) => HostedRuntimeJournalRecord,
  ) =>
    await update((record) => {
      if (leaseLost || record.leaseId !== leaseId) {
        throw new HostedRuntimeProviderError("resource_mismatch");
      }
      return change({ ...record, leaseExpiresAt: new Date(now() + 15 * 60_000).toISOString() });
    });
  const provider = async () => {
    const credential = await input.readCredential();
    if (!credential) {
      throw new HostedRuntimeProviderError("authorization_required");
    }
    const client = createHostedRuntimeVercelProvider({
      credential,
      fetch: input.fetch,
      signal,
      target,
    });
    await client.assertProject();
    return client;
  };
  try {
    const current = await input.store.read(input);
    if (!current || current.record.status === "cleaned") {
      return { appId: target.appId, status: "cleaned" as const };
    }
    const files = decryptHostedRuntimeFiles({ ...input, record: current.record });
    if (!files && current.record.step !== "reserved") {
      throw new HostedRuntimeProviderError("resource_mismatch");
    }
    const claimedRow = await update((record) => {
      if (
        record.leaseId !== undefined &&
        record.leaseExpiresAt !== undefined &&
        Date.parse(record.leaseExpiresAt) > now()
      ) {
        return record;
      }
      return {
        ...record,
        cleanupApprovedByCallId: input.approvedByCallId,
        environmentBound: record.environmentBound ?? record.step === "bound",
        leaseExpiresAt: new Date(now() + 15 * 60_000).toISOString(),
        leaseId,
        status: "cleaning",
      };
    });
    if (claimedRow.record.leaseId !== leaseId) {
      return { appId: target.appId, status: "pending" as const };
    }
    claimed = true;
    timer = setInterval(() => {
      if (renewal) {
        return;
      }
      renewal = (async () => {
        try {
          await ownedUpdate((record) => record);
        } catch {
          leaseLost = true;
          abort.abort();
        } finally {
          renewal = null;
        }
      })();
    }, 5 * 60_000);
    if (files) {
      const client = await provider();
      const cluster = await client.readClusterCredential();
      const original = z
        .object({ clusterUrl: z.string() })
        .parse(JSON.parse(files["state.json"] ?? "null"));
      if (original.clusterUrl !== cluster.clusterUrl) {
        throw new HostedRuntimeProviderError("resource_mismatch");
      }
      // A failed initial plan may have no environment yet and has made no DB writes.
      if (files["environment.json"]) {
        const bindings = hostedRuntimeBindings(files, target.appId);
        delete bindings.BETTER_AUTH_URL;
        await client.removeEnvironmentBindings(bindings, {
          preserveForeign: claimedRow.record.environmentBound !== true,
          runtimeId: identity.runtimeId,
        });
      }
      await ownedUpdate((record) => ({ ...record, step: "environment-removed" }));
      const cleanupProvider = await provider();
      await assertHostedRuntimeCluster(cleanupProvider, cluster.clusterUrl);
      await input.executor.restore(files);
      await input.executor.run({
        clusterUrl: cluster.clusterUrl,
        operation: "cleanup",
        productionDatabaseIdentity: cluster.productionDatabaseIdentity,
        runtimeId: identity.runtimeId,
        signal,
      });
    }
    await ownedUpdate((record) => {
      delete record.privateState;
      delete record.proof;
      delete record.environmentBound;
      return { ...record, status: "cleaned", step: "cleaned" };
    });
    return {
      appId: target.appId,
      branch: target.branch,
      projectId: target.projectId,
      status: "cleaned" as const,
    };
  } catch (error) {
    if (claimed && !leaseLost) {
      await ownedUpdate((record) => ({ ...record, status: "failed" }));
    }
    return cleanupFailure(error instanceof Error ? error : null, target.appId);
  } finally {
    if (timer) {
      clearInterval(timer);
    }
    await settleRenewal();
    if (claimed && !leaseLost) {
      await ownedUpdate((record) => {
        delete record.leaseId;
        delete record.leaseExpiresAt;
        return record;
      });
    }
  }
};
