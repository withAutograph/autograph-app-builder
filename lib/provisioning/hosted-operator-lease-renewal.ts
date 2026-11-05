import { isDeepStrictEqual } from "node:util";
import type { HostedRuntimeJournalRow } from "./hosted-runtime-journal";

/** A renewal changes only expiry for the same still-live lease; every protected field must match. */
export const sameJournalAfterLeaseRenewal = (
  original: HostedRuntimeJournalRow,
  latest: HostedRuntimeJournalRow | undefined,
  now: number,
): boolean => {
  if (latest === undefined) {
    return false;
  }
  if (latest.revision === original.revision) {
    return latest.record.leaseId === original.record.leaseId;
  }
  const { leaseExpiresAt: originalExpiry, ...originalRecord } = original.record;
  const { leaseExpiresAt: latestExpiry, ...latestRecord } = latest.record;
  return [
    latest.revision > original.revision,
    original.record.leaseId !== undefined,
    original.record.leaseId === latest.record.leaseId,
    originalExpiry !== undefined,
    latestExpiry !== undefined,
    Date.parse(latestExpiry ?? "") > now,
    Date.parse(latestExpiry ?? "") >= Date.parse(originalExpiry ?? ""),
    isDeepStrictEqual(originalRecord, latestRecord),
  ].every(Boolean);
};
