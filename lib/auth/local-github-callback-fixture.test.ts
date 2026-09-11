import { describe, expect, test } from "vitest";

import {
  applyLocalGitHubCallbackFixture,
  localGitHubCallbackFixtureCookie,
} from "./local-github-callback-fixture";

function request(fixture: string) {
  return new Request(
    "https://localhost:3001/github/installations/callback?code=opaque&state=correlation",
    {
      headers: { cookie: `${localGitHubCallbackFixtureCookie}=${fixture}` },
    },
  );
}

describe("local GitHub callback fixtures", () => {
  test("are disabled in production and without local provider emulation", () => {
    for (const environment of [
      { NODE_ENV: "production", APP_BUILDER_LOCAL_PROVIDER_EMULATION: "1" },
      { NODE_ENV: "test" },
    ] satisfies NodeJS.ProcessEnv[]) {
      const original = request("extensions");
      const result = applyLocalGitHubCallbackFixture(original, environment);
      expect(result).toEqual({ applied: false, request: original });
    }
  });

  test("adds repeated provider extensions only to a real OAuth callback", () => {
    const result = applyLocalGitHubCallbackFixture(request("extensions"), {
      NODE_ENV: "test",
      APP_BUILDER_LOCAL_PROVIDER_EMULATION: "1",
    });
    const query = new URL(result.request.url).searchParams;
    expect(result.applied).toBe(true);
    expect(query.getAll("iss")).toEqual([
      "https://github.com",
      "https://provider-extension.invalid/again",
    ]);
    expect(query.getAll("future_provider_extension")).toEqual([
      "opaque-provider-value",
      "opaque-provider-value-2",
    ]);
  });

  test.each([
    ["duplicate-code", "code", 2],
    ["duplicate-state", "state", 2],
    ["duplicate-installation-id", "installation_id", 2],
    ["duplicate-setup-action", "setup_action", 2],
  ])("models %s independently", (fixture, key, count) => {
    const result = applyLocalGitHubCallbackFixture(request(fixture), {
      NODE_ENV: "test",
      APP_BUILDER_LOCAL_PROVIDER_EMULATION: "1",
    });
    expect(new URL(result.request.url).searchParams.getAll(key)).toHaveLength(
      count,
    );
  });
});
