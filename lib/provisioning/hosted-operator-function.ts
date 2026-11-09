import { waitUntil } from "@vercel/functions";
import { createAuthSchemaRolloutNativeHandler } from "./production-auth-schema-rollout-native";
import { authSchemaRolloutPath } from "./production-auth-schema-rollout-contract";
import { HostedOperatorError } from "./hosted-operator-contract";
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
const authSchemaRollout = createAuthSchemaRolloutNativeHandler();
export default {
  async fetch(request: Request) {
    const { pathname } = new URL(request.url);
    if (pathname === authSchemaRolloutPath) {
      try {
        return await authSchemaRollout(request);
      } catch (error) {
        const denied =
          error instanceof HostedOperatorError && error.code === "authorization_required";
        return Response.json(
          { code: denied ? "authorization_required" : "auth_schema_rollout_unavailable" },
          { status: denied ? 403 : 503, headers: { "cache-control": "no-store" } },
        );
      }
    }
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
