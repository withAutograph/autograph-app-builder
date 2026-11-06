import { getBuilderHandoffDeploymentHandler } from "@/lib/handoff/deployment";

const postHandoff = async (request: Request) =>
  await getBuilderHandoffDeploymentHandler(process.env)(request);

export { postHandoff as POST };
