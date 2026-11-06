import path from "node:path";

import type { StorybookConfig } from "@storybook/nextjs-vite";
import type { Alias } from "vite";
import { z } from "zod";

import {
  builderComingSoonFlag,
  builderConnectionsFlag,
  builderResourceProvisioningFlag,
} from "../lib/feature-flags.ts";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export interface StorybookFlag {
  run: (context: { identify: Record<string, never>; request: Request }) => Promise<boolean>;
}

const resolveFlagForStorybook = async (flag: StorybookFlag, configured: boolean) => {
  if (!configured) return false;
  try {
    return await flag.run({
      identify: {},
      request: new Request("https://storybook.local"),
    });
  } catch {
    return false;
  }
};

const defaultStorybookFlags = {
  comingSoon: builderComingSoonFlag,
  connections: builderConnectionsFlag,
  provisioning: builderResourceProvisioningFlag,
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function resolveBuilderFlagsForStorybook(
  flags?: typeof defaultStorybookFlags,
  configured = process.env.FLAGS !== undefined && process.env.FLAGS !== "",
) {
  const resolvedFlags = flags ?? defaultStorybookFlags;
  const [connectionsEnabled, comingSoonEnabled, provisioningEnabled] = await Promise.all([
    resolveFlagForStorybook(resolvedFlags.connections, configured),
    resolveFlagForStorybook(resolvedFlags.comingSoon, configured),
    resolveFlagForStorybook(resolvedFlags.provisioning, configured),
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
    const existingAliases: unknown = viteConfig.resolve?.alias ?? [];
    const aliases: Alias[] = Array.isArray(existingAliases)
      ? existingAliases.map((alias: Alias) => alias)
      : Object.entries(existingAliases).map(([find, replacement]) => ({
          find,
          replacement: String(replacement),
        }));
    const storybookBuilderActions = path.join(import.meta.dirname, "builder-actions.ts");
    const storybookSourceActions = path.join(import.meta.dirname, "source-handoff-actions.ts");
    const storybookBuilderDraftActions = path.join(import.meta.dirname, "builder-draft-actions.ts");
    const { connectionsEnabled, comingSoonEnabled, provisioningEnabled } =
      await resolveBuilderFlagsForStorybook();
    const existingDefine: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(viteConfig.define ?? {})) {
      try {
        const parsedValue = z
          .union([z.string(), z.number(), z.boolean()])
          .safeParse(JSON.parse(String(value)));
        if (parsedValue.success) existingDefine[key] = parsedValue.data;
      } catch {
        // Vite define entries that are not JSON primitives are omitted.
      }
    }
    viteConfig.define = {
      ...existingDefine,
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
