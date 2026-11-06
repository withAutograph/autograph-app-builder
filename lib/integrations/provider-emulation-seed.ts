import type { GitHubSeedConfig } from "@emulators/github";
import type { VercelSeedConfig } from "@emulators/vercel";

export const EMULATED_GITHUB_REPOSITORY = "autograph-local/demo-app";
export const EMULATED_GITHUB_INSTALLATION_ID = 1001;
export const EMULATED_VERCEL_CONFIGURATION_ID = "icfg_local_1";
export const EMULATED_VERCEL_TEAM_ID = "autograph-local";
const EMULATED_APP_NAME = "Autograph App Builder";
const EMULATED_LOCAL_ACCOUNT = "autograph-local";
const EMULATED_DEVELOPER_EMAIL = "dev@autograph.local";
const EMULATED_DEVELOPER_LOGIN = "autograph-dev";

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
export function providerEmulationSeed(input: SeedInput) {
  const app: GitHubSeedConfig["apps"][number] =
    input.githubAppPrivateKey !== undefined && input.githubAppPrivateKey !== ""
      ? {
          app_id: 12_345,
          installations: [
            {
              account: EMULATED_LOCAL_ACCOUNT,
              installation_id: EMULATED_GITHUB_INSTALLATION_ID,
              repositories: [EMULATED_GITHUB_REPOSITORY],
              repository_selection: "selected",
            },
          ],
          name: EMULATED_APP_NAME,
          private_key: input.githubAppPrivateKey,
          slug: "autograph-app-builder",
        }
      : {
          app_id: 12_345,
          installations: [
            {
              account: EMULATED_LOCAL_ACCOUNT,
              installation_id: EMULATED_GITHUB_INSTALLATION_ID,
              repositories: [EMULATED_GITHUB_REPOSITORY],
              repository_selection: "selected",
            },
          ],
          name: EMULATED_APP_NAME,
          slug: "autograph-app-builder",
        };

  const github: GitHubSeedConfig = {
    apps: [app],
    orgs: [{ login: EMULATED_LOCAL_ACCOUNT, name: "Autograph Local" }],
    repos: [{ auto_init: true, name: "demo-app", owner: EMULATED_LOCAL_ACCOUNT }],
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
        email: EMULATED_DEVELOPER_EMAIL,
        login: EMULATED_DEVELOPER_LOGIN,
        name: "Autograph Developer",
      },
    ],
  };
  if (input.strictGitHubOAuth) {
    github.oauth_apps = [
      {
        client_id: input.githubClientId,
        client_secret: input.githubClientSecret,
        name: EMULATED_APP_NAME,
        redirect_uris: [
          `${input.origin}/github/installations/callback`,
          `${input.origin}/api/auth/callback/github`,
        ],
      },
    ];
  }

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
      teams: [{ name: "Autograph Local", slug: EMULATED_LOCAL_ACCOUNT }],
      users: [
        {
          email: EMULATED_DEVELOPER_EMAIL,
          name: "Autograph Developer",
          username: EMULATED_DEVELOPER_LOGIN,
        },
      ],
    },
  } satisfies { github: GitHubSeedConfig; vercel: VercelSeedConfig };
}
