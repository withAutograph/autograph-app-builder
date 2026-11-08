import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import type { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import {
  builderProvisionRequestSchema,
  builderProvisionResponseSchema,
  initialBuilderProvisionResponse,
  vercelProvisionDiagnosticSchema,
} from "./contracts";
import type { BuilderProvisionRequest } from "./contracts";

const storedRequestSchema = z.strictObject({
  appName: z.string().trim().min(1).max(120),
  deploymentAccess: z.literal("public-app").optional(),
  providers: z.strictObject({
    githubInstallationId: z
      .string()
      .regex(/^[1-9][0-9]*$/u)
      .optional(),
    vercelInstallationId: z.string().min(1).max(256).optional(),
  }),
  repository: z.strictObject({
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9._-]+$/u),
    private: z.boolean(),
  }),
  requestId: z.uuid(),
  version: z.literal(1),
});

const operationStateSchema = z.strictObject({
  absentCandidates: z.array(z.string().min(1).max(100)),
  attemptCount: z.number().int().nonnegative().optional(),
  attempted: z.boolean(),
  candidates: z.array(z.string().min(1).max(100)),
  failureDetail: z.string().max(2048).optional(),
  lastProviderDiagnostic: vercelProvisionDiagnosticSchema.optional(),

  leaseExpiresAt: z.iso.datetime({ offset: true }).optional(),
  leaseId: z.uuid().optional(),
  nextRetryAt: z.iso.datetime({ offset: true }).optional(),
  outcomeKnown: z.boolean().optional(),
});

export const builderProvisionJournalRecordSchema = z.strictObject({
  operations: z.strictObject({
    github: operationStateSchema,
    vercel: operationStateSchema,
  }),
  request: storedRequestSchema,
  response: builderProvisionResponseSchema,
  version: z.literal(1),
});

export type BuilderProvisionJournalRecord = z.infer<typeof builderProvisionJournalRecordSchema>;
export type BuilderProvisionAuthority = z.infer<typeof hostedTenantAuthoritySchema>;

export interface BuilderProvisionJournalRow {
  authority: BuilderProvisionAuthority;
  requestId: string;
  requestDigest: string;
  state: "pending" | "settled";
  revision: number;
  record: BuilderProvisionJournalRecord;
  createdAt: Date;
  updatedAt: Date;
}

export interface BuilderProvisionJournalStore {
  /** Exact owner/app/acquired repository identity; at most two rows establish uniqueness. */
  findSettledAppRepository?: (input: {
    authority: BuilderProvisionAuthority;
    appId: string;
    repositoryId: string;
    githubInstallationId: string;
  }) => Promise<readonly BuilderProvisionJournalRow[]>;

  /** Exact owner/app/acquired repository identity; at most two rows establish uniqueness. */

  listDue?: (input: {
    now: Date;
    after?: {
      issuer: string;
      audience: string;
      workspaceId: string;
      ownerUserId: string;
      requestId: string;
    };
    limit: number;
  }) => Promise<{
    items: readonly {
      authority: BuilderProvisionAuthority;
      requestId: string;
      operation: "github" | "vercel";
    }[];
    nextCursor?: {
      issuer: string;
      audience: string;
      workspaceId: string;
      ownerUserId: string;
      requestId: string;
    };
  }>;
  reserve: (input: {
    authority: BuilderProvisionAuthority;
    request: BuilderProvisionRequest;
    now: Date;
  }) => Promise<BuilderProvisionJournalRow>;
  read: (input: {
    authority: BuilderProvisionAuthority;
    requestId: string;
  }) => Promise<BuilderProvisionJournalRow | undefined>;
  compareAndSet: (input: {
    authority: BuilderProvisionAuthority;
    requestId: string;
    expectedRevision: number;
    record: BuilderProvisionJournalRecord;
    now: Date;
  }) => Promise<BuilderProvisionJournalRow | undefined>;
}

export const initialBuilderProvisionJournalRecord = (
  requestInput: BuilderProvisionRequest,
  now: Date,
): BuilderProvisionJournalRecord => {
  const request = builderProvisionRequestSchema.parse(requestInput);
  const parse = builderProvisionJournalRecordSchema.parse.bind(builderProvisionJournalRecordSchema);
  const operations = {
    github: { absentCandidates: [], attempted: false, candidates: [] },
    vercel: { absentCandidates: [], attempted: false, candidates: [] },
  };
  const requestHead: Pick<BuilderProvisionRequest, "appName" | "deploymentAccess"> = {
    appName: request.appName,
  };
  if (request.deploymentAccess !== undefined) {
    requestHead.deploymentAccess = request.deploymentAccess;
  }
  return parse({
    operations,
    request: {
      ...requestHead,
      providers: request.providers,
      repository: request.repository,
      requestId: request.requestId,
      version: request.version,
    },
    response: initialBuilderProvisionResponse(request, now),
    version: 1,
  });
};

const operationSettled = (
  record: BuilderProvisionJournalRecord,
  operation: "github" | "vercel",
) => {
  const selected =
    operation === "github"
      ? record.request.providers.githubInstallationId !== undefined
      : record.request.providers.vercelInstallationId !== undefined;
  return !selected || record.operations[operation].attempted;
};

export const updateBuilderProvisionJournal = async (input: {
  store: BuilderProvisionJournalStore;
  authority: BuilderProvisionAuthority;
  requestId: string;
  now?: () => number;
  update: (current: BuilderProvisionJournalRecord) => BuilderProvisionJournalRecord;
}): Promise<BuilderProvisionJournalRow> => {
  for (let attempt = 0; ; attempt += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    const current = await input.store.read({
      authority: input.authority,
      requestId: input.requestId,
    });
    if (!current) {
      throw new Error("provision-journal-missing");
    }
    const next = builderProvisionJournalRecordSchema.parse(
      input.update(structuredClone(current.record)),
    );
    const updatedAt = new Date(input.now?.() ?? Date.now());
    next.response.updatedAt = updatedAt.toISOString();
    next.response.status =
      operationSettled(next, "github") && operationSettled(next, "vercel") ? "settled" : "pending";
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    const saved = await input.store.compareAndSet({
      authority: input.authority,
      expectedRevision: current.revision,
      now: updatedAt,
      record: next,
      requestId: input.requestId,
    });
    if (saved) {
      return saved;
    }
    // Yield under contention rather than exhausting an arbitrary retry budget.
    // oxlint-disable-next-line eslint/no-await-in-loop -- each retry follows a failed compare-and-set
    await delay(Math.min(250, 5 * 2 ** Math.min(attempt, 6)));
  }
};
