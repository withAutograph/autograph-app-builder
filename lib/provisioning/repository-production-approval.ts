import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { appAccessIntentSchema, resolveAppAccessIntent } from "../agent/app-access-intent";
import type { DirectProductionSubject } from "../agent/direct-production-authorization";
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
) => {
  const signup: Pick<RepositoryProductionIntent, "access" | "entryPath"> = {};
  if (intent.access?.mode === "self-signup") {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Approval canonicalization has no inherited selection.
    signup.access = resolveAppAccessIntent(intent.access, undefined) ?? intent.access;
    if (intent.entryPath !== undefined) {
      signup.entryPath = intent.entryPath;
    }
  }
  return repositoryProductionDigest({
    scope,
    creatorRoles: [...new Set(intent.creatorRoles)].toSorted(),
    // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Preserve conditional fields and evaluation order.
    ...(intent.creatorEmail === undefined
      ? {}
      : { creatorEmail: intent.creatorEmail.toLowerCase() }),
    ...signup,
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
};
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

/** A server-derived setup reference keeps database release details out of model input. */
export const repositoryProductionApprovalReferenceSchema = z.strictObject({
  version: z.literal(2),
  appId: repositoryProductionScopeSchema.shape.appId,
  repositoryId: repositoryProductionScopeSchema.shape.repositoryId,
  operationRef: z.uuid(),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  review: z.strictObject({
    repositoryFullName: repositoryProductionScopeSchema.shape.repositoryFullName,
    storageKind: z.enum(["none", "postgres"]),
    creatorRoles: z.array(z.string().min(1)),
    creatorEmail: z.email().optional(),
    access: appAccessIntentSchema,
  }),
});
export type RepositoryProductionApprovalReference = z.infer<
  typeof repositoryProductionApprovalReferenceSchema
>;

export const repositoryProductionPrepareInputSchema = z.union([
  repositoryProductionApprovalReferenceSchema,
  repositoryProductionApprovalInputSchema,
]);
export type RepositoryProductionPrepareInput = z.infer<
  typeof repositoryProductionPrepareInputSchema
>;

export const repositoryProductionApprovalReference = (
  input: RepositoryProductionApprovalInput,
): RepositoryProductionApprovalReference => {
  const plan = repositoryProductionApprovalInputSchema.parse(input);
  const review: RepositoryProductionApprovalReference["review"] = {
    repositoryFullName: plan.scope.repositoryFullName,
    storageKind: plan.intent.storage.kind,
    creatorRoles: [...new Set(plan.intent.creatorRoles)].toSorted(),
    // oxlint-disable-next-line unicorn/no-useless-undefined -- A new review has no inherited access selection.
    access: resolveAppAccessIntent(plan.intent.access, undefined) ?? { mode: "private" },
  };
  if (plan.intent.creatorEmail !== undefined) {
    review.creatorEmail = plan.intent.creatorEmail;
  }
  return {
    version: 2,
    appId: plan.scope.appId,
    repositoryId: plan.scope.repositoryId,
    operationRef: plan.operationRef,
    planDigest: plan.planDigest,
    review,
  };
};

/** Combined delivery consent covers only the resolved private app and its declared storage. */
export const matchesDirectProductionSetupReference = (
  subject: DirectProductionSubject,
  reference: RepositoryProductionApprovalReference,
): boolean =>
  [
    reference.appId === subject.appId,
    reference.repositoryId === subject.repositoryId,
    reference.review.repositoryFullName === subject.repositoryFullName,
    reference.review.storageKind === subject.storageKind,
    reference.review.access.mode === "private",
  ].every(Boolean);

/** Compare against the freshly resolved owner-scoped plan before observing approval or writes. */
export const assertRepositoryProductionApprovalReference = (
  plan: RepositoryProductionApprovalInput,
  reference: RepositoryProductionApprovalReference,
) => {
  if (!isDeepStrictEqual(reference, repositoryProductionApprovalReference(plan))) {
    throw new Error("repository_production_approval_required");
  }
};

export const repositoryProductionApprovalInput = (
  scope: RepositoryProductionScope,
  intent: RepositoryProductionIntent,
): RepositoryProductionApprovalInput => ({
  scope,
  intent,
  operationRef: repositoryProductionOperationRef(scope),
  planDigest: repositoryProductionApprovalDigest(scope, intent),
});
