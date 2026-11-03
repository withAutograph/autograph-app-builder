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
) => {
  try {
    return await client.plan(appId);
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
