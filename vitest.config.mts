import path from "node:path";
import { fileURLToPath } from "node:url";

import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import { configDefaults, defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
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
        plugins: [
          storybookTest({ configDir: path.join(dirname, ".storybook") }),
        ],
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
