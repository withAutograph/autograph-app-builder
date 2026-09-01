import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./evals/product-quality",
  testMatch: "**/*.playwright.ts",
  forbidOnly: Boolean(process.env.CI),
  outputDir: ".artifacts/product-quality/playwright",
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  retries: 0,
  use: {
    browserName: "chromium",
    headless: true,
    trace: "on",
    deviceScaleFactor: 1,
  },
});
