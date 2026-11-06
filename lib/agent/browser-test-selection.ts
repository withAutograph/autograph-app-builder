import { z } from "zod";

/** A literal test-title substring and optional Playwright execution controls, never shell code. */
export const browserTestSelectionSchema = z.strictObject({
  maxFailures: z.number().int().nonnegative().optional(),
  retries: z.number().int().nonnegative().optional(),
  testName: z
    .string()
    .min(1)
    .max(160)
    // JSON Schema drops RegExp flags; explicit C0/C1 ranges remain portable.
    // oxlint-disable-next-line eslint/no-control-regex -- Reject every Unicode control character without a flag-dependent property escape.
    // JSON Schema drops RegExp flags; explicit C0/C1 ranges remain portable.
    // oxlint-disable-next-line eslint/no-control-regex -- Reject every Unicode control character without a flag-dependent property escape.
    .regex(/^[^\u0000-\u001F\u007F-\u009F]+$/u),
  workers: z.number().int().positive().optional(),
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
