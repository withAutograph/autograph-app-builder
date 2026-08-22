import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  inspectSupportedRepository,
  prepareSupportedWorkspace,
} from "./supported-template";

const previousRoots = process.env.REPOSITORY_LOCAL_ROOTS;
const previousWorkspaceRoot = process.env.REPOSITORY_WORKSPACE_ROOT;

afterEach(() => {
  if (previousRoots === undefined) delete process.env.REPOSITORY_LOCAL_ROOTS;
  else process.env.REPOSITORY_LOCAL_ROOTS = previousRoots;
  if (previousWorkspaceRoot === undefined)
    delete process.env.REPOSITORY_WORKSPACE_ROOT;
  else process.env.REPOSITORY_WORKSPACE_ROOT = previousWorkspaceRoot;
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "supported-template-"));
  const files: Record<string, string> = {
    ".config/mise/config.toml": [
      '[tasks."create:app"]',
      "run = 'mise exec -- bun .config/turbo/generators/create-app.ts --proposal \"$usage_proposal\"'",
      "",
      '[tasks."repository:preflight"]',
      'run = "mise run repository:exec -- repository-preflight.ts"',
      "",
      '[tasks."repository:exec"]',
      'run = "bun .config/mise/scripts/repository/$usage_script"',
    ].join("\n"),
    ".github/workflows/cd.yml": [
      "jobs:",
      "  release-gate:",
      "    name: Authorize (Repository release gate)",
      "    permissions:",
      "      actions: read",
      "    steps:",
      "      - run: REPOSITORY_RELEASE_ENABLED",
      "  preflight:",
      "    if: needs.release-gate.outputs.enabled == 'true'",
    ].join("\n"),
    "apps/shell/microfrontends.json": "{}\n",
    ".config/mise/scripts/repository/app-contract.ts":
      'const source = { runtime: "nextjs" };\n',
    ".config/mise/scripts/repository/app-identity.ts":
      'const scope = "@autograph/${appId}";\n',
    ".config/mise/scripts/repository/repository-preflight.ts": [
      'const observed = { runtime: "nextjs" };',
      'const appIdentity = "mise run repository:exec -- app-identity.ts --app <app-id>";',
      'const appPlan = "mise run repository:exec -- app-contract.ts --contract <contract-file>";',
      'const appApply = "mise run create:app -- --proposal <proposal-file>";',
      'const preflight = "mise run repository:preflight";',
      'const validation = ["mise run check", "mise run test"];',
    ].join("\n"),
    ".config/mise/scripts/repository/repository-release-gate.sh": [
      'gh api "repos/$GITHUB_REPOSITORY/actions/variables/REPOSITORY_RELEASE_ENABLED"',
      'if [[ "$value" == "true" ]]; then',
    ].join("\n"),
    ".config/turbo/generators/config.ts": 'const scope = "autograph";\n',
    ".config/turbo/generators/create-app.ts": "export {};\n",
    ".config/turbo/generators/templates/app/next.config.ts.hbs":
      "export default {};\n",
  };
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content);
  }
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["add", "--", ...Object.keys(files)], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "fixture",
    ],
    {
      cwd: root,
    },
  );
  return root;
}

describe("supported-template adapter", () => {
  it("accepts only the closed V0 surface and prepares the exact SHA", async () => {
    const root = fixture();
    process.env.REPOSITORY_LOCAL_ROOTS = root;
    process.env.REPOSITORY_WORKSPACE_ROOT = mkdtempSync(
      join(tmpdir(), "builder-workspaces-"),
    );
    const eligibility = await inspectSupportedRepository(root);
    expect(eligibility.eligible).toBe(true);
    expect(eligibility.observed.runtime).toBe("nextjs");
    expect(eligibility.observed.planningCommand).toBe(
      "mise run repository:exec -- app-contract.ts --contract <contract-file>",
    );
    const prepared = await prepareSupportedWorkspace(
      root,
      eligibility.sourceSha!,
    );
    expect(
      execFileSync("git", ["-C", prepared.workspacePath, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
    ).toBe(eligibility.sourceSha);
  });

  it("fails closed when the planner still declares Vite", async () => {
    const root = fixture();
    writeFileSync(
      join(root, ".config/mise/scripts/repository/app-contract.ts"),
      'const source = { runtime: "vite" };\n',
    );
    process.env.REPOSITORY_LOCAL_ROOTS = root;
    const eligibility = await inspectSupportedRepository(root);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.failures).toContain(
      "app planner does not declare the Next.js runtime",
    );
  });

  it("rejects legacy adapter paths instead of inferring replacements", async () => {
    const root = fixture();
    const current = join(root, ".config/turbo/generators/create-app.ts");
    const legacy = join(root, "turbo/generators/create-app.ts");
    mkdirSync(join(legacy, ".."), { recursive: true });
    writeFileSync(legacy, "export {};\n");
    unlinkSync(current);
    process.env.REPOSITORY_LOCAL_ROOTS = root;
    const eligibility = await inspectSupportedRepository(root);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.failures).toContain(
      "missing required path .config/turbo/generators/create-app.ts",
    );
  });

  it("rejects alternate release-gate declarations", async () => {
    const root = fixture();
    writeFileSync(
      join(root, ".github/workflows/cd.yml"),
      "jobs:\n  release-gate:\n    name: something else\n",
    );
    process.env.REPOSITORY_LOCAL_ROOTS = root;
    const eligibility = await inspectSupportedRepository(root);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.failures).toContain(
      "REPOSITORY_RELEASE_ENABLED gate is not the supported CD gate",
    );
  });
});
