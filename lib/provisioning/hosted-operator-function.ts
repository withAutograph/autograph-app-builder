import { createHostedOperatorNativeHandler } from "./hosted-operator-native";

// Concrete hosted-operator-composition.ts createDependencies() is not implemented
// yet. The integrated operational host must wire that reviewed factory here.
// Its absence returns 503; importing this entrypoint does not establish readiness.
export default { fetch: createHostedOperatorNativeHandler() };
