import { waitUntil } from "@vercel/functions";
import { createRepositoryProductionNativeHandler } from "./repository-production-native";
import {
  repositoryProductionCompletionPath,
  repositoryProductionPath,
} from "./repository-production-dispatcher";
import { createHostedOperatorNativeHandler } from "./hosted-operator-native";
import { createNativeTargetRequestDependencies } from "./native-target-configuration-resolver";
import {
  createCustodyPossessionHandler,
  custodyPossessionPath,
} from "./vercel-token-key-custody-deployment";

const runtime = createHostedOperatorNativeHandler({
  createRequestDependencies: createNativeTargetRequestDependencies(),
});
const production = createRepositoryProductionNativeHandler(process.env, waitUntil);
const possession = createCustodyPossessionHandler();
export default {
  async fetch(request: Request) {
    const { pathname } = new URL(request.url);
    if ([repositoryProductionPath, repositoryProductionCompletionPath].includes(pathname)) {
      if (request.method !== "POST") {
        return Response.json(
          { code: "not_found" },
          { status: 404, headers: { "cache-control": "no-store" } },
        );
      }
      try {
        return await production(request);
      } catch {
        return Response.json(
          { code: "app_access_unavailable" },
          { status: 503, headers: { "cache-control": "no-store" } },
        );
      }
    }
    if (pathname === custodyPossessionPath) {
      return await possession(request);
    }
    return await runtime(request);
  },
};
