import type { Preview } from "@storybook/nextjs-vite";

import { Providers } from "../components/providers";
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
      <div style={{ minHeight: "100vh" }}>
        <Providers>
          <Story />
        </Providers>
      </div>
    ),
  ],
};

export default preview;
