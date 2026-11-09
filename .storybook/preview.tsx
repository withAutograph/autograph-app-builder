/* oxlint-disable typescript/no-unsafe-assignment -- Preserve existing JSX style bindings while their types are unresolved. */
/* oxlint-disable typescript/no-unsafe-member-access -- Preserve the existing untyped input and rendering boundary. */
import { authQueryKeys } from "@better-auth-ui/core";
import type { SessionData } from "@better-auth-ui/core";
import type { Preview } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";

import appStyles from "../app/ui/app-builder.module.css";
import { AppShell } from "../components/app-shell";
import { AuthRouteProvider } from "../components/providers";
import type { authClient } from "../lib/auth-client";
import { getQueryClient } from "../lib/query-client";
import "../app/globals.css";
import "./preview.css";

const CREATE_APP_STORY_PREFIX = "Create App/";
const CREATE_APP_COMPONENT_STORY_PREFIX = "Components/Create App/";
const CONNECTION_DRAWER_STORY = "Components/Connections/Connection Drawer";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function usesCreateAppShell(title: string) {
  return (
    title.startsWith(CREATE_APP_STORY_PREFIX) ||
    title.startsWith(CREATE_APP_COMPONENT_STORY_PREFIX) ||
    title === CONNECTION_DRAWER_STORY
  );
}

const storybookQueryClient = getQueryClient();
storybookQueryClient.setQueryDefaults(authQueryKeys.session, {
  staleTime: Infinity,
});

const preview: Preview = {
  afterEach: ({ canvasElement, title }) => {
    if (!usesCreateAppShell(title)) {
      return;
    }

    void expect(
      canvasElement.querySelector("[data-create-app-story-environment]"),
    ).toBeInTheDocument();
  },
  decorators: [
    (Story, context) => (
      <AppShell>
        <AuthRouteProvider
          githubAuthEnabled={false}
          vercelAuthEnabled={false}
          passkeysEnabled={false}
        >
          {usesCreateAppShell(context.title) ? (
            <div className={appStyles.appShell} data-create-app-story-environment>
              <Story />
            </div>
          ) : (
            <Story />
          )}
        </AuthRouteProvider>
      </AppShell>
    ),
  ],
  loaders: [
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test callback
    async ({ parameters }) => {
      storybookQueryClient.setQueryData(
        authQueryKeys.session,
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing assertion at this boundary. Preserve the existing assertion and its runtime behavior.
        (parameters.authSession ?? null) as SessionData<typeof authClient>,
      );

      return {};
    },
  ],
  parameters: {
    authSession: null,
    controls: {
      matchers: {
        color: /(?<property>background|color)$/iu,
        date: /Date$/iu,
      },
    },
    nextjs: { appDirectory: true },
    options: {
      storySort: {
        order: [
          "Create App",
          ["Flow", ["Anonymous Entry", "Page", "Handoff"], "Recovery"],
          "Components",
          [
            "Create App",
            [
              "Sections",
              ["App Details", "Build With", "Connections", "Deploy To", "Store In"],
              "Primitives",
              ["Brand", "Choice Card", "Search Combobox", "Section Shell", "Tooltip"],
            ],
            "Connections",
            ["Connection Drawer", "Provider Connection"],
            "Workspace",
            ["Onboarding"],
            "Auth",
            ["Theme Controls"],
          ],
          "Pages",
          ["Auth", ["Workspace Setup"]],
          "MCP",
          [
            "Authorization",
            ["Approval Request", "Authorization Request"],
            "Inputs",
            ["Choice Request", "Freeform Request", "Input Batch"],
          ],
          "*",
        ],
      },
    },
  },
};

export default preview;
