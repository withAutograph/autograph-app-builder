import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createSupportedRepositoryFixture(): string {
  if (process.env.APP_BUILDER_BRANCH_WORKTREE_PUBLICATION === "1")
    mkdirSync(join(tmpdir(), "autograph-app-builder-branch-publication"), {
      recursive: true,
      mode: 0o700,
    });
  const root = mkdtempSync(join(tmpdir(), "app-builder-eval-repository-"));
  const files: Record<string, string> = {
    ".config/mise/config.toml": [
      '[tasks."create:app"]',
      "run = 'mise exec -- bun .config/turbo/generators/create-app.ts --proposal \"$usage_proposal\"'",
      "",
      '[tasks."repository:preflight"]',
      'run = "mise run repository:exec -- repository-preflight.ts"',
      "",
      '[tasks."generate:app"]',
      "run = 'turbo gen --config .config/turbo/generators/config.ts app --args \"$usage_app_id\"'",
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
    { cwd: root },
  );
  return root;
}
