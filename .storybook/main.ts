import type { StorybookConfig } from "@storybook/nextjs-vite";

import {
  builderComingSoonFlag,
  builderConnectionsFlag,
  builderResourceProvisioningFlag,
} from "../lib/feature-flags.ts";

async function resolveFlagForStorybook(flag: {
  run: (context: {
    identify: Record<string, never>;
    request: Request;
  }) => Promise<boolean>;
}) {
  if (!process.env.FLAGS) return false;
  try {
    return (
      (await flag.run({
        identify: {},
        request: new Request("https://storybook.local"),
      })) === true
    );
  } catch {
    return false;
  }
}

export async function resolveBuilderFlagsForStorybook() {
  const [connectionsEnabled, comingSoonEnabled, provisioningEnabled] =
    await Promise.all([
      resolveFlagForStorybook(builderConnectionsFlag),
      resolveFlagForStorybook(builderComingSoonFlag),
      resolveFlagForStorybook(builderResourceProvisioningFlag),
    ]);

  return { connectionsEnabled, comingSoonEnabled, provisioningEnabled };
}

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
  async viteFinal(viteConfig) {
    const { connectionsEnabled, comingSoonEnabled, provisioningEnabled } =
      await resolveBuilderFlagsForStorybook();
    viteConfig.define = {
      ...(viteConfig.define ?? {}),
      // This resolved Boolean is the only flag data included in the browser
      // bundle. The SDK key and discovery secret remain server-only.
      "process.env.STORYBOOK_BUILDER_CONNECTIONS_ENABLED": JSON.stringify(
        String(connectionsEnabled),
      ),
      "process.env.STORYBOOK_BUILDER_COMING_SOON_ENABLED": JSON.stringify(
        String(comingSoonEnabled),
      ),
      "process.env.STORYBOOK_BUILDER_PROVISIONING_ENABLED": JSON.stringify(
        String(provisioningEnabled),
      ),
    };
    return viteConfig;
  },
};
export default config;
