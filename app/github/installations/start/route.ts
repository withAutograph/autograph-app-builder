import { createGitHubAppInstallationDeploymentHandler } from "@/lib/auth/github-app-installation-deployment";

export const runtime = "nodejs";

export const POST = createGitHubAppInstallationDeploymentHandler(
  "start",
  process.env,
);
