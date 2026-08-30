import type { Preview } from "@storybook/nextjs-vite";

import { AppShell } from "../components/app-shell";
import "../app/globals.css";
import "./preview.css";

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
        <Story />
      </AppShell>
    ),
  ],
};

export default preview;
