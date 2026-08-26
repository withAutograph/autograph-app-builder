import { constants, promises as fs } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const read = (path: string) => fs.readFile(resolve(path), "utf8");

describe("mise-owned repository operations", () => {
  it("routes CI through one named mise task", async () => {
    const workflow = await read(".github/workflows/ci.yml");
    expect(workflow).toContain("uses: jdx/mise-action@v3");
    expect(workflow).toContain("run: mise run ci");
    expect(workflow).not.toMatch(/run: pnpm/u);

    const task = await read(".config/mise/tasks/ci");
    for (const operation of [
      "dependencies:install",
      "check",
      "test:agent",
      "agent:info",
      "package:build",
      "package:build-openai",
      "package:verify-generated",
      "app:build",
    ])
      expect(task).toContain(`mise run ${operation}`);
  });

  it("keeps public package and local lifecycle commands on named tasks", async () => {
    const readme = await read("README.md");
    expect(readme).toContain(
      "mise run package:configure -- --origin https://your-approved-deployment.example",
    );
    expect(readme).toContain("mise run package:validate-release");
    expect(readme).not.toContain("pnpm configure");

    const start = await read(".config/mise/tasks/local/start");
    expect(start).toContain("APP_BUILDER_FRESH_BOOTSTRAP_ENABLED=1");
    expect(start).toContain("node_modules/eve/bin/eve.js dev");
    expect(start).toContain("node_modules/next/dist/bin/next dev");
    expect(start).toContain("productionFreshBootstrapCapability");

    for (const task of [
      ".config/mise/tasks/ci",
      ".config/mise/tasks/agent/info",
      ".config/mise/tasks/agent/build",
      ".config/mise/tasks/app/build",
      ".config/mise/tasks/package/build-openai",
      ".config/mise/tasks/package/configure",
      ".config/mise/tasks/package/verify-generated",
    ]) {
      const mode = (await fs.stat(resolve(task))).mode;
      expect(mode & constants.S_IXUSR).not.toBe(0);
    }
  });
});
