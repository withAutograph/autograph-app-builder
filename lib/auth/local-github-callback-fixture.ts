export const localGitHubCallbackFixtureCookie = "autograph-e2e-github-callback";

const fixtures = {
  extensions: [
    ["iss", "https://github.com"],
    ["iss", "https://provider-extension.invalid/again"],
    ["future_provider_extension", "opaque-provider-value"],
    ["future_provider_extension", "opaque-provider-value-2"],
  ],
  "duplicate-code": [["code", "duplicate-app-owned-value"]],
  "duplicate-state": [["state", "duplicate-app-owned-value"]],
  "duplicate-installation-id": [
    ["installation_id", "1001"],
    ["installation_id", "1001"],
    ["setup_action", "install"],
  ],
  "duplicate-setup-action": [
    ["installation_id", "1001"],
    ["setup_action", "install"],
    ["setup_action", "install"],
  ],
} as const satisfies Record<string, ReadonlyArray<readonly [string, string]>>;

export type LocalGitHubCallbackFixture = keyof typeof fixtures;

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get("cookie");
  if (!cookie) return;

  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
}

export function applyLocalGitHubCallbackFixture(
  request: Request,
  environment: NodeJS.ProcessEnv,
) {
  if (
    environment.NODE_ENV === "production" ||
    environment.APP_BUILDER_LOCAL_PROVIDER_EMULATION !== "1"
  )
    return { applied: false, request };

  const url = new URL(request.url);
  if (!url.searchParams.has("code")) return { applied: false, request };

  const fixture = cookieValue(request, localGitHubCallbackFixtureCookie);
  if (!fixture || !(fixture in fixtures)) return { applied: false, request };

  for (const [key, value] of fixtures[fixture as LocalGitHubCallbackFixture])
    url.searchParams.append(key, value);

  return {
    applied: true,
    request: new Request(url, {
      headers: request.headers,
      method: request.method,
    }),
  };
}

export function clearLocalGitHubCallbackFixtureCookie() {
  return `${localGitHubCallbackFixtureCookie}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`;
}
