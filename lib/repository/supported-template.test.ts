import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
    ".config/mise/config.toml":
      '[tasks."create:app"]\nrun = "create"\n\n[tasks."repository:preflight"]\nrun = "check"\n',
    ".github/workflows/release.yml": "# REPOSITORY_RELEASE_ENABLED\n",
    "apps/shell/microfrontends.json": "{}\n",
    "scripts/app-contract.ts": 'const source = { runtime: "nextjs" };\n',
    "scripts/app-identity.ts": "export {};\n",
    "turbo/generators/config.ts": 'const scope = "autograph";\n',
    "turbo/generators/create-app.ts": "export {};\n",
    "turbo/generators/templates/app/next.config.ts.hbs": "export default {};\n",
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
      join(root, "scripts/app-contract.ts"),
      'const source = { runtime: "vite" };\n',
    );
    process.env.REPOSITORY_LOCAL_ROOTS = root;
    const eligibility = await inspectSupportedRepository(root);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.failures).toContain(
      "app planner does not declare the Next.js runtime",
    );
  });
});
