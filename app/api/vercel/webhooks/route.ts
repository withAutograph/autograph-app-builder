import { createVercelWebhookDeploymentHandler } from "@/lib/integrations/vercel-installation-deployment";

export const POST = createVercelWebhookDeploymentHandler(process.env);
