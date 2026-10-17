import { z } from "zod";

/** Trusted source-derived Vercel build settings frozen with an app delivery plan. */
export const hostedOperatorAppProjectSettingsSchema = z.strictObject({
  buildCommand: z.string().nullable().optional(),
  framework: z.string().nullable(),
  rootDirectory: z.string().min(1),
  sourceFilesOutsideRootDirectory: z.boolean(),
});

export type HostedOperatorAppProjectSettings = z.infer<
  typeof hostedOperatorAppProjectSettingsSchema
>;
