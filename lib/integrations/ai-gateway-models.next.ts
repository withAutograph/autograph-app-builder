import "server-only";

import { cacheLife, cacheTag } from "next/cache";

import { loadGatewayModels } from "./ai-gateway-models";

async function cachedGatewayModels() {
  "use cache";

  cacheTag("public-ai-gateway-models");
  const models = await loadGatewayModels();
  // Never retain a failure/fallback for a full catalog lifetime. A later read
  // retries, while the validated last-known-good catalog keeps the form usable.
  if (models.status === "unavailable" || models.cached) {
    cacheLife({ stale: 30, revalidate: 1, expire: 60 });
  } else {
    cacheLife({ stale: 300, revalidate: 300, expire: 3600 });
  }
  return models;
}

// No session, headers, environment, or tenant input may enter the cached scope.
// Force is a server-side retry bypass, not a new cache key or public mutation.
export async function loadNextGatewayModels(input?: { force?: boolean }) {
  return input?.force ? loadGatewayModels() : cachedGatewayModels();
}
