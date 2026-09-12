import { getProviderData } from "@flags-sdk/vercel";
import { createFlagsDiscoveryEndpoint } from "flags/next";

import * as featureFlags from "../../../../lib/feature-flags";

// oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
export const GET = createFlagsDiscoveryEndpoint(async () => getProviderData(featureFlags));
