import { createHash } from "node:crypto";

import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { githubPermissionsFor } from "./github-permissions";
import type { GitHubOperation } from "./github-permissions";

export const GITHUB_TARGET_ACCESS_PROOF_VERSION = 3 as const;

const decimal = z.string().regex(/^[1-9][0-9]*$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const permissions = z.strictObject({
  administration: z.enum(["none", "write"]),
  contents: z.enum(["read", "write"]),
  metadata: z.literal("read"),
  pullRequests: z.enum(["none", "write"]),
  variables: z.literal("read"),
  workflows: z.enum(["none", "write"]),
});

const unsignedSchema = z.strictObject({
  accountId: decimal,
  accountLogin: z.string().min(1).max(100),
  accountType: z.enum(["Organization", "User"]),
  authorityDigest: digest,
  installationId: decimal,
  operation: z.enum([
    "resolve-existing-source",
    "create-fresh-repository",
    "publish-draft-pull-request",
  ]),
  permissions,
  repositoryId: decimal,
  verification: z.literal("installation-scoped-repository-token-v1"),
  version: z.literal(GITHUB_TARGET_ACCESS_PROOF_VERSION),
});

export const githubTargetAccessProofSchema = unsignedSchema.extend({ digest });
export type GitHubTargetAccessProof = z.infer<typeof githubTargetAccessProofSchema>;

type HashableProof = z.infer<typeof unsignedSchema> | z.infer<typeof hostedTenantAuthoritySchema>;
const sha256 = (value: HashableProof): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * This is an additive v3 proof format. Existing v2 publication identities and
 * receipts continue to use their current reader until each flow is migrated.
 * The caller must first verify target access with a repository-scoped GitHub
 * installation token, then pass the observed identity from that provider call.
 */
export const issueGitHubTargetAccessProof = (input: {
  authority: z.input<typeof hostedTenantAuthoritySchema>;
  operation: GitHubOperation;
  installation: {
    accountId: string;
    accountLogin: string;
    accountType: "Organization" | "User";
    installationId: string;
  };
  repositoryId: string;
  observed: {
    installationId: string;
    repositoryId: string;
    permissions: ReturnType<typeof githubPermissionsFor>;
  };
}): GitHubTargetAccessProof => {
  const authority = hostedTenantAuthoritySchema.parse(input.authority);
  const expectedPermissions = githubPermissionsFor(input.operation);
  if (
    input.observed.installationId !== input.installation.installationId ||
    input.observed.repositoryId !== input.repositoryId ||
    JSON.stringify(input.observed.permissions) !== JSON.stringify(expectedPermissions)
  ) {
    throw new Error("github-target-access-observation-mismatch");
  }
  const unsigned = unsignedSchema.parse({
    accountId: input.installation.accountId,
    accountLogin: input.installation.accountLogin,
    accountType: input.installation.accountType,
    authorityDigest: sha256(authority),
    installationId: input.installation.installationId,
    operation: input.operation,
    permissions: expectedPermissions,
    repositoryId: input.repositoryId,
    verification: "installation-scoped-repository-token-v1",
    version: GITHUB_TARGET_ACCESS_PROOF_VERSION,
  });
  return { ...unsigned, digest: sha256(unsigned) };
};

export const parseGitHubTargetAccessProof = (
  input: z.input<typeof githubTargetAccessProofSchema>,
  authority: z.input<typeof hostedTenantAuthoritySchema>,
): GitHubTargetAccessProof => {
  const parsed = githubTargetAccessProofSchema.parse(input);
  const { digest: actualDigest, ...unsigned } = parsed;
  const expectedPermissions = githubPermissionsFor(parsed.operation);
  if (
    actualDigest !== sha256(unsigned) ||
    parsed.authorityDigest !== sha256(hostedTenantAuthoritySchema.parse(authority)) ||
    JSON.stringify(parsed.permissions) !== JSON.stringify(expectedPermissions)
  ) {
    throw new Error("github-target-access-proof-invalid");
  }
  return parsed;
};
