import { createGitHubAppInstallationDeploymentHandler } from "@/lib/auth/github-app-installation-deployment";
import {
  applyLocalGitHubCallbackFixture,
  clearLocalGitHubCallbackFixtureCookie,
} from "@/lib/auth/local-github-callback-fixture";

export const runtime = "nodejs";

const callback = createGitHubAppInstallationDeploymentHandler(
  "callback",
  process.env,
);

export async function GET(request: Request) {
  const fixture = applyLocalGitHubCallbackFixture(request, process.env);
  const response = await callback(fixture.request);
  if (fixture.applied)
    response.headers.append(
      "set-cookie",
      clearLocalGitHubCallbackFixtureCookie(),
    );
  return response;
}
