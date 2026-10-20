import { createTenantExportDownloadDeploymentHandler } from "@/lib/provisioning/hosted-operator-export-reader";

const download = createTenantExportDownloadDeploymentHandler();

const get = async (
  request: Request,
  context: { params: Promise<{ exportId: string; member?: string[] }> },
) => await download(request, await context.params);

export { get as GET };
