import { getBuilderProvisioningDeploymentHandler } from "@/lib/provisioning/deployment";

const handle = async (request: Request) =>
  await getBuilderProvisioningDeploymentHandler(process.env)(request);

export const GET = handle;
export const POST = handle;
