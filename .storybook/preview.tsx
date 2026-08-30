import type { Preview } from "@storybook/nextjs-vite";
import { authQueryKeys, type SessionData } from "@better-auth-ui/core";

import { AppShell } from "../components/app-shell";
import { authClient } from "../lib/auth-client";
import { getQueryClient } from "../lib/query-client";
import { storybookAuthenticatedSession } from "./auth-session";
import "../app/globals.css";
import "./preview.css";

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
    (Story) => (
      <AppShell>
        <Story />
      </AppShell>
    ),
  ],
};

export default preview;
