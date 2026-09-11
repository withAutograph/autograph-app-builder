import { createVercelInstallationDeploymentHandler } from "@/lib/integrations/vercel-installation-deployment";

export const POST = createVercelInstallationDeploymentHandler("start", process.env);
