import { defineConfig, devices } from "playwright/test";

import { readNavigationFixture } from "./e2e/production-navigation/fixture";

export default defineConfig({
  fullyParallel: false,
  globalTimeout: 8 * 60_000,
  outputDir: "test-results/production-navigation",
  reporter: "list",
  retries: 0,
  testDir: "./e2e/production-navigation",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: readNavigationFixture().origin,
    ignoreHTTPSErrors: true,
    screenshot: "only-on-failure",
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  workers: 1,
});
