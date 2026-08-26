import { constants, promises as fs } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const read = (path: string) => fs.readFile(resolve(path), "utf8");

describe("mise-owned repository operations", () => {
  it("routes each parallel CI lane through a named mise task", async () => {
    const workflow = await read(".github/workflows/ci.yml");
    expect(workflow).toContain("uses: jdx/mise-action@v3");
    expect(workflow).not.toMatch(/run: pnpm/u);

    const parsed = parse(workflow) as {
      jobs: Record<
        string,
        {
          if?: string;
          needs?: string[];
          steps: Array<{
            uses?: string;
            run?: string;
            with?: Record<string, string>;
          }>;
        }
      >;
    };
    const lanes = {
      repository: "ci-repository",
      "eve-general": "ci-eve-general",
      "eve-fresh-bootstrap": "ci-eve-fresh-bootstrap",
      "sandbox-toolchain": "ci-sandbox-toolchain",
      "package-build": "ci-package-build",
    } as const;

    expect(Object.keys(parsed.jobs).sort()).toEqual(
      [...Object.keys(lanes), "check"].sort(),
    );
    for (const [jobName, taskName] of Object.entries(lanes)) {
      const job = parsed.jobs[jobName];
      expect(job.steps).toContainEqual({ uses: "jdx/mise-action@v3" });
      expect(job.steps).toContainEqual({
        uses: "actions/setup-node@v4",
        with: {
          "node-version": "24.18.0",
          cache: "pnpm",
          "cache-dependency-path": "pnpm-lock.yaml",
        },
      });
      expect(job.steps).toContainEqual({
        run: "mise run dependencies:install",
      });
      expect(job.steps).toContainEqual({ run: `mise run ${taskName}` });
    }

    expect(parsed.jobs.check.if).toBe("${{ always() }}");
    expect(parsed.jobs.check.needs).toEqual(Object.keys(lanes));
    const aggregate = parsed.jobs.check.steps
      .map(({ run }) => run ?? "")
      .join("\n");
    for (const lane of Object.keys(lanes))
      expect(aggregate).toContain(`needs.${lane}.result`);

    const general = await read(".config/mise/tasks/ci-eve-general");
    expect(general).toContain("mise run test:general-evals");
    const generalEvals = await read(".config/mise/tasks/test/general-evals");
    expect(generalEvals).toContain("--exclude-tag fresh-bootstrap-publication");
    expect(generalEvals).toContain("--exclude-tag sandbox-toolchain");
    const fresh = await read(".config/mise/tasks/ci-eve-fresh-bootstrap");
    expect(fresh).toContain("mise run test:fresh-bootstrap-evals");
    expect(fresh).not.toContain("test:sandbox-toolchain");
    const sandbox = await read(".config/mise/tasks/ci-sandbox-toolchain");
    expect(sandbox).toContain("mise run test:sandbox-toolchain");

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
      ".config/mise/tasks/package/build-portable-release",
      ".config/mise/tasks/package/configure",
      ".config/mise/tasks/package/install-portable",
      ".config/mise/tasks/package/smoke-portable",
      ".config/mise/tasks/package/test-portable",
      ".config/mise/tasks/package/verify-generated",
    ]) {
      const mode = (await fs.stat(resolve(task))).mode;
      expect(mode & constants.S_IXUSR).not.toBe(0);
    }
  });
});
