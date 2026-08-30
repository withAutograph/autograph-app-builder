import { existsSync } from "node:fs";
import { dirname } from "node:path";

import { defineConfig, devices } from "playwright/test";

const mise = [
  `${process.env.HOME}/.local/share/mise/bin/mise`,
  `${process.env.HOME}/.local/bin/mise`,
].find(existsSync);
if (!mise) throw new Error("The mise executable is unavailable.");
const webServerPath = `${dirname(process.execPath)}:${dirname(mise)}:/usr/bin:/bin`;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results/web-product-e2e-emulated",
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
  projects: [
    {
      name: "web-product-chromium",
      use: {
        browserName: "chromium",
        launchOptions: { args: ["--ignore-certificate-errors"] },
      },
    },
  ],
  webServer: {
    command: `PATH=${JSON.stringify(webServerPath)} .config/mise/tasks/app/dev-emulated`,
    url: "https://localhost:3001/auth/sign-in",
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
