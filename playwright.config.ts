import { existsSync } from "node:fs";
import path from "node:path";

import { defineConfig, devices } from "playwright/test";

const mise = [
  `${process.env.HOME}/.local/share/mise/bin/mise`,
  `${process.env.HOME}/.local/bin/mise`,
].find(existsSync);
if (!mise) throw new Error("The mise executable is unavailable.");
const webServerPath = `${path.dirname(process.execPath)}:${path.dirname(mise)}:/usr/bin:/bin`;
const appPort = process.env.APP_BUILDER_LOCAL_PORT || "3001";
const appProtocol = "https";
const appOrigin = `${appProtocol}://localhost:${appPort}`;
const flagsStorageState = "test-results/passkey-flags-storage-state.json";

export default defineConfig({
  fullyParallel: false,
  // Individual tests have a 90-second bound, but CI also needs a suite-wide
  // terminal condition if the browser runner stops making progress.
  globalSetup: "./e2e/support/global-setup.ts",
  globalTimeout: process.env.CI ? 12 * 60_000 : undefined,
  outputDir: "test-results/web-product-e2e-emulated",
  projects: [
    {
      name: "web-product-chromium",
      use: {
        browserName: "chromium",
        launchOptions: { args: ["--ignore-certificate-errors"] },
      },
    },
  ],
  reporter: process.env.CI ? [["github"], ["line"], ["html", { open: "never" }]] : "list",
  retries: 0,
  testDir: "./e2e",
  testIgnore: "**/production-navigation/**",
  timeout: 90_000,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: appOrigin,
    ignoreHTTPSErrors: true,
    screenshot: "only-on-failure",
    storageState: flagsStorageState,
    trace: "retain-on-failure",
    video: "off",
  },
  webServer: process.env.APP_BUILDER_EXTERNAL_WEB_SERVER
    ? undefined
    : {
        command: `PATH=${JSON.stringify(webServerPath)} .config/mise/tasks/app/dev-emulated`,
        ignoreHTTPSErrors: true,
        reuseExistingServer: false,
        // A cold local checkout must initialize PostgreSQL, seed both
        // emulators, generate the certificate, and compile the first route.
        timeout: 300_000,
        url: `${appProtocol}://127.0.0.1:${appPort}/auth/sign-in`,
      },
  workers: 1,
});
