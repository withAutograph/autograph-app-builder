import { z } from "zod";

export const githubPrDeliveryApprovalSchema = z.strictObject({
  baseBranch: z.string().min(1),
  headSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
  installationId: z
    .string()
    .regex(/^[1-9][0-9]*$/u)
    .optional(),
  name: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
  owner: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
  proposalDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  pullRequestNumber: z.int().positive(),
  readyAt: z.iso.datetime({ offset: true }).optional(),
  repositoryId: z.string().regex(/^[1-9][0-9]*$/u),
  sessionId: z.string().min(1).optional(),
});

export type GitHubPrDeliveryApproval = z.infer<typeof githubPrDeliveryApprovalSchema>;

export const describeGitHubPrDeliveryApproval = ({
  baseBranch,
  headSha,
  name,
  owner,
  pullRequestNumber,
}: GitHubPrDeliveryApproval): string =>
  `Mark ${owner}/${name} #${pullRequestNumber} ready for review and merge the reviewed revision ${headSha.slice(0, 12)} into ${baseBranch} once required checks pass.`;
