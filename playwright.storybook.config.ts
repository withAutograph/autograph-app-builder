import { defineConfig } from "playwright/test";

const baseURL = "http://127.0.0.1:6018";

export default defineConfig({
  testDir: ".storybook/visual",
  forbidOnly: Boolean(process.env.CI),
  reporter: "list",
  retries: 0,
  snapshotPathTemplate: "{testDir}/__snapshots__/{testFilePath}/{arg}{ext}",
  use: {
    baseURL,
    deviceScaleFactor: 1,
  },
  webServer: {
    command: `${process.execPath} node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 6018 --outDir storybook-static`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    url: baseURL,
  },
});
