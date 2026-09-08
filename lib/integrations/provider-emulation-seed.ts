import type { GitHubSeedConfig } from "@emulators/github";
import type { VercelSeedConfig } from "@emulators/vercel";

export const EMULATED_GITHUB_REPOSITORY = "autograph-local/demo-app";
export const EMULATED_GITHUB_INSTALLATION_ID = 1001;
export const EMULATED_VERCEL_CONFIGURATION_ID = "icfg_local_1";
export const EMULATED_VERCEL_TEAM_ID = "autograph-local";

type SeedInput = {
  origin: string;
  githubAppPrivateKey?: string;
  githubClientId: string;
  githubClientSecret: string;
  vercelClientId: string;
  vercelClientSecret: string;
  strictGitHubOAuth: boolean;
};

export function providerEmulationSeed(input: SeedInput): {
  github: GitHubSeedConfig;
  vercel: VercelSeedConfig;
} {
  const github: GitHubSeedConfig = {
    users: [
      {
        login: "autograph-dev",
        name: "Autograph Developer",
        email: "dev@autograph.local",
      },
    ],
    orgs: [{ login: "autograph-local", name: "Autograph Local" }],
    repos: [{ owner: "autograph-local", name: "demo-app", auto_init: true }],
    tokens: {
      emulate_preview_provider_token: {
        login: "autograph-dev",
        scopes: ["repo", "user"],
      },
      emulate_local_provider_token: {
        login: "autograph-dev",
        scopes: ["repo", "user"],
      },
    },
    apps: [
      {
        app_id: 12345,
        slug: "autograph-app-builder",
        name: "Autograph App Builder",
        ...(input.githubAppPrivateKey
          ? { private_key: input.githubAppPrivateKey }
          : {}),
        installations: [
          {
            installation_id: EMULATED_GITHUB_INSTALLATION_ID,
            account: "autograph-local",
            repository_selection: "selected",
            repositories: [EMULATED_GITHUB_REPOSITORY],
          },
        ],
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
  };
  return {
    github,
    vercel: {
      users: [
        {
          username: "autograph-dev",
          name: "Autograph Developer",
          email: "dev@autograph.local",
        },
      ],
      teams: [{ slug: "autograph-local", name: "Autograph Local" }],
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
    },
  };
}
