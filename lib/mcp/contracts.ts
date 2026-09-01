import { z } from "zod";

import { githubRepositoryAccessSchema } from "../integrations/store-in-view-model";

export const sessionStatusSchema = z.enum([
  "working",
  "input_required",
  "waiting",
  "completed",
  "failed",
  "cancelled",
]);

export type EveSessionStatus = z.infer<typeof sessionStatusSchema>;

function isLoopbackHostname(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname.toLowerCase());
}

export const publicAuthorizationUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .superRefine((value, context) => {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && isLoopbackHostname(url.hostname)))
    )
      context.addIssue({
        code: "custom",
        message:
          "Authorization requires credential-free HTTPS or loopback URL.",
      });
  });

export const inputPresentationSchema = z
  .object({
    section: z.enum(["build-with", "store-in", "deploy-to", "connections"]),
    control: z.enum(["choice", "provider", "approval"]),
  })
  .strict();

export const publicAuthorizationChallengeSchema = z
  .object({
    url: publicAuthorizationUrlSchema.optional(),
    userCode: z.string().min(1).max(200).optional(),
    expiresAt: z.iso.datetime().optional(),
    instructions: z.string().min(1).max(2_000).optional(),
    displayName: z.string().min(1).max(200).optional(),
    repositoryAccess: githubRepositoryAccessSchema.optional(),
  })
  .strict();

export const publicInputRequestSchema = z
  .object({
    requestId: z.string().min(1),
    kind: z.enum(["approval", "question", "authorization"]),
    title: z.string().min(1),
    description: z.string().optional(),
    options: z
      .array(z.object({ id: z.string().min(1), label: z.string().min(1) }))
      .optional(),
    allowFreeform: z.boolean(),
    presentation: inputPresentationSchema.optional(),
    authorization: publicAuthorizationChallengeSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.kind !== "authorization" && request.authorization)
      context.addIssue({
        code: "custom",
        path: ["authorization"],
        message: "Only authorization requests may include a challenge.",
      });
  });

export type PublicInputRequest = z.infer<typeof publicInputRequestSchema>;

export const publicEveEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("assistant_message"),
    index: z.number().int().nonnegative(),
    turnId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("progress"),
    index: z.number().int().nonnegative(),
    turnId: z.string().optional(),
    label: z.string(),
    state: z.enum(["started", "completed", "failed"]),
  }),
  z.object({
    type: z.literal("input_required"),
    index: z.number().int().nonnegative(),
    request: publicInputRequestSchema,
  }),
  z.object({
    type: z.literal("status"),
    index: z.number().int().nonnegative(),
    status: sessionStatusSchema,
  }),
  z.object({
    type: z.literal("error"),
    index: z.number().int().nonnegative(),
    code: z.string(),
    message: z.string(),
  }),
]);

export type PublicEveEvent = z.infer<typeof publicEveEventSchema>;

const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const gitObjectIdSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const repositoryPathSchema = z
  .string()
  .regex(/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/@:-]+$/u);

export const publicPrototypePreviewUrlSchema = z
  .string()
  .url()
  .max(1_024)
  .superRefine((value, context) => {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && isLoopbackHostname(url.hostname))) ||
      !/^\/preview\/[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}\/[a-f0-9]{64}$/u.test(
        url.pathname,
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Prototype previews require an exact hosted HTTPS or loopback URL.",
      });
    }
  });

export const publicPrototypeSchema = z
  .object({
    path: z
      .string()
      .regex(/^prototype\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/index\.html$/u),
    mediaType: z.literal("text/html"),
    content: z
      .string()
      .min(1)
      .max(262_144)
      .refine(
        (content) => new TextEncoder().encode(content).byteLength <= 262_144,
        "Prototype HTML must be at most 262144 bytes.",
      ),
    digest: sha256DigestSchema,
    revision: sha256DigestSchema,
    previewUrl: publicPrototypePreviewUrlSchema.optional(),
  })
  .strict();

export type PublicPrototype = z.infer<typeof publicPrototypeSchema>;

