import { z } from "zod";

export const branchPublicationDigest = z.string().regex(/^[0-9a-f]{64}$/u);
const sha = z.string().regex(/^[0-9a-f]{40}$/u);
const identity = z.strictObject({ device: z.string(), inode: z.string() });
const file = z.strictObject({
  digest: branchPublicationDigest,
  mode: z.enum(["644", "755"]),
});
const change = z.strictObject({
  after: file.optional(),
  before: file.optional(),
  kind: z.enum(["added", "modified", "deleted"]),
  path: z.string().min(1),
});

export const branchWorktreePublicationProposalSchema = z.strictObject({
  approvedPaths: z.array(z.string().min(1)),
  baseSha: sha,
  branchName: z.string().min(1),
  changeSetDigest: branchPublicationDigest,
  changes: z.array(change),
  contractDigest: branchPublicationDigest,
  digest: branchPublicationDigest,
  intendedOutcome: z.literal("create-reviewed-branch-worktree"),
  publicationIdentityDigest: branchPublicationDigest,
  publicationRootIdentity: identity,
  publicationRootPath: z.string().min(1),
  reviewDigest: branchPublicationDigest,
  sourceGitDirectoryIdentity: identity,
  sourceGitDirectoryPath: z.string().min(1),
  sourceHeadReference: z.string().min(1),
  sourceIndexFileDigest: branchPublicationDigest,
  sourcePath: z.string().min(1),
  sourceReceiptDigest: branchPublicationDigest,
  sourceRemoteDigest: branchPublicationDigest,
  sourceRootIdentity: identity,
  sourceStatusDigest: branchPublicationDigest,
  sourceTree: sha,
  version: z.literal(2),
  worktreePath: z.string().min(1),
});
