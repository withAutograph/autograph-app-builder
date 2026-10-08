import { createRealmIdentityCallbackDeploymentHandler } from "@/lib/provisioning/hosted-operator-realm-callback";

const callback = async (request: Request) =>
  await createRealmIdentityCallbackDeploymentHandler()(request);

export { callback as GET, callback as POST };
