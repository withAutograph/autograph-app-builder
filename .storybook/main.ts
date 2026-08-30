import type { StorybookConfig } from "@storybook/nextjs-vite";

import { builderConnectionsFlag } from "../lib/feature-flags.ts";

export async function resolveBuilderConnectionsForStorybook() {
  if (!process.env.FLAGS) return false;
  try {
    return (
      (await builderConnectionsFlag.run({
        identify: {},
        request: new Request("https://storybook.local"),
      })) === true
    );
  } catch {
    return false;
  }
}

const config: StorybookConfig = {
  stories: ["../app/**/*.stories.@(ts|tsx)"],
  addons: [
    "@storybook/addon-vitest",
    "@storybook/addon-a11y",
    "@storybook/addon-docs",
  ],
  framework: "@storybook/nextjs-vite",
  staticDirs: ["../public"],
  async viteFinal(viteConfig) {
    const connectionsEnabled = await resolveBuilderConnectionsForStorybook();
    viteConfig.define = {
      ...(viteConfig.define ?? {}),
      // This resolved Boolean is the only flag data included in the browser
      // bundle. The SDK key and discovery secret remain server-only.
      "process.env.STORYBOOK_BUILDER_CONNECTIONS_ENABLED": JSON.stringify(
        String(connectionsEnabled),
      ),
    };
    return viteConfig;
  },
};
export default config;
