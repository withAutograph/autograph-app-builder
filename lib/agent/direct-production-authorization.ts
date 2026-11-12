import { createHash } from "node:crypto";
import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";

const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);

export const ARRUSTED_PRODUCTION_REPOSITORY = "withAutograph/arrusted-development";

export const directProductionSubjectSchema = z.strictObject({
  version: z.literal(1),
  appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  appSpecDigest: digest,
  proposalDigest: digest,
  sessionId: id,
  buildWorkspaceId: id,
  authority: hostedTenantAuthoritySchema,
  repositoryId: id,
  repositoryFullName: z.literal(ARRUSTED_PRODUCTION_REPOSITORY),
  installationId: id,
  baseBranch: id,
  storageKind: z.enum(["none", "postgres"]),
  revision: z.strictObject({ priorGrantDigest: digest, priorProposalDigest: digest }).optional(),
});

export type DirectProductionSubject = z.infer<typeof directProductionSubjectSchema>;

const unsignedGrant = z.strictObject({
  callId: id,
  toolName: z.enum(["apply_app_creation", "release-app-production"]),
  subject: directProductionSubjectSchema,
});

const grantDigest = (input: z.input<typeof unsignedGrant>) =>
  createHash("sha256")
    .update(JSON.stringify(unsignedGrant.parse(input)))
    .digest("hex");

export const directProductionGrantSchema = unsignedGrant
  .extend({ digest })
  .superRefine(({ digest: actual, ...grant }, context) => {
    if (grantDigest(grant) !== actual) {
      context.addIssue({ code: "custom", message: "Production approval digest is invalid." });
    }
  });

export type DirectProductionGrant = z.infer<typeof directProductionGrantSchema>;

export const createDirectProductionGrant = (
  input: z.input<typeof unsignedGrant>,
): DirectProductionGrant =>
  directProductionGrantSchema.parse({ ...input, digest: grantDigest(input) });

export const describeDirectProductionSubject = (subject: DirectProductionSubject) => {
  if (subject.revision !== undefined) {
    const storage = subject.storageKind === "postgres" ? " and database" : "";
    return [
      `Release this update to ${subject.appId} in ${subject.repositoryFullName}.`,
      `The app keeps its current Production URL, private access${storage}.`,
      "Builder opens the reviewed pull request and merges it after required checks pass. The repository’s native deployment then makes the update available.",
    ].join(" ");
  }
  const storage =
    subject.storageKind === "postgres"
      ? "Builder prepares the app’s managed database and restricted runtime access under your workspace’s existing plan."
      : "The app does not need a database.";
  return [
    `Release ${subject.appId} to Production in ${subject.repositoryFullName}.`,
    storage,
    "The app starts private to your existing account with self-signup disabled.",
    "Builder opens the reviewed pull request and merges it after required checks pass. The repository’s native deployment then makes the app available.",
  ].join(" ");
};
