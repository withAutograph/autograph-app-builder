import { createGitHubAppInstallationDeploymentHandler } from "@/lib/auth/github-app-installation-deployment";
import {
  applyLocalGitHubCallbackFixture,
  clearLocalGitHubCallbackFixtureCookie,
} from "@/lib/auth/local-github-callback-fixture";

const handler = createGitHubAppInstallationDeploymentHandler("callback", process.env);

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function GET(request: Request) {
  const fixture = applyLocalGitHubCallbackFixture(request, process.env);
  const response = await handler(fixture.request);
  if (fixture.applied)
    response.headers.append("set-cookie", clearLocalGitHubCallbackFixtureCookie());
  return response;
}
