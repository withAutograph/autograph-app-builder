import type { Preview } from "@storybook/nextjs-vite";

import { AppShell } from "../components/app-shell";
import { Providers } from "../components/providers";
import "../app/globals.css";

const preview: Preview = {
  parameters: {
    nextjs: { appDirectory: true },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
  decorators: [
    (Story) => (
      <AppShell>
        <Providers>
          <Story />
        </Providers>
      </AppShell>
    ),
  ],
};

export default preview;
