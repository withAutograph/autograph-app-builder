import { createHash } from "node:crypto";
import { z } from "zod";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const shaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const readyAtSchema = z.iso.datetime({ offset: true });
const intentFields = {
  baseBranch: z.string().min(1),
  headSha: shaSchema,
  installationIdentityDigest: digestSchema,
  name: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
  owner: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
  publicationDigest: digestSchema,
  pullRequestNumber: z.int().positive(),
  repositoryId: z.string().regex(/^[1-9][0-9]*$/u),
};
const intentSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("pr-ready"),
    ...intentFields,
    readyAuthorization: z.enum(["contents-write", "recover-first-ready"]).optional(),
  }),
  z.strictObject({ kind: z.literal("pr-merge"), ...intentFields, readyAt: readyAtSchema }),
]);

export type GitHubPrEffectIntent = z.infer<typeof intentSchema>;

export const createGitHubPrEffectIntent = (input: GitHubPrEffectIntent): GitHubPrEffectIntent =>
  intentSchema.parse(input);

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export const githubPrEffectIntentDigest = (input: GitHubPrEffectIntent): string =>
  hash(
    JSON.stringify({ intent: intentSchema.parse(input), version: "github-pr-effect-intent-v1" }),
  );

const receiptFields = {
  approvedByCallId: z.string().min(1),
  intent: intentSchema,
};
const receiptInputSchema = z
  .discriminatedUnion("status", [
    z.strictObject({ ...receiptFields, status: z.literal("pending") }),
    z.strictObject({
      ...receiptFields,
      evidence: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("pr-ready"), readyAt: readyAtSchema }),
        z.strictObject({ kind: z.literal("pr-merge"), mergeCommitSha: shaSchema }),
      ]),
      status: z.literal("succeeded"),
    }),
    z.strictObject({
      ...receiptFields,
      code: z.enum(["provider-rejected", "cancelled"]),
      status: z.literal("failed"),
    }),
  ])
  .refine(
    (receipt) => receipt.status !== "succeeded" || receipt.intent.kind === receipt.evidence.kind,
    "GitHub effect evidence must match the approved effect.",
  );

type GitHubPrEffectReceiptInput = z.infer<typeof receiptInputSchema>;
export type GitHubPrEffectReceipt = GitHubPrEffectReceiptInput & {
  version: "github-pr-effect-receipt-v1";
  intentDigest: string;
  digest: string;
};

export const createGitHubPrEffectReceipt = (
  input: GitHubPrEffectReceiptInput,
): GitHubPrEffectReceipt => {
  const canonical = receiptInputSchema.parse(input);
  const unsigned = {
    ...canonical,
    intentDigest: githubPrEffectIntentDigest(canonical.intent),
    version: "github-pr-effect-receipt-v1" as const,
  };
  return { ...unsigned, digest: hash(JSON.stringify(unsigned)) };
};

const receiptEnvelopeSchema = z
  .looseObject({
    digest: digestSchema,
    intentDigest: digestSchema,
    version: z.literal("github-pr-effect-receipt-v1"),
  })
  .transform(({ digest, intentDigest, ...record }) => {
    const { version, ...fields } = record;
    const receipt = createGitHubPrEffectReceipt(receiptInputSchema.parse(fields));
    if (
      receipt.digest !== digest ||
      receipt.intentDigest !== intentDigest ||
      receipt.version !== version
    ) {
      throw new Error("GitHub effect receipt does not match its canonical digest.");
    }
    return receipt;
  });

export const parseGitHubPrEffectReceipt = receiptEnvelopeSchema.parse.bind(receiptEnvelopeSchema);

export interface GitHubPrEffectStore {
  read: (intentDigest: string) => Promise<GitHubPrEffectReceipt | undefined>;
  compareAndSet: (
    intentDigest: string,
    expectedDigest: string | undefined,
    receipt: GitHubPrEffectReceipt,
  ) => Promise<boolean>;
}
