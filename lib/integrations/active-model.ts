import { z } from "zod";

/** The sole model App Builder may hand off to its active runtime. */
export const activeBuilderModelId = "openai/gpt-5.6-sol";
export const activeBuilderModelIdSchema = z.literal(activeBuilderModelId);
