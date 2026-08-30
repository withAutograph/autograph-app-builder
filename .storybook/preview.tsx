import type { Preview } from "@storybook/nextjs-vite";
import { GeistSans } from "geist/font/sans";

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
      <div
        className={`${GeistSans.className} min-h-screen bg-background text-foreground antialiased`}
      >
        <Providers>
          <Story />
        </Providers>
      </div>
    ),
  ],
};

export default preview;
