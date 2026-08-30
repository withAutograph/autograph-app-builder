import { describe, expect, it } from "vitest";

import {
  EMULATED_GITHUB_INSTALLATION_ID,
  EMULATED_GITHUB_REPOSITORY,
  EMULATED_VERCEL_TEAM_ID,
  providerEmulationSeed,
} from "./provider-emulation-seed";

const input = {
  origin: "https://app-git-feature-team.vercel.app",
  githubClientId: "github-client",
  githubClientSecret: "g".repeat(20),
  vercelClientId: "vercel-client",
  vercelClientSecret: "v".repeat(20),
};

describe("provider emulation seed", () => {
  it("shares the seeded installation, repository, team, and callbacks", () => {
    const seed = providerEmulationSeed({
      ...input,
      strictGitHubOAuth: false,
    });
    expect(seed.github.oauth_apps).toBeUndefined();
    expect(seed.github.apps?.[0]?.installations?.[0]).toMatchObject({
      installation_id: EMULATED_GITHUB_INSTALLATION_ID,
      repositories: [EMULATED_GITHUB_REPOSITORY],
    });
    expect(seed.vercel.teams?.[0]?.slug).toBe(EMULATED_VERCEL_TEAM_ID);
    expect(seed.vercel.integrations?.[0]?.redirect_uris).toContain(
      "https://app-git-feature-team.vercel.app/api/auth/callback/vercel",
    );
  });

  it("registers fixed callback URLs only for local CLI emulation", () => {
    const seed = providerEmulationSeed({
      ...input,
      strictGitHubOAuth: true,
    });
    expect(seed.github.oauth_apps?.[0]?.redirect_uris).toEqual([
      "https://app-git-feature-team.vercel.app/github/installations/callback",
      "https://app-git-feature-team.vercel.app/api/auth/callback/github",
    ]);
  });
});
