"use server";

import { headers } from "next/headers";
import { refresh } from "next/cache";
import type { z } from "zod";
import { createBuilderSessionDestinationAction } from "@/lib/provisioning/builder-session-destination-action";
import type {
  builderSessionDestinationSelectionSchema,
  BuilderSessionDestinationActionState,
} from "@/lib/provisioning/builder-session-destination-action";
import { openBuilderSessionDestination } from "@/lib/provisioning/builder-session-destination-deployment";
import { builderResourceProvisioningFlag } from "@/lib/feature-flags";
import { readPreviewOAuthRuntimeConfig } from "@/lib/auth/preview-oauth-runtime";

export const selectBuilderSessionDestination = async (
  input: z.infer<typeof builderSessionDestinationSelectionSchema>,
): Promise<BuilderSessionDestinationActionState> => {
  const config = readPreviewOAuthRuntimeConfig(process.env);
  return await createBuilderSessionDestinationAction({
    origin: new URL(config.issuer).origin,
    enabled: builderResourceProvisioningFlag,
    open: openBuilderSessionDestination,
    refresh,
  })(input, new Headers(await headers()));
};
