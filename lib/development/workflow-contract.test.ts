import { constants, readFileSync, statSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("two-mode development workflow contract", () => {
  it("exposes one mise-owned non-release entrypoint and keeps its mechanics internal", () => {
    const task = readFileSync(".config/mise/tasks/dev", "utf8");
    expect(task).toContain("scripts/development.mts");
    expect(task).toContain("mise which docker");
    expect(task).toContain("mise which msb");
    expect(task).toContain("mise which codex");
    expect(task).toContain("CODEX_HOME");
    expect(
      statSync(".config/mise/tasks/dev").mode & constants.S_IXUSR,
    ).not.toBe(0);
    expect(() => statSync(".config/mise/tasks/dev:prove")).toThrow();

    const runner = readFileSync("scripts/development.mts", "utf8");
    expect(runner).toContain("createDevelopmentSnapshot");
    expect(runner).toContain("waitForDevelopmentSourceChange");
    expect(runner).toContain("Arrusted source changed");
    expect(runner).toContain("createDevelopmentPackage");
    expect(runner).toContain("waitForDevelopmentMcp");
    expect(runner).toContain("registerDevelopmentPackage");
    expect(runner).toContain('join(stateRoot, "microsandbox-home")');
    expect(runner).toContain("APP_BUILDER_DEV_RUNTIME_HOME");
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

  it("separates the stable toolchain from platform-specific reusable dependency state", () => {
    const toolchain = readFileSync(
      "containers/eve-sandbox/dev-toolchain.Dockerfile",
      "utf8",
    );
    const dependencies = readFileSync(
      "containers/eve-sandbox/dev-dependencies.Dockerfile",
      "utf8",
    );
    expect(toolchain).not.toContain("arrusted-source");
    expect(toolchain).not.toContain("bun install --frozen-lockfile");
    expect(toolchain).toContain(
      'dev.autograph.scope="os-node-bun-mise-microsandbox"',
    );
    expect(dependencies).toContain("COPY --from=arrusted-source");
    expect(dependencies).toContain(
      "bun install --frozen-lockfile --ignore-scripts",
    );
    expect(dependencies).toContain(
      'if ! dependency_target="$(readlink -f -- "${dependency_link}")"',
    );
    expect(dependencies).toContain(
      "COPY --from=dependency-builder /opt/app-builder/cargo /opt/app-builder/cargo",
    );
    expect(dependencies).toContain('"scope": "development-execution"');
    expect(dependencies).toContain("DEPENDENCY_KEY");
    expect(dependencies).toContain("PLATFORM");
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
  });
});
