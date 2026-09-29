import { z } from "zod";
import { applicationFileChangeSchema } from "../repository/application-file-change";

export const existingAppChangesSchema = z.array(applicationFileChangeSchema).min(1);
export type ExistingAppChange = z.infer<typeof existingAppChangesSchema>[number];
