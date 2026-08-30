import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import {
  builderProvisionRequestSchema,
  builderProvisionResponseSchema,
  initialBuilderProvisionResponse,
  type BuilderProvisionRequest,
} from "./contracts";

const storedRequestSchema = z
  .object({
    version: z.literal(1),
    requestId: z.string().uuid(),
    appName: z.string().trim().min(1).max(120),
    repository: z
      .object({
        name: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^[A-Za-z0-9._-]+$/u),
        private: z.boolean(),
      })
      .strict(),
    providers: z
      .object({
        githubInstallationId: z
          .string()
          .regex(/^[1-9][0-9]*$/u)
          .optional(),
        vercelInstallationId: z.string().min(1).max(256).optional(),
      })
      .strict(),
  })
  .strict();

const operationStateSchema = z
  .object({
    attempted: z.boolean(),
    candidates: z.array(z.string().min(1).max(100)).max(5),
    absentCandidates: z.array(z.string().min(1).max(100)).max(5),
    leaseId: z.string().uuid().optional(),
    leaseExpiresAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const builderProvisionJournalRecordSchema = z
  .object({
    version: z.literal(1),
    request: storedRequestSchema,
    response: builderProvisionResponseSchema,
    operations: z
      .object({
        github: operationStateSchema,
        vercel: operationStateSchema,
      })
      .strict(),
  })
  .strict();

export type BuilderProvisionJournalRecord = z.infer<
  typeof builderProvisionJournalRecordSchema
>;
export type BuilderProvisionAuthority = z.infer<
  typeof hostedTenantAuthoritySchema
>;

export type BuilderProvisionJournalRow = {
  authority: BuilderProvisionAuthority;
  requestId: string;
  requestDigest: string;
  state: "pending" | "settled";
  revision: number;
  record: BuilderProvisionJournalRecord;
  createdAt: Date;
  updatedAt: Date;
};

export interface BuilderProvisionJournalStore {
  reserve(input: {
    authority: BuilderProvisionAuthority;
    request: BuilderProvisionRequest;
    now: Date;
  }): Promise<BuilderProvisionJournalRow>;
  read(input: {
    authority: BuilderProvisionAuthority;
    requestId: string;
  }): Promise<BuilderProvisionJournalRow | undefined>;
  compareAndSet(input: {
    authority: BuilderProvisionAuthority;
    requestId: string;
    expectedRevision: number;
    record: BuilderProvisionJournalRecord;
    now: Date;
  }): Promise<BuilderProvisionJournalRow | undefined>;
}

export function initialBuilderProvisionJournalRecord(
  requestInput: BuilderProvisionRequest,
  now: Date,
): BuilderProvisionJournalRecord {
  const request = builderProvisionRequestSchema.parse(requestInput);
  return builderProvisionJournalRecordSchema.parse({
    version: 1,
    request: {
      version: request.version,
      requestId: request.requestId,
      appName: request.appName,
      repository: request.repository,
      providers: request.providers,
    },
    response: initialBuilderProvisionResponse(request, now),
    operations: {
      github: { attempted: false, candidates: [], absentCandidates: [] },
      vercel: { attempted: false, candidates: [], absentCandidates: [] },
    },
  });
}

export async function updateBuilderProvisionJournal(input: {
  store: BuilderProvisionJournalStore;
  authority: BuilderProvisionAuthority;
  requestId: string;
  now?: () => number;
  update: (
    current: BuilderProvisionJournalRecord,
  ) => BuilderProvisionJournalRecord;
}): Promise<BuilderProvisionJournalRow> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await input.store.read({
      authority: input.authority,
      requestId: input.requestId,
    });
    if (!current) throw new Error("provision-journal-missing");
    const next = builderProvisionJournalRecordSchema.parse(
      input.update(structuredClone(current.record)),
    );
    const updatedAt = new Date(input.now?.() ?? Date.now());
    next.response.updatedAt = updatedAt.toISOString();
    next.response.status =
      operationSettled(next, "github") && operationSettled(next, "vercel")
        ? "settled"
        : "pending";
    const saved = await input.store.compareAndSet({
      authority: input.authority,
      requestId: input.requestId,
      expectedRevision: current.revision,
      record: next,
      now: updatedAt,
    });
    if (saved) return saved;
  }
  throw new Error("provision-journal-contention");
}

function operationSettled(
  record: BuilderProvisionJournalRecord,
  operation: "github" | "vercel",
) {
  const selected =
    operation === "github"
      ? record.request.providers.githubInstallationId !== undefined
      : record.request.providers.vercelInstallationId !== undefined;
  return !selected || record.operations[operation].attempted;
}
