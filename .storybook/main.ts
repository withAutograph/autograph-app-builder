import type { StorybookConfig } from "@storybook/nextjs-vite";

const config: StorybookConfig = {
  stories: [
    "../app/**/*.stories.@(ts|tsx)",
    "../components/**/*.stories.@(ts|tsx)",
    "../lib/mcp/session-app/**/*.stories.@(ts|tsx)",
  ],
  addons: [
    "@storybook/addon-vitest",
    "@storybook/addon-a11y",
    "@storybook/addon-docs",
  ],
  framework: "@storybook/nextjs-vite",
  staticDirs: ["../public"],
  async viteFinal(config) {
    config.define = {
      ...(config.define ?? {}),
      "process.env.NEXT_PUBLIC_FEATURE_CONNECTIONS": JSON.stringify("true"),
    };
    return config;
  },
};
export default config;
