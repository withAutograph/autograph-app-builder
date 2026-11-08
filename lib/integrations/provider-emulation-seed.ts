import type { GitHubSeedConfig } from "@emulators/github";
import type { VercelSeedConfig } from "@emulators/vercel";

const LOCAL_GITHUB_ORGANIZATION = "autograph-local";
const EMULATED_APP_NAME = "Autograph App Builder";
const EMULATED_DEVELOPER_LOGIN = "autograph-dev";

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
            account: LOCAL_GITHUB_ORGANIZATION,
            installation_id: EMULATED_GITHUB_INSTALLATION_ID,
            repositories: [EMULATED_GITHUB_REPOSITORY],
            repository_selection: "selected",
          },
        ],
        name: EMULATED_APP_NAME,
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
              name: EMULATED_APP_NAME,
              redirect_uris: [
                `${input.origin}/github/installations/callback`,
                `${input.origin}/api/auth/callback/github`,
              ],
            },
          ],
        }
      : {}),
    orgs: [{ login: LOCAL_GITHUB_ORGANIZATION, name: "Autograph Local" }],
    repos: [{ auto_init: true, name: "demo-app", owner: LOCAL_GITHUB_ORGANIZATION }],
    tokens: {
      emulate_local_provider_token: {
        login: EMULATED_DEVELOPER_LOGIN,
        scopes: ["repo", "user"],
      },
      emulate_preview_provider_token: {
        login: EMULATED_DEVELOPER_LOGIN,
        scopes: ["repo", "user"],
      },
    },
    users: [
      {
        email: "dev@autograph.local",
        login: EMULATED_DEVELOPER_LOGIN,
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
          name: EMULATED_APP_NAME,
          redirect_uris: [
            `${input.origin}/local-connections/vercel/oauth-callback`,
            `${input.origin}/api/auth/callback/vercel`,
          ],
        },
      ],
      teams: [{ name: "Autograph Local", slug: EMULATED_VERCEL_TEAM_ID }],
      users: [
        {
          email: "dev@autograph.local",
          name: "Autograph Developer",
          username: EMULATED_DEVELOPER_LOGIN,
        },
      ],
    },
  };
}
