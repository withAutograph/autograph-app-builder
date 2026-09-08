import { createVercelInstallationDeploymentHandler } from "@/lib/integrations/vercel-installation-deployment";

export const runtime = "nodejs";
export const GET = createVercelInstallationDeploymentHandler(
  "callback",
  process.env,
);
