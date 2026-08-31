import { existsSync } from "node:fs";
import { dirname } from "node:path";

import { defineConfig, devices } from "playwright/test";

const mise = [
  `${process.env.HOME}/.local/share/mise/bin/mise`,
  `${process.env.HOME}/.local/bin/mise`,
].find(existsSync);
if (!mise) throw new Error("The mise executable is unavailable.");
const webServerPath = `${dirname(process.execPath)}:${dirname(mise)}:/usr/bin:/bin`;
const appPort = process.env.APP_BUILDER_LOCAL_PORT || "3001";
const appProtocol = "https";
const appOrigin = `${appProtocol}://localhost:${appPort}`;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results/web-product-e2e-emulated",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: appOrigin,
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
  webServer: process.env.APP_BUILDER_EXTERNAL_WEB_SERVER
    ? undefined
    : {
        command: `PATH=${JSON.stringify(webServerPath)} .config/mise/tasks/app/dev-emulated`,
        url: `${appProtocol}://127.0.0.1:${appPort}/auth/sign-in`,
        ignoreHTTPSErrors: true,
        reuseExistingServer: false,
        // A cold local checkout must initialize PostgreSQL, seed both
        // emulators, generate the certificate, and compile the first route.
        timeout: 300_000,
      },
});
