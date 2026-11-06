import type { GitHubSeedConfig } from "@emulators/github";
import type { VercelSeedConfig } from "@emulators/vercel";

export const EMULATED_GITHUB_REPOSITORY = "autograph-local/demo-app";
export const EMULATED_GITHUB_INSTALLATION_ID = 1001;
export const EMULATED_VERCEL_CONFIGURATION_ID = "icfg_local_1";
export const EMULATED_VERCEL_TEAM_ID = "autograph-local";

interface SeedInput {
  origin: string;
  githubAppPrivateKey?: string;
  githubClientId: string;
  githubClientSecret: string;
  vercelClientId: string;
  vercelClientSecret: string;
  strictGitHubOAuth: boolean;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function providerEmulationSeed(input: SeedInput): {
  github: GitHubSeedConfig;
  vercel: VercelSeedConfig;
} {
  const github: GitHubSeedConfig = {
    apps: [
      {
        app_id: 12_345,
        installations: [
          {
            account: "autograph-local",
            installation_id: EMULATED_GITHUB_INSTALLATION_ID,
            repositories: [EMULATED_GITHUB_REPOSITORY],
            repository_selection: "selected",
          },
        ],
        name: "Autograph App Builder",
        ...(input.githubAppPrivateKey ? { private_key: input.githubAppPrivateKey } : {}),
        slug: "autograph-app-builder",
      },
    ],
    ...(input.strictGitHubOAuth
      ? {
          oauth_apps: [
            {
              client_id: input.githubClientId,
              client_secret: input.githubClientSecret,
              name: "Autograph App Builder",
              redirect_uris: [
                `${input.origin}/github/installations/callback`,
                `${input.origin}/api/auth/callback/github`,
              ],
            },
          ],
        }
      : {}),
    orgs: [{ login: "autograph-local", name: "Autograph Local" }],
    repos: [{ auto_init: true, name: "demo-app", owner: "autograph-local" }],
    tokens: {
      emulate_local_provider_token: {
        login: "autograph-dev",
        scopes: ["repo", "user"],
      },
      emulate_preview_provider_token: {
        login: "autograph-dev",
        scopes: ["repo", "user"],
      },
    },
    users: [
      {
        email: "dev@autograph.local",
        login: "autograph-dev",
        name: "Autograph Developer",
      },
    ],
  };
  return {
    github,
    vercel: {
      integrations: [
        {
          client_id: input.vercelClientId,
          client_secret: input.vercelClientSecret,
          name: "Autograph App Builder",
          redirect_uris: [
            `${input.origin}/local-connections/vercel/oauth-callback`,
            `${input.origin}/api/auth/callback/vercel`,
          ],
        },
      ],
      teams: [{ name: "Autograph Local", slug: "autograph-local" }],
      users: [
        {
          email: "dev@autograph.local",
          name: "Autograph Developer",
          username: "autograph-dev",
        },
      ],
    },
  };
}
