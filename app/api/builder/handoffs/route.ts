import { getBuilderHandoffDeploymentHandler } from "@/lib/handoff/deployment";

const handlePost = async (request: Request) =>
  await getBuilderHandoffDeploymentHandler(process.env)(request);

export { handlePost as POST };
