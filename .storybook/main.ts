import path from "node:path";

import type { StorybookConfig } from "@storybook/nextjs-vite";
import type { Alias, AliasOptions } from "vite";

import {
  builderComingSoonFlag,
  builderConnectionsFlag,
  builderResourceProvisioningFlag,
} from "../lib/feature-flags.ts";

const isAliasList = (value: AliasOptions): value is Alias[] => Array.isArray(value);

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function resolveFlagForStorybook(flag: {
  run: (context: { identify: Record<string, never>; request: Request }) => Promise<boolean>;
}) {
  const configuredSdkKey = process.env.FLAGS;
  if (configuredSdkKey === undefined || configuredSdkKey.length === 0) return false;
  try {
    return await flag.run({
      identify: {},
      request: new Request("https://storybook.local"),
    });
  } catch {
    return false;
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function resolveBuilderFlagsForStorybook() {
  const [connectionsEnabled, comingSoonEnabled, provisioningEnabled] = await Promise.all([
    resolveFlagForStorybook(builderConnectionsFlag),
    resolveFlagForStorybook(builderComingSoonFlag),
    resolveFlagForStorybook(builderResourceProvisioningFlag),
  ]);

  return { comingSoonEnabled, connectionsEnabled, provisioningEnabled };
}

const config: StorybookConfig = {
  addons: ["@storybook/addon-vitest", "@storybook/addon-a11y", "@storybook/addon-docs"],
  framework: "@storybook/nextjs-vite",
  staticDirs: ["../public"],
  stories: [
    "../app/**/*.stories.@(ts|tsx)",
    "../components/**/*.stories.@(ts|tsx)",
    "../lib/mcp/session-app/**/*.stories.@(ts|tsx)",
  ],
  async viteFinal(viteConfig) {
    const existingAliases: AliasOptions = viteConfig.resolve?.alias ?? [];
    const aliases: Alias[] = [];
    if (isAliasList(existingAliases)) {
      for (const alias of existingAliases) aliases.push(alias);
    } else {
      aliases.push(
        ...Object.entries(existingAliases).map(([find, replacement]) => ({
          find,
          replacement: String(replacement),
        })),
      );
    }
    const storybookBuilderActions = path.join(import.meta.dirname, "builder-actions.ts");
    const storybookSourceActions = path.join(import.meta.dirname, "source-handoff-actions.ts");
    const storybookBuilderDraftActions = path.join(import.meta.dirname, "builder-draft-actions.ts");
    const { connectionsEnabled, comingSoonEnabled, provisioningEnabled } =
      await resolveBuilderFlagsForStorybook();
    viteConfig.define = {
      ...viteConfig.define,
      // This resolved Boolean is the only flag data included in the browser
      // bundle. The SDK key and discovery secret remain server-only.
      "process.env.STORYBOOK_BUILDER_COMING_SOON_ENABLED": JSON.stringify(
        String(comingSoonEnabled),
      ),
      "process.env.STORYBOOK_BUILDER_CONNECTIONS_ENABLED": JSON.stringify(
        String(connectionsEnabled),
      ),
      "process.env.STORYBOOK_BUILDER_PROVISIONING_ENABLED": JSON.stringify(
        String(provisioningEnabled),
      ),
    };
    viteConfig.resolve = {
      ...viteConfig.resolve,
      alias: [
        { find: "@/app/actions/source-handoff", replacement: storybookSourceActions },
        {
          find: /[/\\]app[/\\]actions[/\\]source-handoff(?:\.ts)?$/u,
          replacement: storybookSourceActions,
        },
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
