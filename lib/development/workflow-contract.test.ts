import { constants, readFileSync, statSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("two-mode development workflow contract", () => {
  it("exposes one mise-owned non-release entrypoint and keeps its mechanics internal", () => {
    const task = readFileSync(".config/mise/tasks/dev", "utf8");
    expect(task).toContain("scripts/development.mts");
    expect(task).toContain("mise which docker");
    expect(task).toContain("mise which msb");
    expect(
      statSync(".config/mise/tasks/dev").mode & constants.S_IXUSR,
    ).not.toBe(0);
    expect(() => statSync(".config/mise/tasks/dev:prove")).toThrow();

    const runner = readFileSync("scripts/development.mts", "utf8");
    expect(runner).toContain("createDevelopmentSnapshot");
    expect(runner).toContain("fingerprintDevelopmentSource");
    expect(runner).toContain("Arrusted source changed");
    expect(runner).toContain("createDevelopmentPackage");
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
    expect(dependencies).toContain('"scope": "development-execution"');
    expect(dependencies).toContain("DEPENDENCY_KEY");
    expect(dependencies).toContain("PLATFORM");
  });
});
