import { getBuilderProvisioningDeploymentHandler } from "@/lib/provisioning/deployment";

export const runtime = "nodejs";

const handle = (request: Request) =>
  getBuilderProvisioningDeploymentHandler(process.env)(request);

export const GET = handle;
export const POST = handle;
