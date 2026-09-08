import { authQueryKeys, type SessionData } from "@better-auth-ui/core";
import type { Preview } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";

import appStyles from "../app/ui/app-builder.module.css";
import { AppShell } from "../components/app-shell";
import { authClient } from "../lib/auth-client";
import { getQueryClient } from "../lib/query-client";
import "../app/globals.css";
import "./preview.css";

const CREATE_APP_STORY_PREFIX = "Create App/";

function isCreateAppStory(title: string) {
  return title.startsWith(CREATE_APP_STORY_PREFIX);
}

const storybookQueryClient = getQueryClient();
storybookQueryClient.setQueryDefaults(authQueryKeys.session, {
  staleTime: Infinity,
});

const preview: Preview = {
  parameters: {
    authSession: null,
    nextjs: { appDirectory: true },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
  loaders: [
    async ({ parameters }) => {
      storybookQueryClient.setQueryData(
        authQueryKeys.session,
        (parameters.authSession ?? null) as SessionData<typeof authClient>,
      );

      return {};
    },
  ],
  decorators: [
    (Story, context) => (
      <AppShell>
        {isCreateAppStory(context.title) ? (
          <div className={appStyles.appShell} data-create-app-story-environment>
            <Story />
          </div>
        ) : (
          <Story />
        )}
      </AppShell>
    ),
  ],
  afterEach: ({ canvasElement, title }) => {
    if (!isCreateAppStory(title)) return;

    expect(
      canvasElement.querySelector("[data-create-app-story-environment]"),
    ).toBeInTheDocument();
  },
};

export default preview;
