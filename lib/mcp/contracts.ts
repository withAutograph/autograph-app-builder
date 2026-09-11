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
  .max(2048)
  .superRefine((value, context) => {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && isLoopbackHostname(url.hostname)))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Authorization requires credential-free HTTPS or loopback URL.",
      });
    }
  });

export const inputPresentationSchema = z
  .object({
    control: z.enum(["choice", "provider", "approval"]),
    section: z.enum(["build-with", "store-in", "deploy-to", "connections"]),
  })
  .strict();

export const publicAuthorizationChallengeSchema = z
  .object({
    displayName: z.string().min(1).max(200).optional(),
    expiresAt: z.iso.datetime().optional(),
    instructions: z.string().min(1).max(2_000).optional(),
    repositoryAccess: githubRepositoryAccessSchema.optional(),
    url: publicAuthorizationUrlSchema.optional(),
    userCode: z.string().min(1).max(200).optional(),
  })
  .strict();

export const publicInputRequestSchema = z
  .object({
    allowFreeform: z.boolean(),
    authorization: publicAuthorizationChallengeSchema.optional(),
    description: z.string().optional(),
    kind: z.enum(["approval", "question", "authorization"]),
    options: z
      .array(z.object({ id: z.string().min(1), label: z.string().min(1) }))
      .optional(),
    presentation: inputPresentationSchema.optional(),
    requestId: z.string().min(1),
    title: z.string().min(1),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.kind !== "authorization" && request.authorization) {
      context.addIssue({
        code: "custom",
        path: ["authorization"],
        message: "Only authorization requests may include a challenge.",
      });
    }
  });

export type PublicInputRequest = z.infer<typeof publicInputRequestSchema>;

export const publicEveEventSchema = z.discriminatedUnion("type", [
  z.object({
    index: z.number().int().nonnegative(),
    text: z.string(),
    turnId: z.string(),
    type: z.literal("assistant_message"),
  }),
  z.object({
    index: z.number().int().nonnegative(),
    label: z.string(),
    state: z.enum(["started", "completed", "failed"]),
    turnId: z.string().optional(),
    type: z.literal("progress"),
  }),
  z.object({
    index: z.number().int().nonnegative(),
    request: publicInputRequestSchema,
    type: z.literal("input_required"),
  }),
  z.object({
    index: z.number().int().nonnegative(),
    status: sessionStatusSchema,
    type: z.literal("status"),
  }),
  z.object({
    code: z.string(),
    index: z.number().int().nonnegative(),
    message: z.string(),
    type: z.literal("error"),
  }),
]);

export type PublicEveEvent = z.infer<typeof publicEveEventSchema>;

const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const publicPrototypePreviewUrlSchema = z
  .string()
  .url()
  .max(1024)
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
        url.pathname
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
    content: z
      .string()
      .min(1)
      .max(8 * 1024 * 1024)
      .refine(
        (content) =>
          new TextEncoder().encode(content).byteLength <= 8 * 1024 * 1024,
        "Prototype HTML must be at most 8 MiB."
      ),
    digest: sha256DigestSchema,
    mediaType: z.literal("text/html"),
    path: z
      .string()
      .regex(/^prototype\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/index\.html$/u),
    previewUrl: publicPrototypePreviewUrlSchema.optional(),
    revision: sha256DigestSchema,
  })
  .strict();

export type PublicPrototype = z.infer<typeof publicPrototypeSchema>;

/** A fixture-backed revision compiled from the prepared Arrusted catalog. */
export const publicUiPreviewSchema = z
  .object({
    appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
    fidelity: z.literal("arrusted-component-catalog"),
    functionality: z.literal("fixtures-only"),
    previewUrl: publicPrototypePreviewUrlSchema.optional(),
    revision: sha256DigestSchema,
    routes: z.array(z.string().startsWith("/")).min(1).max(16),
  })
  .strict();

export type PublicUiPreview = z.infer<typeof publicUiPreviewSchema>;

export const publicImplementationPlanSchema = z
  .object({
    appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
    packageName: z.string().regex(/^@autograph\/[a-z][a-z0-9-]*$/u),
    projectName: z.string().regex(/^apps-[a-z][a-z0-9-]*$/u),
    readOnly: z.literal(true),
    routes: z.array(z.string().startsWith("/")).min(1),
    runtime: z.literal("nextjs"),
  })
  .strict();

export type PublicImplementationPlan = z.infer<
  typeof publicImplementationPlanSchema
>;

export const eveSessionResultSchema = z
  .object({
    cursor: z.number().int().nonnegative(),
    error: z
      .object({ code: z.string(), message: z.string() })
      .strict()
      .optional(),
    events: z.array(publicEveEventSchema),
    implementationPlan: publicImplementationPlanSchema.optional(),
    inputRequests: z.array(publicInputRequestSchema).optional(),
    prototype: publicPrototypeSchema.optional(),
    sessionId: z.string(),
    status: sessionStatusSchema,
    uiPreview: publicUiPreviewSchema.optional(),
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
    appId: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u)
      .optional(),
    resumability: publicSessionResumabilitySchema,
    sessionId: z.string().min(1),
    stage: publicSessionStageSchema,
    status: sessionStatusSchema,
    title: z.string().min(1).max(200),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const eveSessionListResultSchema = z
  .object({
    cursor: z.number().int().nonnegative(),
    kind: z.literal("session_list"),
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
    clientRequestId: z.string().min(1).max(200),
    handoffId: z.string().uuid().optional(),
    prompt: z.string().trim().min(1).max(32_000).optional(),
    resumeSessionId: z.string().min(1).max(200).optional(),
  })
  .strict()
  .superRefine(({ prompt, handoffId, resumeSessionId }, context) => {
    if (
      [prompt, handoffId, resumeSessionId].filter(
        (value) => value !== undefined
      ).length !== 1
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Provide exactly one of prompt, handoffId, or resumeSessionId.",
      });
    }
  });
export const eveGetInputSchema = z
  .object({
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(250).default(100),
    sessionId: z.string().min(1).max(200).optional(),
  })
  .strict();
export const eveSendInputSchema = z.object({
  clientRequestId: z.string().min(1).max(200),
  message: z.string().trim().min(1).max(32_000),
  sessionId: z.string().min(1),
});
export const eveResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approve") }),
  z.object({ kind: z.literal("deny") }),
  z.object({
    kind: z.literal("answer"),
    optionId: z.string().optional(),
    value: z.string().max(16_000),
  }),
]);

export const eveRespondInputSchema = z
  .object({
    clientRequestId: z.string().min(1).max(200),
    responses: z
      .array(
        z.object({
          requestId: z.string().min(1),
          response: eveResponseSchema,
        })
      )
      .min(1)
      .max(32),
    sessionId: z.string().min(1),
  })
  .strict()
  .superRefine(({ responses }, context) => {
    const seen = new Set<string>();
    for (const [index, { requestId }] of responses.entries()) {
      if (seen.has(requestId)) {
        context.addIssue({
          code: "custom",
          path: ["responses", index, "requestId"],
          message: "Each requestId must appear exactly once.",
        });
      }
      seen.add(requestId);
    }
  });
export const eveCancelInputSchema = z.object({
  sessionId: z.string().min(1),
  turnId: z.string().optional(),
});
