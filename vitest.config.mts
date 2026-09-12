import path from "node:path";
import { fileURLToPath } from "node:url";

import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import { configDefaults, defineConfig } from "vitest/config";

// Vitest evaluates this config from its generated `.vite-temp` directory.
// Keep the URL-derived path so Storybook resolves the repository config.
// oxlint-disable-next-line unicorn/prefer-import-meta-properties
const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": dirname,
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          exclude: [
            ...configDefaults.exclude,
            "**/.artifacts/**",
            "**/.eve/**",
            "**/.storybook/visual/**",
            "**/e2e/**",
          ],
          maxWorkers: 2,
          pool: "threads",
          testTimeout: 10_000,
        },
      },
      {
        extends: true,
        plugins: [storybookTest({ configDir: path.join(dirname, ".storybook") })],
        test: {
          name: "storybook",
          exclude: [...configDefaults.exclude, "**/.artifacts/**"],
          fileParallelism: false,
          maxWorkers: 1,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({}),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
