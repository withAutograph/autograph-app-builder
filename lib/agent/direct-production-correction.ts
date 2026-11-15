import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import { directProductionSubjectSchema } from "./direct-production-authorization";
import type {
  DirectProductionGrant,
  DirectProductionSubject,
} from "./direct-production-authorization";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const releaseIdentity = z.strictObject({
  releaseId: z.string().min(1),
  artifactSha256: digest,
  manifestSha256: digest,
});

const correctionBody = z.strictObject({
  version: z.literal(1),
  originalGrantDigest: digest,
  correctedSubject: directProductionSubjectSchema,
  installed: releaseIdentity.extend({ cueSha256: digest }),
  candidate: releaseIdentity,
  regeneratedFrom: z
    .strictObject({
      headTree: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
      manifestSha256: digest,
    })
    .optional(),
});

const hash = (body: z.input<typeof correctionBody>) =>
  createHash("sha256")
    .update(JSON.stringify(correctionBody.parse(body)))
    .digest("hex");

export const directProductionCorrectionSchema = correctionBody
  .extend({ digest })
  .refine(({ digest: actual, ...body }) => hash(body) === actual);

export type DirectProductionCorrection = z.infer<typeof directProductionCorrectionSchema>;

export const createDirectProductionCorrection = (body: z.input<typeof correctionBody>) =>
  directProductionCorrectionSchema.parse({ ...body, digest: hash(body) });

/** The settled grant is immutable. A checked correction can change only its schema proof and draft head. */
export const readDirectProductionCorrection = (
  grant: DirectProductionGrant | undefined,
  correction: DirectProductionCorrection | undefined,
): DirectProductionCorrection | undefined => {
  if (grant === undefined || correction?.originalGrantDigest !== grant.digest) {
    return undefined;
  }
  const { correctedSubject, installed, candidate, regeneratedFrom } = correction;
  const prior = grant.subject.revision;
  const corrected = correctedSubject.revision;
  if (
    prior?.schemaChange === undefined ||
    corrected?.reconciliation === undefined ||
    corrected.schemaChange === undefined
  ) {
    return undefined;
  }
  if (
    installed.cueSha256 !== corrected.schemaChange.priorCueSha256 ||
    installed.releaseId === candidate.releaseId
  ) {
    return undefined;
  }
  const { reconciliation: previousDraft } = prior;
  const { reconciliation: nextDraft } = corrected;
  if (regeneratedFrom === undefined) {
    if (
      previousDraft !== undefined ||
      corrected.schemaChange.priorCueSha256 === prior.schemaChange.priorCueSha256 ||
      corrected.schemaChange.candidateCueSha256 === prior.schemaChange.candidateCueSha256
    ) {
      return undefined;
    }
  } else if (
    !isDeepStrictEqual(corrected.schemaChange, prior.schemaChange) ||
    regeneratedFrom.manifestSha256 === candidate.manifestSha256 ||
    (previousDraft !== undefined &&
      ![
        regeneratedFrom.headTree === previousDraft.resolvedTree,
        previousDraft.pullRequestNumber === nextDraft.pullRequestNumber,
        previousDraft.originPublicationDigest === nextDraft.originPublicationDigest,
        previousDraft.originPublicationReceiptDigest === nextDraft.originPublicationReceiptDigest,
      ].every(Boolean))
  ) {
    return undefined;
  }
  const originalSubject: DirectProductionSubject = {
    ...correctedSubject,
    revision: {
      priorGrantDigest: corrected.priorGrantDigest,
      priorProposalDigest: corrected.priorProposalDigest,
      schemaChange: prior.schemaChange,
    },
  };
  if (previousDraft !== undefined && originalSubject.revision !== undefined) {
    originalSubject.revision.reconciliation = previousDraft;
  }
  return isDeepStrictEqual(originalSubject, grant.subject) ? correction : undefined;
};

export const directProductionEffectDigest = (
  grant: DirectProductionGrant,
  correction: DirectProductionCorrection | undefined,
): string => readDirectProductionCorrection(grant, correction)?.digest ?? grant.digest;
