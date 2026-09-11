import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./scripts/design-quality",
  testMatch: "**/*.playwright.ts",
  outputDir: ".artifacts/design-quality/tests",
  reporter: "list",
  workers: 1,
  retries: 0,
  use: { headless: true, browserName: "chromium" },
});
