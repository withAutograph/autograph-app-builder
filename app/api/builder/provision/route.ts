import { getBuilderProvisioningDeploymentHandler } from "@/lib/provisioning/deployment";

// oxlint-disable-next-line typescript/promise-function-async -- Preserve the handler's promise and synchronous exception behavior.
const handle = (request: Request) => getBuilderProvisioningDeploymentHandler(process.env)(request);

export const GET = handle;
export const POST = handle;
