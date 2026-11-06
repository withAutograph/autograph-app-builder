import { createHash } from "node:crypto";
import { z } from "zod";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const shaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const readyAtSchema = z.iso.datetime({ offset: true });
const intentFields = {
  publicationDigest: digestSchema,
  installationIdentityDigest: digestSchema,
  repositoryId: z.string().regex(/^[1-9][0-9]*$/u),
  owner: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
  name: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
  pullRequestNumber: z.int().positive(),
  headSha: shaSchema,
  baseBranch: z.string().min(1),
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
    JSON.stringify({ version: "github-pr-effect-intent-v1", intent: intentSchema.parse(input) }),
  );

const receiptFields = {
  intent: intentSchema,
  approvedByCallId: z.string().min(1),
};
const receiptInputSchema = z
  .discriminatedUnion("status", [
    z.strictObject({ ...receiptFields, status: z.literal("pending") }),
    z.strictObject({
      ...receiptFields,
      status: z.literal("succeeded"),
      evidence: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("pr-ready"), readyAt: readyAtSchema }),
        z.strictObject({ kind: z.literal("pr-merge"), mergeCommitSha: shaSchema }),
      ]),
    }),
    z.strictObject({
      ...receiptFields,
      status: z.literal("failed"),
      code: z.enum(["provider-rejected", "cancelled"]),
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
    version: "github-pr-effect-receipt-v1" as const,
    intentDigest: githubPrEffectIntentDigest(canonical.intent),
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
