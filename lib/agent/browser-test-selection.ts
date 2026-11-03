import { z } from "zod";

/** A literal test-title substring and optional Playwright execution controls, never shell code. */
export const browserTestSelectionSchema = z.strictObject({
  testName: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[^\p{Cc}]+$/u),
  workers: z.number().int().positive().optional(),
  retries: z.number().int().nonnegative().optional(),
  maxFailures: z.number().int().nonnegative().optional(),
});
export type BrowserTestSelection = z.infer<typeof browserTestSelectionSchema>;

export const browserTestSelectionArguments = (input: BrowserTestSelection): string[] => {
  const selection = browserTestSelectionSchema.parse(input);
  const literal = selection.testName.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return [
    "--grep",
    literal,
    ...(selection.workers === undefined ? [] : [`--workers=${selection.workers}`]),
    ...(selection.retries === undefined ? [] : [`--retries=${selection.retries}`]),
    ...(selection.maxFailures === undefined ? [] : [`--max-failures=${selection.maxFailures}`]),
  ];
};
