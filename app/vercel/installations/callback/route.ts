import { createVercelInstallationDeploymentHandler } from "@/lib/integrations/vercel-installation-deployment";

export const GET = createVercelInstallationDeploymentHandler(
  "callback",
  process.env
);
