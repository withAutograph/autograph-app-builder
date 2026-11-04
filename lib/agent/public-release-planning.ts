import type { z } from "zod";
import type { appIntegrationCapabilityPointerSchema } from "../provisioning/app-integration-release-contract";
import type { publicReleaseClientForContext } from "./public-release-client";
import {
  PublicReleasePrerequisiteError,
  publicReleasePrerequisiteResponse,
} from "../provisioning/public-release-prerequisite";
import { withBuilderDestinationGuidance } from "../provisioning/builder-destination-guidance";

/** Navigation uses the verified public owner session, including recovered workers. */
export const planPublicAppWithGuidance = async (
  client: Pick<Awaited<ReturnType<typeof publicReleaseClientForContext>>, "plan" | "sessionId">,
  appId: string,
  integrationCapability?: z.infer<typeof appIntegrationCapabilityPointerSchema>,
) => {
  try {
    return integrationCapability === undefined
      ? await client.plan(appId)
      : await client.plan(appId, integrationCapability);
  } catch (error) {
    if (!(error instanceof PublicReleasePrerequisiteError)) {
      throw error;
    }
    return withBuilderDestinationGuidance(
      publicReleasePrerequisiteResponse(error),
      client.sessionId,
    );
  }
};
