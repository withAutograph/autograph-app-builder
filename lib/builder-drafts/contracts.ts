import { sourceCandidateReferenceSchema } from "../handoff/application-source-contract";
import { z } from "zod";

const uuidSchema = z.uuid();
const boundedText = (maximum: number) => z.string().max(maximum);
const connectionSchema = z.string().trim().min(1).max(120);

export const builderDraftFormSchema = z.strictObject({
  appName: boundedText(120),
  sourceCandidate: sourceCandidateReferenceSchema.optional(),
  brief: boundedText(16_000),
  buildDestination: z.enum(["web", "codex", "cursor"]),
  connections: z.array(connectionSchema).max(100),
  githubInstallationId: boundedText(256).optional(),
  modelId: boundedText(256),
  privateRepository: z.boolean(),
  repository: boundedText(160),
  vercelInstallationId: boundedText(256).optional(),
});

export const builderDraftSchema = z.strictObject({
  appNameEditedByUser: z.boolean(),
  connectedConnections: z.array(connectionSchema).max(100),
  deploymentProvider: z.enum(["vercel", "netlify", "cloudflare"]).nullable().optional(),
  focusOrigin: z.enum(["vercel", "github"]),
  form: builderDraftFormSchema,
  gitScope: boundedText(256),
  model: boundedText(256),
  repositoryEditedByUser: z.boolean(),
  search: boundedText(256),
  showMoreConnections: z.boolean(),
  storageProvider: z.enum(["github", "gitlab", "bitbucket"]).nullable().optional(),
  team: boundedText(256),
  version: z.literal(1),
  zdrOnly: z.boolean(),
});

export type BuilderDraft = z.infer<typeof builderDraftSchema>;

export const builderDraftRecordSchema = z.strictObject({
  draft: builderDraftSchema,
  version: z.literal(1),
});

export type BuilderDraftRecord = z.infer<typeof builderDraftRecordSchema>;

export const builderDraftStatusSchema = z.enum(["active", "archived"]);
export type BuilderDraftStatus = z.infer<typeof builderDraftStatusSchema>;

export const saveActiveBuilderDraftInputSchema = z.strictObject({
  clientMutationId: uuidSchema,
  draftId: uuidSchema,
  expectedRevision: z.number().int().min(0),
  record: builderDraftRecordSchema,
  version: z.literal(1),
});

export type SaveActiveBuilderDraftInput = z.infer<typeof saveActiveBuilderDraftInputSchema>;

export const builderDraftPageDataSchema = z.strictObject({
  draftId: uuidSchema,
  record: builderDraftRecordSchema,
  revision: z.number().int().positive(),
  updatedAt: z.iso.datetime({ offset: true }),
});

export type BuilderDraftPageData = z.infer<typeof builderDraftPageDataSchema>;
