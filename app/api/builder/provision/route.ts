import { getBuilderProvisioningDeploymentHandler } from "@/lib/provisioning/deployment";

const handle = (request: Request) => getBuilderProvisioningDeploymentHandler(process.env)(request);

export const GET = handle;
export const POST = handle;
