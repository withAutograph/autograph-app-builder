import { z } from "zod";

export const existingAppChangesSchema = z
  .array(
    z.strictObject({
      content: z.string(),
      path: z.string().min(1),
    }),
  )
  .min(1);
