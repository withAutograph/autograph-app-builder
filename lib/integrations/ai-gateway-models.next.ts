import "server-only";

import { cacheLife, cacheTag } from "next/cache";

import { loadGatewayModels } from "./ai-gateway-models";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function cachedGatewayModels() {
  "use cache";

  cacheTag("public-ai-gateway-models");
  const models = await loadGatewayModels();
  // Never retain a failure/fallback for a full catalog lifetime. A later read
  // retries, while the validated last-known-good catalog keeps the form usable.
  if (models.status === "unavailable" || models.cached) {
    cacheLife({ expire: 60, revalidate: 1, stale: 30 });
  } else {
    cacheLife({ expire: 3600, revalidate: 300, stale: 300 });
  }
  return models;
}

// No session, headers, environment, or tenant input may enter the cached scope.
// Force is a server-side retry bypass, not a new cache key or public mutation.
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function loadNextGatewayModels(input?: { force?: boolean }) {
  return input?.force ? loadGatewayModels() : cachedGatewayModels();
}
