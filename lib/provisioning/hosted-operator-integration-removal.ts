import { createPublicReleaseIntegrationRemovalAdapter } from "./public-release-integration-removal-adapter";
import type { PublicReleaseIntegrationRemovalPorts } from "./public-release-integration-removal";

/** Trusted native composition: ordinary removal always has the real adapter, with prerequisites checked on use. */
export const createHostedOperatorIntegrationRemoval = (
  input: Parameters<typeof createPublicReleaseIntegrationRemovalAdapter>[0] & {
    integrationRemoval?: PublicReleaseIntegrationRemovalPorts;
  },
): PublicReleaseIntegrationRemovalPorts =>
  input.integrationRemoval ?? createPublicReleaseIntegrationRemovalAdapter(input);
