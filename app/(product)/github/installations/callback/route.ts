import { createGitHubAppInstallationDeploymentHandler } from "@/lib/auth/github-app-installation-deployment";
import {
  applyLocalGitHubCallbackFixture,
  clearLocalGitHubCallbackFixtureCookie,
} from "@/lib/auth/local-github-callback-fixture";

const handler = createGitHubAppInstallationDeploymentHandler("callback", process.env);

const get = async (request: Request) => {
  const fixture = applyLocalGitHubCallbackFixture(request, process.env);
  const response = await handler(fixture.request);
  if (fixture.applied) {
    response.headers.append("set-cookie", clearLocalGitHubCallbackFixtureCookie());
  }
  return response;
};

export { get as GET };
