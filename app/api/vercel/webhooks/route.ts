import { createVercelWebhookDeploymentHandler } from "@/lib/integrations/vercel-installation-deployment";

export const runtime = "nodejs";
export const POST = createVercelWebhookDeploymentHandler(process.env);
