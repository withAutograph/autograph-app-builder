import { defineConfig, devices } from "playwright/test";

import { readNavigationFixture } from "./e2e/production-navigation/fixture";

export default defineConfig({
  testDir: "./e2e/production-navigation",
  testMatch: "**/*.spec.ts",
  outputDir: "test-results/production-navigation",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  globalTimeout: 8 * 60_000,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: readNavigationFixture().origin,
    ignoreHTTPSErrors: true,
    serviceWorkers: "block",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
