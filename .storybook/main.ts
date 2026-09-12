import path from "node:path";

import type { StorybookConfig } from "@storybook/nextjs-vite";

import {
  builderComingSoonFlag,
  builderConnectionsFlag,
  builderResourceProvisioningFlag,
} from "../lib/feature-flags.ts";

async function resolveFlagForStorybook(flag: {
  run: (context: { identify: Record<string, never>; request: Request }) => Promise<boolean>;
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
  const [connectionsEnabled, comingSoonEnabled, provisioningEnabled] = await Promise.all([
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
  addons: ["@storybook/addon-vitest", "@storybook/addon-a11y", "@storybook/addon-docs"],
  framework: "@storybook/nextjs-vite",
  staticDirs: ["../public"],
  async viteFinal(viteConfig) {
    const existingAliases = viteConfig.resolve?.alias ?? [];
    const aliases = Array.isArray(existingAliases)
      ? existingAliases
      : Object.entries(existingAliases).map(([find, replacement]) => ({
          find,
          replacement,
        }));
    const storybookBuilderActions = path.join(import.meta.dirname, "builder-actions.ts");
    const storybookBuilderDraftActions = path.join(import.meta.dirname, "builder-draft-actions.ts");
    const { connectionsEnabled, comingSoonEnabled, provisioningEnabled } =
      await resolveBuilderFlagsForStorybook();
    viteConfig.define = {
      ...viteConfig.define,
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
    viteConfig.resolve = {
      ...viteConfig.resolve,
      alias: [
        {
          find: "@/app/actions/builder-drafts",
          replacement: storybookBuilderDraftActions,
        },
        {
          find: "@/app/actions/builder",
          replacement: storybookBuilderActions,
        },
        {
          // Vitest's root alias can resolve this Server Action before the
          // Storybook aliases above are considered.
          find: /[/\\]app[/\\]actions[/\\]builder(?:\.ts)?$/u,
          replacement: storybookBuilderActions,
        },
        // `@flags-sdk/vercel` dynamically imports deployment-generated flag
        // definitions. That module only exists in a Vercel build, while
        // Storybook already receives the resolved values above.
        {
          find: "@flags-sdk/vercel",
          replacement: path.join(import.meta.dirname, "vercel-flags-adapter.ts"),
        },
        ...aliases,
      ],
    };
    return viteConfig;
  },
};
export default config;
