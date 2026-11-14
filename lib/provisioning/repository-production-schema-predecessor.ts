import { createHash } from "node:crypto";
import { z } from "zod";
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
export const repositoryProductionSchemaPredecessorSchema = z.strictObject({
  version: z.literal(1),
  appId: repositoryProductionScopeSchema.shape.appId,
  repositoryId: z.string().regex(/^[1-9][0-9]*$/u),
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
