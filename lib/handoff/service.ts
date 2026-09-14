import { randomUUID } from "node:crypto";

import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import {
  builderHandoffIdSchema,
  builderHandoffIntentSchema,
  builderHandoffRecordSchema,
  builderHandoffRequestDigest,
} from "./contracts";
import type { BuilderHandoffIntent, BuilderHandoffRecord } from "./contracts";
import { BuilderHandoffConflictError, BuilderHandoffUnavailableError } from "./errors";

export { BuilderHandoffConflictError, BuilderHandoffUnavailableError } from "./errors";

type Authority = z.infer<typeof hostedTenantAuthoritySchema>;

export interface BuilderHandoffStore {
  reserve: (record: BuilderHandoffRecord) => Promise<{
    disposition: "created" | "existing";
    record: BuilderHandoffRecord;
  }>;
  read: (input: {
    authority: Authority;
    handoffId: string;
  }) => Promise<BuilderHandoffRecord | undefined>;
  /**
   * Returns the most recently updated handoff whose durable provisioning
   * journal remains pending for this exact tenant authority.
   */
  findLatestPending?: (input: {
    authority: Authority;
  }) => Promise<BuilderHandoffRecord | undefined>;
  renewExpired?: (input: {
    authority: Authority;
    handoffId: string;
    requestDigest: string;
    now: Date;
    expiresAt: Date;
  }) => Promise<
    | {
        disposition: "renewed" | "existing";
        record: BuilderHandoffRecord;
      }
    | undefined
  >;
  bindSession: (input: {
    authority: Authority;
    handoffId: string;
    requestDigest: string;
    sessionId: string;
    now: Date;
  }) => Promise<BuilderHandoffRecord | undefined>;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function requireOwnedRecord(
  value: unknown,
  expected: { authority: Authority; handoffId?: string },
) {
  const parsed = builderHandoffRecordSchema.safeParse(value);
  if (!parsed.success) {throw new BuilderHandoffUnavailableError();}
  const record = parsed.data;
  if (
    (expected.handoffId !== undefined && record.handoffId !== expected.handoffId) ||
    record.authority.issuer !== expected.authority.issuer ||
    record.authority.audience !== expected.authority.audience ||
    record.authority.workspaceId !== expected.authority.workspaceId ||
    record.authority.ownerUserId !== expected.authority.ownerUserId
  )
    {throw new BuilderHandoffUnavailableError();}
  return record;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function builderHandoffPrompt(intentInput: BuilderHandoffIntent) {
  const intent = builderHandoffIntentSchema.parse(intentInput);
  const repository = intent.repository.resolvedFullName ?? intent.repository.requestedName;
  return [
    `Create ${intent.appName} with Autograph App Builder.`,
    "Call prepared-app-context before any provider work to recover the prepared app and its existing connections. Reuse those connections and resources through server-owned operations.",
    `App id: ${intent.appId}`,
    `Requested repository: ${repository}`,
    `Model preference: ${intent.modelId}`,
    intent.connections.length === 0
      ? undefined
      : `Requested connections: ${intent.connections.join(", ")}`,
    "Product brief:",
    intent.brief,
    "Before inspecting or publishing repository content, resolve current repository access through the server-owned repository access operation. Treat the requested repository as intent, not proof of provider authority.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n\n");
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createBuilderHandoffService(input: {
  store: BuilderHandoffStore;
  now?: () => Date;
  createId?: () => string;
  lifetimeMs?: number;
}) {
  const now = input.now ?? (() => new Date());
  const createId = input.createId ?? randomUUID;
  const lifetimeMs = input.lifetimeMs ?? 7 * 24 * 60 * 60 * 1000;
  if (
    !Number.isSafeInteger(lifetimeMs) ||
    lifetimeMs < 60_000 ||
    lifetimeMs > 7 * 24 * 60 * 60 * 1000
  )
    {throw new Error("builder-handoff-lifetime-invalid");}

  const read = async (value: { authority: Authority; handoffId: string }) => {
    const authority = hostedTenantAuthoritySchema.parse(value.authority);
    const parsedId = builderHandoffIdSchema.safeParse(value.handoffId);
    if (!parsedId.success) {throw new BuilderHandoffUnavailableError();}
    const stored = await input.store.read({
      authority,
      handoffId: parsedId.data,
    });
    if (!stored) {throw new BuilderHandoffUnavailableError();}
    return requireOwnedRecord(stored, { authority, handoffId: parsedId.data });
  };

  const service = {
    async bindSession(value: {
      authority: Authority;
      handoffId: string;
      requestDigest: string;
      sessionId: string;
    }) {
      const record = await input.store.bindSession({
        authority: hostedTenantAuthoritySchema.parse(value.authority),
        handoffId: builderHandoffIdSchema.parse(value.handoffId),
        now: now(),
        requestDigest: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .parse(value.requestDigest),
        sessionId: z.string().min(1).max(200).parse(value.sessionId),
      });
      if (!record) {throw new BuilderHandoffUnavailableError();}
      const parsed = requireOwnedRecord(record, value);
      if (parsed.requestDigest !== value.requestDigest || parsed.sessionId !== value.sessionId)
        {throw new BuilderHandoffConflictError();}
      return parsed;
    },

    async create(value: {
      authority: Authority;
      creationRequestId: string;
      intent: BuilderHandoffIntent;
    }) {
      const authority = hostedTenantAuthoritySchema.parse(value.authority);
      const creationRequestId = z.string().uuid().parse(value.creationRequestId);
      const intent = builderHandoffIntentSchema.parse(value.intent);
      const requestDigest = builderHandoffRequestDigest({
        authority,
        creationRequestId,
        intent,
      });
      const createdAt = now();
      const candidate = builderHandoffRecordSchema.parse({
        authority,
        createdAt,
        creationRequestId,
        expiresAt: new Date(createdAt.getTime() + lifetimeMs),
        handoffId: builderHandoffIdSchema.parse(createId()),
        intent,
        requestDigest,
        version: 1,
      });
      const reserved = await input.store.reserve(candidate);
      const record = requireOwnedRecord(reserved.record, {
        authority,
        ...(reserved.disposition === "created" ? { handoffId: candidate.handoffId } : {}),
      });
      if (record.requestDigest !== requestDigest || record.creationRequestId !== creationRequestId)
        {throw new BuilderHandoffConflictError();}
      return {
        disposition: reserved.disposition,
        expiresAt: record.expiresAt,
        handoffId: record.handoffId,
      };
    },

    async findLatestPending(value: { authority: Authority }) {
      const authority = hostedTenantAuthoritySchema.parse(value.authority);
      if (!input.store.findLatestPending) {return;}
      const stored = await input.store.findLatestPending({ authority });
      return stored ? requireOwnedRecord(stored, { authority }) : undefined;
    },

    // Owner reads intentionally survive expiry; starting still uses resolve.
    read,

    async renew(value: { authority: Authority; handoffId: string; creationRequestId: string }) {
      z.string().uuid().parse(value.creationRequestId);
      const record = await read(value);
      const timestamp = now();
      if (record.sessionId !== undefined || timestamp < record.expiresAt)
        {return {
          disposition: "existing" as const,
          expiresAt: record.expiresAt,
          handoffId: record.handoffId,
        };}

      // Renew the same start identity: a durable start may have succeeded before
      // its bind reply was lost at expiry. A successor would launch a second app.
      if (!input.store.renewExpired) {throw new BuilderHandoffUnavailableError();}
      const renewed = await input.store.renewExpired({
        authority: record.authority,
        expiresAt: new Date(timestamp.getTime() + lifetimeMs),
        handoffId: record.handoffId,
        now: timestamp,
        requestDigest: record.requestDigest,
      });
      if (!renewed) {throw new BuilderHandoffUnavailableError();}
      const parsed = requireOwnedRecord(renewed.record, value);
      if (
        parsed.requestDigest !== record.requestDigest ||
        parsed.creationRequestId !== record.creationRequestId
      )
        {throw new BuilderHandoffConflictError();}
      if (parsed.sessionId === undefined && now() >= parsed.expiresAt)
        {throw new BuilderHandoffUnavailableError();}
      return {
        disposition: renewed.disposition,
        expiresAt: parsed.expiresAt,
        handoffId: parsed.handoffId,
      };
    },

    async resolve(value: { authority: Authority; handoffId: string }) {
      const record = await read(value);
      if (record.sessionId !== undefined)
        {return {
          record,
          sessionId: record.sessionId,
          status: "redeemed" as const,
        };}
      if (now() >= record.expiresAt) {throw new BuilderHandoffUnavailableError();}
      return {
        deterministicClientRequestId: `handoff:${record.requestDigest}`,
        prompt: builderHandoffPrompt(record.intent),
        record,
        status: "unredeemed" as const,
      };
    },

    async status(value: { authority: Authority; handoffId: string }) {
      const record = await read(value);
      let status: "continued" | "expired" | "prepared";
      if (record.sessionId !== undefined) {
        status = "continued";
      } else if (now() >= record.expiresAt) {
        status = "expired";
      } else {
        status = "prepared";
      }
      return { record, status };
    },
  };
  return service;
}
