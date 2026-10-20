import { z } from "zod";
import {
  encryptVercelToken,
  decryptVersionedVercelToken,
} from "../integrations/vercel-installation";
import type { VercelTokenKeyringConfig } from "../integrations/vercel-installation";
import { continuityCapabilitiesSchema } from "./hosted-operator-continuity-contract";
import type {
  ContinuityRecord,
  ContinuityCapabilities,
} from "./hosted-operator-continuity-contract";

const associatedData = (record: ContinuityRecord) =>
  JSON.stringify([
    "managed-app-continuity-capabilities-v1",
    record.plan.authority.issuer,
    record.plan.authority.audience,
    record.plan.authority.workspaceId,
    record.plan.authority.ownerUserId,
    record.plan.target.sessionId,
    record.plan.target.appId,
    record.requestId,
    record.attemptId,
    record.fence,
    record.plan.originalSetup.operationRef,
    record.planDigest,
  ]);
export const createContinuityCapabilityCustody = (config: VercelTokenKeyringConfig) => ({
  seal(record: ContinuityRecord, capabilities: ContinuityCapabilities) {
    z.uuid().parse(record.attemptId);
    return {
      ...encryptVercelToken({
        associatedData: associatedData(record),
        key: config.tokenKey,
        token: JSON.stringify(continuityCapabilitiesSchema.parse(capabilities)),
      }),
      keyVersion: config.tokenKeyVersion,
    };
  },
  unseal(record: ContinuityRecord) {
    if (record.privateState === undefined) {
      throw new Error("Continuity private capability is unavailable.");
    }
    return continuityCapabilitiesSchema.parse(
      JSON.parse(
        decryptVersionedVercelToken({
          ...record.privateState,
          associatedData: associatedData(record),
          config,
        }),
      ),
    );
  },
});
