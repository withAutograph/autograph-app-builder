import { createGitHubAppInstallationDeploymentHandler } from "@/lib/auth/github-app-installation-deployment";

export const POST = createGitHubAppInstallationDeploymentHandler("start", process.env);
