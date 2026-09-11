import { z } from "zod";

export const branchPublicationDigest = z.string().regex(/^[0-9a-f]{64}$/u);
const sha = z.string().regex(/^[0-9a-f]{40}$/u);
const identity = z.strictObject({ device: z.string(), inode: z.string() });
const file = z.strictObject({
  mode: z.enum(["644", "755"]),
  digest: branchPublicationDigest,
});
const change = z.strictObject({
  path: z.string().min(1),
  kind: z.enum(["added", "modified", "deleted"]),
  before: file.optional(),
  after: file.optional(),
});

export const branchWorktreePublicationProposalSchema = z.strictObject({
  version: z.literal(2),
  sourcePath: z.string().min(1),
  sourceRootIdentity: identity,
  sourceGitDirectoryPath: z.string().min(1),
  sourceGitDirectoryIdentity: identity,
  publicationRootPath: z.string().min(1),
  publicationRootIdentity: identity,
  sourceReceiptDigest: branchPublicationDigest,
  sourceTree: sha,
  contractDigest: branchPublicationDigest,
  baseSha: sha,
  sourceHeadReference: z.string().min(1),
  sourceIndexFileDigest: branchPublicationDigest,
  sourceRemoteDigest: branchPublicationDigest,
  sourceStatusDigest: branchPublicationDigest,
  reviewDigest: branchPublicationDigest,
  changeSetDigest: branchPublicationDigest,
  approvedPaths: z.array(z.string().min(1)),
  changes: z.array(change),
  branchName: z.string().min(1),
  worktreePath: z.string().min(1),
  publicationIdentityDigest: branchPublicationDigest,
  intendedOutcome: z.literal("create-reviewed-branch-worktree"),
  digest: branchPublicationDigest,
});
