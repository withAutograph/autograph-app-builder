"use server";

import { createBuilderPublicOriginAction } from "@/lib/provisioning/builder-public-origin-service";

import type {
  builderPublicOriginSelectionSchema,
  BuilderPublicOriginActionState,
} from "@/lib/provisioning/builder-public-origin-contract";

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
    enabled: builderResourceProvisioningFlag,
    open: openBuilderSessionDestination,
    origin: new URL(config.issuer).origin,
    refresh,
  })(input, new Headers(await headers()));
};

export const selectBuilderSessionPublicOrigin = async (
  input: z.infer<typeof builderPublicOriginSelectionSchema>,
): Promise<BuilderPublicOriginActionState> => {
  const config = readPreviewOAuthRuntimeConfig(process.env);
  return await createBuilderPublicOriginAction({
    enabled: builderResourceProvisioningFlag,
    open: openBuilderSessionDestination,
    origin: new URL(config.issuer).origin,
    refresh,
  })(input, new Headers(await headers()));
};
