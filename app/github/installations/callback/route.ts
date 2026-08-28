import { createGitHubAppInstallationDeploymentHandler } from "@/lib/auth/github-app-installation-deployment";

export const runtime = "nodejs";

export const GET = createGitHubAppInstallationDeploymentHandler(
  "callback",
  process.env,
);
