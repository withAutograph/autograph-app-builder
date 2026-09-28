import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { hostedGitHubDraftAdoptions } from "../db/schema";
import type { HostedGitHubTenantAuthority } from "./postgres-github-installation-store";

type Database = PostgresJsDatabase<{
  hostedGitHubDraftAdoptions: typeof hostedGitHubDraftAdoptions;
}>;
const decimal = z.string().regex(/^[1-9][0-9]*$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const head = z.string().regex(/^[0-9a-f]{40}$/u);

const adoptionSchema = z.strictObject({
  appId: decimal,
  authorId: decimal,
  builderMarker: digest,
  originalHeadSha: head,
  pullRequestId: decimal,
  pullRequestNumber: z.number().int().positive(),
  repositoryId: decimal,
});
export type GitHubDraftAdoptionEvidence = z.infer<typeof adoptionSchema>;
export type GitHubDraftAdoption = GitHubDraftAdoptionEvidence & { adoptionDigest: string };

export interface GitHubDraftAdoptionStore {
  read: (repositoryId: string, pullRequestId: string) => Promise<GitHubDraftAdoption | undefined>;
  save: (evidence: GitHubDraftAdoptionEvidence) => Promise<GitHubDraftAdoption>;
}

const digestEvidence = (evidence: GitHubDraftAdoptionEvidence): string =>
  createHash("sha256").update(JSON.stringify(evidence)).digest("hex");

const selection = {
  adoptionDigest: hostedGitHubDraftAdoptions.adoptionDigest,
  appId: hostedGitHubDraftAdoptions.appId,
  authorId: hostedGitHubDraftAdoptions.authorId,
  builderMarker: hostedGitHubDraftAdoptions.builderMarker,
  originalHeadSha: hostedGitHubDraftAdoptions.originalHeadSha,
  pullRequestId: hostedGitHubDraftAdoptions.pullRequestId,
  pullRequestNumber: hostedGitHubDraftAdoptions.pullRequestNumber,
  repositoryId: hostedGitHubDraftAdoptions.repositoryId,
};

const parseRow = (row: GitHubDraftAdoption): GitHubDraftAdoption => {
  const parsed = z.strictObject({ ...adoptionSchema.shape, adoptionDigest: digest }).parse(row);
  const { adoptionDigest, ...evidence } = parsed;
  if (adoptionDigest !== digestEvidence(evidence)) {
    throw new Error("The saved draft adoption evidence has an invalid digest.");
  }
  return parsed;
};

export const createPostgresGitHubDraftAdoptionStore = (
  database: Database,
  authorityInput: HostedGitHubTenantAuthority,
  now: () => Date = () => new Date(),
): GitHubDraftAdoptionStore => {
  const authority = hostedTenantAuthoritySchema.parse(authorityInput);
  const tenant = and(
    eq(hostedGitHubDraftAdoptions.issuer, authority.issuer),
    eq(hostedGitHubDraftAdoptions.audience, authority.audience),
    eq(hostedGitHubDraftAdoptions.workspaceId, authority.workspaceId),
    eq(hostedGitHubDraftAdoptions.ownerUserId, authority.ownerUserId),
  );
  const read = async (repositoryId: string, pullRequestId: string) => {
    decimal.parse(repositoryId);
    decimal.parse(pullRequestId);
    const rows = await database
      .select(selection)
      .from(hostedGitHubDraftAdoptions)
      .where(
        and(
          tenant,
          eq(hostedGitHubDraftAdoptions.repositoryId, repositoryId),
          eq(hostedGitHubDraftAdoptions.pullRequestId, pullRequestId),
        ),
      )
      .limit(1);
    return rows[0] === undefined ? undefined : parseRow(rows[0]);
  };
  return {
    read,
    async save(input) {
      const evidence = adoptionSchema.parse(input);
      const adoptionDigest = digestEvidence(evidence);
      await database
        .insert(hostedGitHubDraftAdoptions)
        .values({
          ...authority,
          ...evidence,
          adoptionDigest,
          createdAt: now(),
        })
        .onConflictDoNothing();
      const persisted = await read(evidence.repositoryId, evidence.pullRequestId);
      if (
        persisted === undefined ||
        !isDeepStrictEqual(persisted, { ...evidence, adoptionDigest })
      ) {
        throw new Error(
          "This draft PR has a different tenant-scoped adoption record. Inspect its GitHub provenance before retrying.",
        );
      }
      return persisted;
    },
  };
};
