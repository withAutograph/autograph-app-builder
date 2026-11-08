import { defineConfig } from "playwright/test";

export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  outputDir: ".artifacts/product-quality/playwright",
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  retries: 0,
  testDir: "./evals/product-quality",
  testMatch: "**/*.playwright.ts",
  use: {
    browserName: "chromium",
    deviceScaleFactor: 1,
    headless: true,
    trace: "on",
  },
});
