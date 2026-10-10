import { createHostedOperatorNativeHandler } from "./hosted-operator-native";
import { createDependencies } from "./hosted-operator-composition";
import {
  createCustodyPossessionHandler,
  custodyPossessionPath,
} from "./vercel-token-key-custody-deployment";

const runtime = createHostedOperatorNativeHandler({ createDependencies });
const possession = createCustodyPossessionHandler();
export default {
  async fetch(request: Request) {
    if (new URL(request.url).pathname === custodyPossessionPath) {
      return await possession(request);
    }
    return await runtime(request);
  },
};
