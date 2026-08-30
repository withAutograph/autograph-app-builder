import { defineConfig, devices } from "playwright/test";

export default defineConfig({
  testDir: "./e2e/auth",
  outputDir: "test-results/auth-e2e-emulated",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "https://localhost:3001",
    ignoreHTTPSErrors: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [{ name: "auth-chromium", use: { browserName: "chromium" } }],
});
