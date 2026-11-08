import { getProviderData } from "@flags-sdk/vercel";
import { createFlagsDiscoveryEndpoint } from "flags/next";

// oxlint-disable-next-line sonarjs/no-wildcard-import -- Discover flags from the complete feature module.
import * as featureFlags from "../../../../lib/feature-flags";

// oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
export const GET = createFlagsDiscoveryEndpoint(async () => await getProviderData(featureFlags));
