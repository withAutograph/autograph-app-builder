import { z } from "zod";

/** The default model App Builder hands off to its active runtime. */
export const activeBuilderModelId = "openai/gpt-6-luna";
export const activeBuilderModelIdSchema = z.literal(activeBuilderModelId);

/** The model used for source review and design-quality validation. */
export const builderValidationModelId = "openai/gpt-6.1-sol";
