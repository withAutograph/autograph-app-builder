import { createHash } from "node:crypto";

import { defineState } from "eve/context";
import { z } from "zod";

import type { RepositoryAccessResult } from "../integrations/repository-access";
import type { ImmutableGitHubSourceReceipt } from "../repository/github-publication";

export const REPOSITORY_ACCESS_RECEIPT_VERSION = 1 as const;

const decimal = z.string().regex(/^[1-9][0-9]*$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const repositoryPart = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/u);

const repositoryAccessReceiptUnsignedSchema = z.strictObject({
  confirmedByCallId: z.string().min(1).max(255),
  providerAccessDigest: digest,
  repository: z.strictObject({
    repositoryId: decimal,
    owner: repositoryPart,
    name: repositoryPart,
    defaultBranch: z.string().min(1).max(255),
    headSha: objectId,
    headTree: objectId,
  }),
  scope: z.strictObject({
    installationId: decimal,
    accountLogin: z.string().min(1).max(100),
    accountType: z.enum(["Organization", "User"]),
  }),
  sessionId: z.string().min(1).max(255),
  version: z.literal(REPOSITORY_ACCESS_RECEIPT_VERSION),
});

const receiptDigest = (
  value: z.infer<typeof repositoryAccessReceiptUnsignedSchema>
) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const repositoryAccessReceiptSchema =
  repositoryAccessReceiptUnsignedSchema
    .extend({ digest })
    .superRefine((value, context) => {
      const { digest: actualDigest, ...unsigned } = value;
      if (actualDigest !== receiptDigest(unsigned)) {
        context.addIssue({
          code: "custom",
          path: ["digest"],
          message: "Repository access receipt digest is invalid.",
        });
      }
    });

export type RepositoryAccessReceipt = z.infer<
  typeof repositoryAccessReceiptSchema
>;
type ReadyRepositoryAccess = Extract<
  RepositoryAccessResult,
  { status: "ready" }
>;

function receiptObservation(input: {
  sessionId: string;
  access: ReadyRepositoryAccess;
}) {
  return {
    providerAccessDigest: input.access.accessDigest,
    repository: {
      defaultBranch: input.access.repository.defaultBranch,
      headSha: input.access.repository.headSha,
      headTree: input.access.repository.headTree,
      name: input.access.repository.name,
      owner: input.access.repository.owner,
      repositoryId: input.access.repository.repositoryId,
    },
    scope: input.access.scope,
    sessionId: input.sessionId,
    version: REPOSITORY_ACCESS_RECEIPT_VERSION,
  } as const;
}

export function recordRepositoryAccessReceipt(input: {
  current: RepositoryAccessReceipt | undefined;
  sessionId: string;
  confirmedByCallId: string;
  access: ReadyRepositoryAccess;
}): RepositoryAccessReceipt {
  const observation = receiptObservation(input);
  const current =
    input.current === undefined
      ? undefined
      : repositoryAccessReceiptSchema.parse(input.current);
  if (current !== undefined && current.sessionId !== input.sessionId) {
    throw new Error("Repository access state belongs to a different session.");
  }
  if (
    current !== undefined &&
    JSON.stringify({
      providerAccessDigest: current.providerAccessDigest,
      repository: current.repository,
      scope: current.scope,
      sessionId: current.sessionId,
      version: current.version,
    }) === JSON.stringify(observation)
  ) {
    return current;
  }

  const unsigned = repositoryAccessReceiptUnsignedSchema.parse({
    ...observation,
    confirmedByCallId: input.confirmedByCallId,
  });
  return repositoryAccessReceiptSchema.parse({
    ...unsigned,
    digest: receiptDigest(unsigned),
  });
}

export function assertRepositoryAccessReceiptForSource(input: {
  receipt: RepositoryAccessReceipt | undefined;
  expectedDigest: string;
  sessionId: string;
  repositoryId: string;
  ref: string;
  expectedSha: string;
  expectedTree: string;
}): RepositoryAccessReceipt {
  if (input.receipt === undefined) {
    throw new Error("No confirmed repository access receipt is available.");
  }
  const receipt = repositoryAccessReceiptSchema.parse(input.receipt);
  if (
    receipt.digest !== input.expectedDigest ||
    receipt.sessionId !== input.sessionId ||
    receipt.repository.repositoryId !== input.repositoryId ||
    `refs/heads/${receipt.repository.defaultBranch}` !== input.ref ||
    receipt.repository.headSha !== input.expectedSha ||
    receipt.repository.headTree !== input.expectedTree
  ) {
    throw new Error(
      "The repository access receipt does not match this session and source."
    );
  }
  return receipt;
}

export function assertResolvedSourceMatchesRepositoryAccess(input: {
  access: RepositoryAccessReceipt;
  source: ImmutableGitHubSourceReceipt;
}): void {
  const access = repositoryAccessReceiptSchema.parse(input.access);
  const { repository } = input.source;
  if (
    repository.repositoryId !== access.repository.repositoryId ||
    repository.owner !== access.repository.owner ||
    repository.name !== access.repository.name ||
    repository.defaultBranch !== access.repository.defaultBranch ||
    repository.headSha !== access.repository.headSha ||
    repository.headTree !== access.repository.headTree ||
    input.source.resolvedRef !==
      `refs/heads/${access.repository.defaultBranch}` ||
    input.source.resolvedSha !== access.repository.headSha ||
    input.source.resolvedTree !== access.repository.headTree
  ) {
    throw new Error(
      "The live GitHub source does not match the confirmed repository access receipt."
    );
  }
}

export const repositoryAccessReceiptState = defineState<
  RepositoryAccessReceipt | undefined
>("autograph-app-builder.repository-access.v1", () => {});
