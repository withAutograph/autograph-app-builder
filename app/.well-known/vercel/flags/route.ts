import { getProviderData } from "@flags-sdk/vercel";
import { createFlagsDiscoveryEndpoint } from "flags/next";

import * as featureFlags from "../../../../lib/feature-flags";

export const GET = createFlagsDiscoveryEndpoint(async () =>
  getProviderData(featureFlags),
);
