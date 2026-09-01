import { randomUUID } from "node:crypto";

import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import {
  builderHandoffIdSchema,
  builderHandoffIntentSchema,
  builderHandoffRecordSchema,
  builderHandoffRequestDigest,
  type BuilderHandoffIntent,
  type BuilderHandoffRecord,
} from "./contracts";

type Authority = z.infer<typeof hostedTenantAuthoritySchema>;

export interface BuilderHandoffStore {
  reserve(record: BuilderHandoffRecord): Promise<{
    disposition: "created" | "existing";
    record: BuilderHandoffRecord;
  }>;
  read(input: {
    authority: Authority;
    handoffId: string;
  }): Promise<BuilderHandoffRecord | undefined>;
  bindSession(input: {
    authority: Authority;
    handoffId: string;
    requestDigest: string;
    sessionId: string;
    now: Date;
  }): Promise<BuilderHandoffRecord | undefined>;
}

export class BuilderHandoffUnavailableError extends Error {
  constructor() {
    super("This App Builder handoff is unavailable.");
    this.name = "BuilderHandoffUnavailableError";
  }
}

export class BuilderHandoffConflictError extends Error {
  constructor() {
    super("This App Builder handoff request is already bound.");
    this.name = "BuilderHandoffConflictError";
  }
}

export function builderHandoffPrompt(intentInput: BuilderHandoffIntent) {
  const intent = builderHandoffIntentSchema.parse(intentInput);
  const repository =
    intent.repository.resolvedFullName ?? intent.repository.requestedName;
  return [
    `Create ${intent.appName} with Autograph App Builder.`,
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

export function createBuilderHandoffService(input: {
  store: BuilderHandoffStore;
  now?: () => Date;
  createId?: () => string;
  lifetimeMs?: number;
}) {
  const now = input.now ?? (() => new Date());
  const createId = input.createId ?? randomUUID;
  const lifetimeMs = input.lifetimeMs ?? 7 * 24 * 60 * 60 * 1_000;
  if (
    !Number.isSafeInteger(lifetimeMs) ||
    lifetimeMs < 60_000 ||
    lifetimeMs > 7 * 24 * 60 * 60 * 1_000
  )
    throw new Error("builder-handoff-lifetime-invalid");

  return {
    async create(value: {
      authority: Authority;
      creationRequestId: string;
      intent: BuilderHandoffIntent;
    }) {
      const authority = hostedTenantAuthoritySchema.parse(value.authority);
      const creationRequestId = z
        .string()
        .uuid()
        .parse(value.creationRequestId);
      const intent = builderHandoffIntentSchema.parse(value.intent);
      const requestDigest = builderHandoffRequestDigest({
        authority,
        creationRequestId,
        intent,
      });
      const createdAt = now();
      const candidate = builderHandoffRecordSchema.parse({
        version: 1,
        handoffId: builderHandoffIdSchema.parse(createId()),
        authority,
        creationRequestId,
        requestDigest,
        intent,
        createdAt,
        expiresAt: new Date(createdAt.getTime() + lifetimeMs),
      });
      const reserved = await input.store.reserve(candidate);
      const record = builderHandoffRecordSchema.parse(reserved.record);
      if (
        record.requestDigest !== requestDigest ||
        record.creationRequestId !== creationRequestId
      )
        throw new BuilderHandoffConflictError();
      return {
        handoffId: record.handoffId,
        expiresAt: record.expiresAt,
        disposition: reserved.disposition,
      };
    },

    async resolve(value: { authority: Authority; handoffId: string }) {
      const authority = hostedTenantAuthoritySchema.parse(value.authority);
      const handoffId = builderHandoffIdSchema.parse(value.handoffId);
      const stored = await input.store.read({ authority, handoffId });
      if (!stored) throw new BuilderHandoffUnavailableError();
      const record = builderHandoffRecordSchema.parse(stored);
      if (record.sessionId !== undefined)
        return {
          status: "redeemed" as const,
          sessionId: record.sessionId,
          record,
        };
      if (now() >= record.expiresAt) throw new BuilderHandoffUnavailableError();
      return {
        status: "unredeemed" as const,
        prompt: builderHandoffPrompt(record.intent),
        deterministicClientRequestId: `handoff:${record.requestDigest}`,
        record,
      };
    },

    async bindSession(value: {
      authority: Authority;
      handoffId: string;
      requestDigest: string;
      sessionId: string;
    }) {
      const record = await input.store.bindSession({
        authority: hostedTenantAuthoritySchema.parse(value.authority),
        handoffId: builderHandoffIdSchema.parse(value.handoffId),
        requestDigest: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .parse(value.requestDigest),
        sessionId: z.string().min(1).max(200).parse(value.sessionId),
        now: now(),
      });
      if (!record) throw new BuilderHandoffUnavailableError();
      const parsed = builderHandoffRecordSchema.parse(record);
      if (parsed.sessionId !== value.sessionId)
        throw new BuilderHandoffConflictError();
      return parsed;
    },
  };
}
