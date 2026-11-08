import { z } from "zod";
import {
  repositoryProductionDigest,
  repositoryProductionIntentSchema,
  repositoryProductionOperationRef,
  repositoryProductionScopeSchema,
} from "./repository-production-contract";
import type {
  RepositoryProductionIntent,
  RepositoryProductionScope,
} from "./repository-production-contract";

/** Source commits are diagnostics; consent covers resource, schema and access effects. */
export const repositoryProductionApprovalDigest = (
  scope: RepositoryProductionScope,
  intent: RepositoryProductionIntent,
) =>
  repositoryProductionDigest({
    scope,
    creatorRoles: [...new Set(intent.creatorRoles)].toSorted(),
    // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Preserve conditional fields and evaluation order.
    ...(intent.creatorEmail === undefined
      ? {}
      : { creatorEmail: intent.creatorEmail.toLowerCase() }),
    storage:
      intent.storage.kind === "none"
        ? { kind: "none" }
        : {
            kind: "postgres",
            releaseId: intent.storage.releaseId,
            manifestSha256: intent.storage.manifestSha256,
            databaseEnvironment: intent.storage.databaseEnvironment,
          },
  });
export const repositoryProductionApprovalInputSchema = z
  .strictObject({
    scope: repositoryProductionScopeSchema,
    intent: repositoryProductionIntentSchema,
    operationRef: z.uuid(),
    planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .superRefine((value, ctx) => {
    if (
      value.operationRef !== repositoryProductionOperationRef(value.scope) ||
      value.planDigest !== repositoryProductionApprovalDigest(value.scope, value.intent)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "App setup approval does not match its resources and access.",
      });
    }
  });
export type RepositoryProductionApprovalInput = z.infer<
  typeof repositoryProductionApprovalInputSchema
>;
export const repositoryProductionApprovalInput = (
  scope: RepositoryProductionScope,
  intent: RepositoryProductionIntent,
): RepositoryProductionApprovalInput => ({
  scope,
  intent,
  operationRef: repositoryProductionOperationRef(scope),
  planDigest: repositoryProductionApprovalDigest(scope, intent),
});
