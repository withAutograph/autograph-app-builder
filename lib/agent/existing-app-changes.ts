import { z } from "zod";

export const existingAppChangesSchema = z
  .array(
    z.strictObject({
      content: z.string().max(262_144),
      path: z.string().min(1).max(512),
    })
  )
  .min(1)
  .max(32);
