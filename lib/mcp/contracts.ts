import { z } from "zod";

export const sessionStatusSchema = z.enum([
  "working",
  "input_required",
  "waiting",
  "completed",
  "failed",
  "cancelled",
]);

export type EveSessionStatus = z.infer<typeof sessionStatusSchema>;

export const publicInputRequestSchema = z.object({
  requestId: z.string().min(1),
  kind: z.enum(["approval", "question", "authorization"]),
  title: z.string().min(1),
  description: z.string().optional(),
  options: z
    .array(z.object({ id: z.string().min(1), label: z.string().min(1) }))
    .optional(),
  allowFreeform: z.boolean(),
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

export const eveSessionResultSchema = z.object({
  sessionId: z.string(),
  status: sessionStatusSchema,
  cursor: z.number().int().nonnegative(),
  events: z.array(publicEveEventSchema),
  inputRequests: z.array(publicInputRequestSchema).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

export type EveSessionResult = z.infer<typeof eveSessionResultSchema>;

export const eveStartInputSchema = z.object({
  prompt: z.string().trim().min(1).max(32_000),
  clientRequestId: z.string().min(1).max(200),
});
export const eveGetInputSchema = z.object({
  sessionId: z.string().min(1),
  cursor: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(250).default(100),
});
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
          message: "Each Eve requestId must appear exactly once.",
        });
      seen.add(requestId);
    }
  });
export const eveCancelInputSchema = z.object({
  sessionId: z.string().min(1),
  turnId: z.string().optional(),
});
