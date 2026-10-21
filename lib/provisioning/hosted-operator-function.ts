import { createHostedOperatorNativeHandler } from "./hosted-operator-native";
import { createNativeTargetRequestDependencies } from "./native-target-configuration-resolver";
import {
  createCustodyPossessionHandler,
  custodyPossessionPath,
} from "./vercel-token-key-custody-deployment";

const runtime = createHostedOperatorNativeHandler({
  createRequestDependencies: createNativeTargetRequestDependencies(),
});
const possession = createCustodyPossessionHandler();
export default {
  async fetch(request: Request) {
    if (new URL(request.url).pathname === custodyPossessionPath) {
      return await possession(request);
    }
    return await runtime(request);
  },
};
