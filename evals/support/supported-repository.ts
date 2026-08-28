import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SUPPORTED_TEMPLATE_WORKFLOW_FIXTURE = [
  "jobs:",
  "  template-safety:",
  "    name: Authorize (Template instance safety)",
  "    permissions: {}",
  "    outputs:",
  "      enabled: ${{ steps.safety.outputs.enabled }}",
  "    steps:",
  "      - id: safety",
  "        name: Read active repository safety flag",
  "        env:",
  "          REPOSITORY_RELEASE_ENABLED: ${{ vars.REPOSITORY_RELEASE_ENABLED }}",
  "        run: |",
  "          set -euo pipefail",
  '          value="$REPOSITORY_RELEASE_ENABLED"',
  "          enabled=false",
  '          if [[ "$value" == "true" ]]; then',
  "            enabled=true",
  "          fi",
  '          echo "enabled=$enabled" >> "$GITHUB_OUTPUT"',
  "  scope:",
  "    needs: template-safety",
  "    if: needs.template-safety.outputs.enabled == 'true' && github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == github.event.repository.default_branch && github.event.workflow_run.head_repository.full_name == github.repository",
].join("\n");

function fixtureGit(root: string, args: string[]): void {
  execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.excludesfile=/dev/null",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: root, env: { ...process.env, HK: "0" } },
  );
}

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
    ".github/workflows/cd.yml": SUPPORTED_TEMPLATE_WORKFLOW_FIXTURE,
    "microfrontends.json": "{}\n",
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
  fixtureGit(root, ["init", "-b", "main"]);
  fixtureGit(root, ["add", "--", ...Object.keys(files)]);
  fixtureGit(root, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "fixture",
  ]);
  return root;
}
