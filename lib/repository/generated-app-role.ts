import { z } from "zod";

/** Product policy roles are strings, distinct from PostgreSQL database/role identifiers. */
export const generatedAppRoleSchema = z.string().regex(/^[a-z][a-z0-9_]*$/u);
