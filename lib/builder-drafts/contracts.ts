import { z } from "zod";

const uuidSchema = z.string().uuid();
const boundedText = (maximum: number) => z.string().max(maximum);
const connectionSchema = z.string().trim().min(1).max(120);

export const builderDraftFormSchema = z
  .object({
    appName: boundedText(120),
    repository: boundedText(160),
    brief: boundedText(16_000),
    privateRepository: z.boolean(),
    buildDestination: z.enum(["web", "codex", "cursor"]),
    connections: z.array(connectionSchema).max(100),
    vercelInstallationId: boundedText(256).optional(),
    githubInstallationId: boundedText(256).optional(),
    modelId: boundedText(256),
  })
  .strict();

export const builderDraftSchema = z
  .object({
    version: z.literal(1),
    form: builderDraftFormSchema,
    team: boundedText(256),
    gitScope: boundedText(256),
    model: boundedText(256),
    zdrOnly: z.boolean(),
    showMoreConnections: z.boolean(),
    search: boundedText(256),
    connectedConnections: z.array(connectionSchema).max(100),
    storageProvider: z.enum(["github", "gitlab", "bitbucket"]).nullable().optional(),
    deploymentProvider: z.enum(["vercel", "netlify", "cloudflare"]).nullable().optional(),
    focusOrigin: z.enum(["vercel", "github"]),
    appNameEditedByUser: z.boolean(),
    repositoryEditedByUser: z.boolean(),
  })
  .strict();

export type BuilderDraft = z.infer<typeof builderDraftSchema>;

export const builderDraftRecordSchema = z
  .object({ version: z.literal(1), draft: builderDraftSchema })
  .strict();

export type BuilderDraftRecord = z.infer<typeof builderDraftRecordSchema>;

export const builderDraftStatusSchema = z.enum(["active", "archived"]);
export type BuilderDraftStatus = z.infer<typeof builderDraftStatusSchema>;

export const saveActiveBuilderDraftInputSchema = z
  .object({
    version: z.literal(1),
    draftId: uuidSchema,
    expectedRevision: z.number().int().min(0),
    clientMutationId: uuidSchema,
    record: builderDraftRecordSchema,
  })
  .strict();

export type SaveActiveBuilderDraftInput = z.infer<typeof saveActiveBuilderDraftInputSchema>;

export const builderDraftPageDataSchema = z
  .object({
    draftId: uuidSchema,
    revision: z.number().int().positive(),
    record: builderDraftRecordSchema,
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type BuilderDraftPageData = z.infer<typeof builderDraftPageDataSchema>;
