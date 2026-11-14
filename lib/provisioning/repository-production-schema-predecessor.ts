import { createHash } from "node:crypto";
import { z } from "zod";
import type { ApprovedBuildDecision } from "../agent/approved-build-continuation";
import { isExistingRepositoryDestination } from "./builder-session-destination-contract";
import type { BuilderSessionDestination } from "./builder-session-destination-contract";
import type { PublishedAppSource } from "./hosted-operator-artifact-selection";
import type { OperatorOwnerContext } from "./hosted-operator-contract";
import { repositoryProductionScopeSchema } from "./repository-production-contract";
import type { RepositoryProductionRow } from "./repository-production-contract";
import type { GeneratedAppReleaseFiles } from "./hosted-operator-sandbox-launcher";
import type {
  RepositoryProductionEffectContext,
  RepositoryProductionObservation,
} from "./repository-production-setup";
import { repositoryProductionSetupComplete } from "./repository-production-setup";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const sourceDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const repositoryProductionSchemaPredecessorTargetSchema = z.strictObject({
  expectedRepositoryId: z.string().regex(/^[1-9][0-9]*$/u),
  reviewedHeadSha: z.string().regex(/^[a-f0-9]{40}$/u),
});
export type RepositoryProductionSchemaPredecessorTarget = z.infer<
  typeof repositoryProductionSchemaPredecessorTargetSchema
>;
export const repositoryProductionSchemaPredecessorSchema = z.strictObject({
  version: z.literal(1),
  appId: repositoryProductionScopeSchema.shape.appId,
  repositoryId: repositoryProductionSchemaPredecessorTargetSchema.shape.expectedRepositoryId,
  releaseId: z.string().min(1),
  artifactSha256: digestSchema,
  manifestSha256: digestSchema,
  cueSha256: digestSchema,
});
export type RepositoryProductionSchemaPredecessor = z.infer<
  typeof repositoryProductionSchemaPredecessorSchema
>;

const archivedManifestSchema = z.object({
  app: repositoryProductionScopeSchema.shape.appId,
  schema_version: z.string().min(1),
  hashes: z.object({ schema: sourceDigestSchema }),
  sources: z.record(z.string(), sourceDigestSchema),
});
const archivedArtifactSchema = z.object({
  schema: z.object({ app_id: z.string(), version: z.string() }),
});
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const unavailable = () => new Error("repository_production_schema_predecessor_unavailable");

/** This retained review can authorize only predecessor inspection, never delivery effects. */
export const readRepositoryProductionSchemaPredecessorAuthority = (input: {
  decision: ApprovedBuildDecision | undefined;
  destination: BuilderSessionDestination | undefined;
  owner: OperatorOwnerContext;
  logicalSessionId: string;
  appId: string;
  repositoryId: string;
}) => {
  const { decision, destination, owner, logicalSessionId, appId, repositoryId } = input;
  const spec = decision?.currentSpec;
  const delivery = decision?.githubDelivery;
  const review = delivery?.current;
  if (
    !spec ||
    !review ||
    !["reviewed", "applied", "validation_pending", "validation_failed", "validated"].includes(
      decision.workflowPhase,
    )
  ) {
    throw unavailable();
  }
  const existing =
    destination !== undefined && isExistingRepositoryDestination(destination)
      ? destination
      : undefined;
  const source = decision.existingRepositorySource;
  const repository = existing?.repository ?? source?.repository;
  const installationId = existing?.installationId ?? source?.scope.installationId;
  if (repository === undefined || installationId === undefined) {
    throw unavailable();
  }
  const publishedReconciliation = delivery?.publishedReconciliation;
  const current = [
    existing === undefined || existing.appId === appId,
    decision.adapterSessionId === owner.adapterSessionId,
    spec.appId === appId,
    review.appId === appId,
    spec.sessionId === logicalSessionId,
    spec.appSpecDigest === review.appSpecDigest,
    repository.repositoryId === repositoryId,
    existing !== undefined || source?.sessionId === logicalSessionId,
    installationId === review.installationId,
    review.reconciliationDigest === publishedReconciliation?.digest,
  ].every(Boolean);
  if (!current) {
    throw unavailable();
  }
  return {
    review,
    publishedReconciliation,
    appSpecDigest: spec.appSpecDigest,
    repositoryId,
    repositoryFullName: `${repository.owner}/${repository.name}`,
    baseBranch: repository.defaultBranch,
  };
};

export const assertRepositoryProductionSchemaPredecessorSource = (
  authority: ReturnType<typeof readRepositoryProductionSchemaPredecessorAuthority>,
  source: PublishedAppSource | undefined,
  target: RepositoryProductionSchemaPredecessorTarget,
): PublishedAppSource => {
  const { review, publishedReconciliation } = authority;
  if (source === undefined) {
    throw unavailable();
  }
  const matches = [
    source.repositoryId === target.expectedRepositoryId,
    source.repositoryId === authority.repositoryId,
    source.gitSha === target.reviewedHeadSha,
    source.reviewDigest ===
      (publishedReconciliation?.reconciliationReviewDigest ?? review.reviewDigest),
    publishedReconciliation === undefined ||
      source.gitTree === publishedReconciliation.reconciliationTree,
  ].every(Boolean);
  if (!matches) {
    throw unavailable();
  }
  return source;
};

/** Verify the already enrolled release through the worker's inspect operation. */
export const readInstalledRepositoryProductionSchemaPredecessor = async (input: {
  row: RepositoryProductionRow;
  assertCurrent: () => Promise<void>;
  readRelease: (row: RepositoryProductionRow) => Promise<GeneratedAppReleaseFiles>;
  inspect: (context: RepositoryProductionEffectContext) => Promise<RepositoryProductionObservation>;
}): Promise<RepositoryProductionSchemaPredecessor> => {
  const { row, assertCurrent, readRelease, inspect } = input;
  const { scope, intent, resource, lease } = row.record;
  const { storage } = intent;
  if (
    storage.kind !== "postgres" ||
    resource === undefined ||
    lease === undefined ||
    !repositoryProductionSetupComplete(row.record)
  ) {
    throw unavailable();
  }
  await assertCurrent();
  const files = await readRelease(row);
  const manifestBytes = files["release-manifest.json"];
  const artifactBytes = files["app-artifact.json"];
  const manifestSha256 = sha256(manifestBytes);
  const artifactSha256 = sha256(artifactBytes);
  const manifest = archivedManifestSchema.parse(JSON.parse(manifestBytes.toString()));
  const artifact = archivedArtifactSchema.parse(JSON.parse(artifactBytes.toString()));
  const cue = manifest.sources[`apps/${scope.appId}/schema/${scope.appId}.cue`];
  const checked = [
    manifestSha256 === storage.manifestSha256,
    manifest.app === scope.appId,
    manifest.schema_version === storage.releaseId,
    manifest.hashes.schema === `sha256:${artifactSha256}`,
    artifact.schema.app_id === scope.appId,
    artifact.schema.version === storage.releaseId,
  ].every(Boolean);
  if (!checked || cue === undefined) {
    throw unavailable();
  }
  await assertCurrent();
  const result = await inspect({
    row,
    effect: "install-schema",
    assertCurrent,
    checkpoint: () => {
      throw unavailable();
    },
  });
  if (result.state !== "applied") {
    throw unavailable();
  }
  await assertCurrent();
  return repositoryProductionSchemaPredecessorSchema.parse({
    version: 1,
    appId: scope.appId,
    repositoryId: scope.repositoryId,
    releaseId: storage.releaseId,
    artifactSha256,
    manifestSha256,
    cueSha256: cue.slice("sha256:".length),
  });
};
