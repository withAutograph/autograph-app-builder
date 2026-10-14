import { createNormalActorCaptureDeploymentHandler } from "@/lib/provisioning/hosted-operator-normal-actor-capture-deployment";

export const runtime = "nodejs";

const capture = async (request: Request) =>
  await createNormalActorCaptureDeploymentHandler()(request);

export { capture as POST };