export const publicImplementationPlanSchema = z
  .object({
    appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
    runtime: z.literal("nextjs"),
    workspacePath: repositoryPathSchema,
    packageName: z.string().regex(/^@autograph\/[a-z][a-z0-9-]*$/u),
    projectName: z.string().regex(/^apps-[a-z][a-z0-9-]*$/u),
    routes: z.array(z.string().startsWith("/")).min(1),
    sourceSha: gitObjectIdSchema,
    sourceTree: gitObjectIdSchema,
    proposalDigest: sha256DigestSchema,
    readOnly: z.literal(true),
  })
  .strict();

export type PublicImplementationPlan = z.infer<
  typeof publicImplementationPlanSchema
>;

export const eveSessionResultSchema = z
  .object({
    sessionId: z.string(),
    status: sessionStatusSchema,
    cursor: z.number().int().nonnegative(),
    events: z.array(publicEveEventSchema),
    inputRequests: z.array(publicInputRequestSchema).optional(),
    prototype: publicPrototypeSchema.optional(),
    implementationPlan: publicImplementationPlanSchema.optional(),
    error: z
      .object({ code: z.string(), message: z.string() })
      .strict()
      .optional(),
  })
  .strict();

export type EveSessionResult = z.infer<typeof eveSessionResultSchema>;

export const publicSessionStageSchema = z.enum([
  "starting",
  "designing",
  "prototype",
  "planning",
  "ready",
  "complete",
  "needs_attention",
]);

export const publicSessionResumabilitySchema = z.enum([
  "live",
  "checkpoint",
  "restart_required",
  "terminal",
]);

export const publicSessionSummarySchema = z
  .object({
    sessionId: z.string().min(1),
    title: z.string().min(1).max(200),
    appId: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u)
      .optional(),
    stage: publicSessionStageSchema,
    status: sessionStatusSchema,
    resumability: publicSessionResumabilitySchema,
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const eveSessionListResultSchema = z
  .object({
    kind: z.literal("session_list"),
    cursor: z.number().int().nonnegative(),
    sessions: z.array(publicSessionSummarySchema).max(250),
  })
  .strict();

export type EveSessionListResult = z.infer<typeof eveSessionListResultSchema>;
export type PublicSessionSummary = z.infer<typeof publicSessionSummarySchema>;

export const eveGetResultSchema = z.union([
  eveSessionResultSchema,
  eveSessionListResultSchema,
]);

export const eveStartInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(32_000).optional(),
    handoffId: z.string().uuid().optional(),
    resumeSessionId: z.string().min(1).max(200).optional(),
    clientRequestId: z.string().min(1).max(200),
  })
  .strict()
  .superRefine(({ prompt, handoffId, resumeSessionId }, context) => {
    if (
      [prompt, handoffId, resumeSessionId].filter(
        (value) => value !== undefined,
      ).length !== 1
    )
      context.addIssue({
        code: "custom",
        message:
          "Provide exactly one of prompt, handoffId, or resumeSessionId.",
      });
  });
export const eveGetInputSchema = z
  .object({
    sessionId: z.string().min(1).max(200).optional(),
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(250).default(100),
  })
  .strict();
export const eveSendInputSchema = z.object({
  sessionId: z.string().min(1),
  message: z.string().trim().min(1).max(32_000),
  clientRequestId: z.string().min(1).max(200),
});
export const eveResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approve") }),
  z.object({ kind: z.literal("deny") }),
  z.object({
    kind: z.literal("answer"),
    value: z.string().max(16_000),
    optionId: z.string().optional(),
  }),
]);

export const eveRespondInputSchema = z
  .object({
    sessionId: z.string().min(1),
    responses: z
      .array(
        z.object({
          requestId: z.string().min(1),
          response: eveResponseSchema,
        }),
      )
      .min(1)
      .max(32),
    clientRequestId: z.string().min(1).max(200),
  })
  .strict()
  .superRefine(({ responses }, context) => {
    const seen = new Set<string>();
    for (const [index, { requestId }] of responses.entries()) {
      if (seen.has(requestId))
        context.addIssue({
          code: "custom",
          path: ["responses", index, "requestId"],
          message: "Each requestId must appear exactly once.",
        });
      seen.add(requestId);
    }
  });
export const eveCancelInputSchema = z.object({
  sessionId: z.string().min(1),
  turnId: z.string().optional(),
});
