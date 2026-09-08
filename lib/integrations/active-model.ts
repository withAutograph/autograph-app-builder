import { z } from "zod";

/** The default model App Builder hands off to its active runtime. */
export const activeBuilderModelId = "openai/gpt-5.6-terra";
export const activeBuilderModelIdSchema = z.literal(activeBuilderModelId);

/** The higher-capability model reserved for design-quality validation. */
export const builderValidationModelId = "openai/gpt-6-astra";
