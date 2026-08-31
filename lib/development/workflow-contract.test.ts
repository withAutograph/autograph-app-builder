import { constants, readFileSync, statSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("two-mode development workflow contract", () => {
  it("exposes one mise-owned non-release entrypoint and keeps its mechanics internal", () => {
    const task = readFileSync(".config/mise/tasks/dev", "utf8");
    expect(task).toContain("scripts/development-entry.mts");
    expect(task).toContain("mise run local:ensure-oidc");
    expect(task).toContain("mise which codex");
    expect(task).toContain("CODEX_HOME");
    expect(task).not.toContain("mise which docker");
    expect(task).not.toContain("mise which msb");
    expect(
      statSync(".config/mise/tasks/dev").mode & constants.S_IXUSR,
    ).not.toBe(0);
    expect(() => statSync(".config/mise/tasks/dev:prove")).toThrow();

    const runner = readFileSync("scripts/development.mts", "utf8");
    expect(runner).toContain("createDevelopmentSnapshot");
    expect(runner).toContain("waitForDevelopmentSourceChange");
    expect(runner).toContain("createDevelopmentApplication");
    expect(runner).toContain("waitForDevelopmentRuntimeChange");
    expect(runner).toContain("createDevelopmentPackage");
    expect(runner).toContain("waitForDevelopmentMcp");
    expect(runner).toContain("registerDevelopmentPackage");
    expect(runner).toContain("node_modules/next/dist/bin/next");
    expect(runner.match(/node_modules\/next\/dist\/bin\/next/gu)).toHaveLength(
      1,
    );
    expect(runner).toContain('APP_BUILDER_SANDBOX_PROVIDER: "vercel"');
    expect(runner).toContain('WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS: "0"');
    expect(runner).not.toContain("microsandbox");
    expect(runner).not.toContain("docker");
    expect(runner).not.toContain("APP_BUILDER_SANDBOX_IMAGE");
    expect(runner.indexOf("waitForDevelopmentMcp")).toBeLessThan(
      runner.indexOf("registerDevelopmentPackage({"),
    );
    expect(runner.indexOf("registerDevelopmentPackage({")).toBeLessThan(
      runner.indexOf("development is ready"),
    );
    expect(runner).not.toContain('APP_BUILDER_LOCAL_PUBLICATION: "1"');
    expect(runner).not.toMatch(/vercel\s+(?:deploy|promote)/u);
    expect(runner).not.toMatch(/gh\s+(?:pr|repo|release)/u);
  });

  it("keys the Vercel template by dependencies without binding release artifacts", () => {
    const toolchain = readFileSync(
      "lib/sandbox/development-toolchain.ts",
      "utf8",
    );
    expect(toolchain).toContain('"scope":"development-execution"');
    expect(toolchain).toContain("developmentVercelProviderTemplateKey");
    expect(toolchain).toContain("developmentPinnedToolchainKey");
    expect(toolchain).not.toContain("hostedToolchainBootstrapCommand");
    expect(toolchain).not.toContain("hostedToolchainRevalidationKey");
  });

  it("exposes only prove and publish for release promotion and hides legacy helpers", () => {
    const prove = readFileSync(".config/mise/tasks/release/prove", "utf8");
    const publish = readFileSync(".config/mise/tasks/release/publish", "utf8");
    expect(prove).toContain("scripts/release-prove.mts");
    expect(publish).toContain("scripts/release-publish.mts");
    expect(
      statSync(".config/mise/tasks/release/prove").mode & constants.S_IXUSR,
    ).not.toBe(0);
    expect(
      statSync(".config/mise/tasks/release/publish").mode & constants.S_IXUSR,
    ).not.toBe(0);

    for (const helper of [
      ".config/mise/tasks/app/dev",
      ".config/mise/tasks/app/dev-emulated",
      ".config/mise/tasks/local/start",
      ".config/mise/tasks/image/build",
      ".config/mise/tasks/image/prove",
      ".config/mise/tasks/image/push",
      ".config/mise/tasks/package/build-portable-release",
      ".config/mise/tasks/package/prove-hosted",
    ])
      expect(readFileSync(helper, "utf8")).toContain("#MISE hide=true");
  });

  it("keeps contributor onboarding on the two public modes", () => {
    const readme = readFileSync("README.md", "utf8");
    const contributing = readFileSync("CONTRIBUTING.md", "utf8");

    expect(readme).toContain(
      "[How to develop App Builder locally](CONTRIBUTING.md)",
    );
    for (const command of [
      "mise run dev -- --help",
      "mise run release:prove -- --help",
      "mise run release:publish -- --help",
    ])
      expect(contributing).toContain(command);
    expect(contributing).toContain("app-builder@autograph-dev");
    expect(contributing).toContain("Ctrl+C");
    expect(contributing).not.toContain("dev:prove");

    const eslint = readFileSync("eslint.config.mjs", "utf8");
    expect(eslint).toContain('".artifacts/**"');
    const vitest = readFileSync("vitest.config.mts", "utf8");
    expect(vitest.match(/"\*\*\/\.artifacts\/\*\*"/gu)).toHaveLength(2);
  });
});
