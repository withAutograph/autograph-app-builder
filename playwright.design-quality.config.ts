import { defineConfig } from "playwright/test";

export default defineConfig({
  outputDir: ".artifacts/design-quality/tests",
  reporter: "list",
  retries: 0,
  testDir: "./scripts/design-quality",
  testMatch: "**/*.playwright.ts",
  use: { browserName: "chromium", headless: true },
  workers: 1,
});
