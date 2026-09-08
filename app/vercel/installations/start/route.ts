import { createVercelInstallationDeploymentHandler } from "@/lib/integrations/vercel-installation-deployment";

export const runtime = "nodejs";
export const POST = createVercelInstallationDeploymentHandler(
  "start",
  process.env,
);
