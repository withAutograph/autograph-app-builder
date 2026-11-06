import { getBuilderProvisioningDeploymentHandler } from "@/lib/provisioning/deployment";

const handle = async (request: Request) =>
  getBuilderProvisioningDeploymentHandler(process.env)(request);

export const GET = handle;
export const POST = handle;
