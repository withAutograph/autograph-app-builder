import { createRepositoryProductionNativeHandler } from "./repository-production-native";
import { repositoryProductionPath } from "./repository-production-dispatcher";
import { createHostedOperatorNativeHandler } from "./hosted-operator-native";
import { createNativeTargetRequestDependencies } from "./native-target-configuration-resolver";
import {
  createCustodyPossessionHandler,
  custodyPossessionPath,
} from "./vercel-token-key-custody-deployment";

const runtime = createHostedOperatorNativeHandler({
  createRequestDependencies: createNativeTargetRequestDependencies(),
});
const production = createRepositoryProductionNativeHandler();
const possession = createCustodyPossessionHandler();
export default {
  async fetch(request: Request) {
    if (
      new URL(request.url).pathname === repositoryProductionPath ||
      new URL(request.url).pathname.startsWith(`${repositoryProductionPath}/`)
    ) {
      try {
        return await production(request);
      } catch {
        return Response.json(
          { code: "app_access_unavailable" },
          { status: 503, headers: { "cache-control": "no-store" } },
        );
      }
    }
    if (new URL(request.url).pathname === custodyPossessionPath) {
      return await possession(request);
    }
    return await runtime(request);
  },
};
