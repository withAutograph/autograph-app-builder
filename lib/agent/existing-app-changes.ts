import { z } from "zod";

export const existingAppChangesSchema = z
  .array(
    z.strictObject({
      path: z.string().min(1).max(512),
      content: z.string().max(262_144),
    }),
  )
  .min(1)
  .max(32);
