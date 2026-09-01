import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import {
  parseRepositoryReference,
  type RepositoryReference,
} from "./repository-access";

const decimal = z.string().regex(/^[1-9][0-9]*$/u);
const continuationIdSchema = z.string().uuid();
const opaqueRuntimeId = z.string().min(1).max(255);

export const repositoryAccessContinuationSchema = z
  .object({
    continuationDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    authority: hostedTenantAuthoritySchema,
    sessionId: opaqueRuntimeId,
    requestId: opaqueRuntimeId,
    repository: z
      .object({
        owner: z.string().min(1).max(100),
        name: z.string().min(1).max(100),
        fullName: z.string().min(3).max(201),
      })
      .strict(),
    selectedInstallationId: decimal.optional(),
    callbackUrl: z.string().url().max(4_096),
    createdAt: z.date(),
    expiresAt: z.date(),
    authorizedAt: z.date().optional(),
    consumedAt: z.date().optional(),
  })
  .strict();

export type RepositoryAccessContinuation = z.infer<
  typeof repositoryAccessContinuationSchema
>;

export interface RepositoryAccessContinuationStore {
  create(record: RepositoryAccessContinuation): Promise<void>;
  authorize(input: {
    continuationDigest: string;
    authority: z.infer<typeof hostedTenantAuthoritySchema>;
    now: Date;
  }): Promise<RepositoryAccessContinuation | undefined>;
  consume(input: {
    continuationDigest: string;
    authority: z.infer<typeof hostedTenantAuthoritySchema>;
    sessionId: string;
    requestId: string;
    repository: RepositoryReference;
    selectedInstallationId?: string;
    now: Date;
  }): Promise<RepositoryAccessContinuation | undefined>;
  listAuthorizedForSession(input: {
    authority: z.infer<typeof hostedTenantAuthoritySchema>;
    sessionId: string;
    now: Date;
  }): Promise<RepositoryAccessContinuation[]>;
}

const continuationDigest = (continuationId: string) =>
  createHash("sha256").update(continuationId).digest("hex");

function exactEveAuthorizationCallback(input: {
  callbackUrl: string;
  issuer: string;
}) {
  const callback = new URL(input.callbackUrl);
  const issuer = new URL(input.issuer);
  const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
  const allowedOrigin =
    callback.origin === issuer.origin ||
    (callback.protocol === "http:" && loopback.has(callback.hostname));
  if (
    !allowedOrigin ||
    callback.username ||
    callback.password ||
    callback.hash ||
    callback.search ||
    !/^\/eve\/v1\/connections\/[^/]+\/callback\/[^/]+\/[^/]+$/u.test(
      callback.pathname,
    )
  ) {
    throw new Error("repository-access-callback-invalid");
  }
  return callback;
}

export function createRepositoryAccessContinuationService(input: {
  store: RepositoryAccessContinuationStore;
  now?: () => Date;
  createId?: () => string;
  lifetimeMs?: number;
}) {
  const now = input.now ?? (() => new Date());
  const createId = input.createId ?? randomUUID;
  const lifetimeMs = input.lifetimeMs ?? 10 * 60 * 1_000;
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 60_000)
    throw new Error("repository-access-continuation-lifetime-invalid");

  return {
    async create(value: {
      authority: z.infer<typeof hostedTenantAuthoritySchema>;
      sessionId: string;
      requestId: string;
      repository: string;
      selectedInstallationId?: string;
      callbackUrl: string;
    }) {
      const authority = hostedTenantAuthoritySchema.parse(value.authority);
      const repository = parseRepositoryReference(value.repository);
      const callback = exactEveAuthorizationCallback({
        callbackUrl: value.callbackUrl,
        issuer: authority.issuer,
      });
      const continuationId = continuationIdSchema.parse(createId());
      const createdAt = now();
      const expiresAt = new Date(createdAt.getTime() + lifetimeMs);
      const record = repositoryAccessContinuationSchema.parse({
        continuationDigest: continuationDigest(continuationId),
        authority,
        sessionId: value.sessionId,
        requestId: value.requestId,
        repository,
        ...(value.selectedInstallationId
          ? {
              selectedInstallationId: decimal.parse(
                value.selectedInstallationId,
              ),
            }
          : {}),
        callbackUrl: callback.toString(),
        createdAt,
        expiresAt,
      });
      await input.store.create(record);
      return { continuationId, expiresAt };
    },

    async authorize(value: {
      authority: z.infer<typeof hostedTenantAuthoritySchema>;
      continuationId: string;
    }) {
      const continuationId = continuationIdSchema.parse(value.continuationId);
      const record = await input.store.authorize({
        continuationDigest: continuationDigest(continuationId),
        authority: hostedTenantAuthoritySchema.parse(value.authority),
        now: now(),
      });
      if (!record) return undefined;
      const callback = new URL(record.callbackUrl);
      callback.searchParams.set("provider", "github");
      callback.searchParams.set("status", "connected");
      return callback.toString();
    },

    async consume(value: {
      authority: z.infer<typeof hostedTenantAuthoritySchema>;
      continuationId: string;
      sessionId: string;
      requestId: string;
      repository: string;
      selectedInstallationId?: string;
    }) {
      const continuationId = continuationIdSchema.parse(value.continuationId);
      return input.store.consume({
        continuationDigest: continuationDigest(continuationId),
        authority: hostedTenantAuthoritySchema.parse(value.authority),
        sessionId: opaqueRuntimeId.parse(value.sessionId),
        requestId: opaqueRuntimeId.parse(value.requestId),
        repository: parseRepositoryReference(value.repository),
        ...(value.selectedInstallationId
          ? {
              selectedInstallationId: decimal.parse(
                value.selectedInstallationId,
              ),
            }
          : {}),
        now: now(),
      });
    },

    async authorizedForSession(value: {
      authority: z.infer<typeof hostedTenantAuthoritySchema>;
      sessionId: string;
    }) {
      const authority = hostedTenantAuthoritySchema.parse(value.authority);
      const records = await input.store.listAuthorizedForSession({
        authority,
        sessionId: opaqueRuntimeId.parse(value.sessionId),
        now: now(),
      });
      return records.map((candidate) => ({
        record: repositoryAccessContinuationSchema.parse(candidate),
        callbackUrl: exactEveAuthorizationCallback({
          callbackUrl: candidate.callbackUrl,
          issuer: authority.issuer,
        }).toString(),
      }));
    },
  };
}
