import { createHostedOperatorNativeHandler } from "./hosted-operator-native";
import { createDependencies } from "./hosted-operator-composition";

export default { fetch: createHostedOperatorNativeHandler({ createDependencies }) };
