import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const SUPPORTED_TEMPLATE_WORKFLOW_FIXTURE = [
  "jobs:",
  "  template-safety:",
  "    name: Authorize (Template instance safety)",
  "    permissions: {}",
  "    outputs:",
  `      enabled: \${{ steps.safety.outputs.enabled }}`,
  "    steps:",
  "      - id: safety",
  "        name: Read active repository safety flag",
  "        env:",
  `          REPOSITORY_RELEASE_ENABLED: \${{ vars.REPOSITORY_RELEASE_ENABLED }}`,
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

/**
 * A target-owned composition policy fixture. The builder binds these bytes to
 * the source receipt selected for each evaluation rather than trusting a
 * component name from a prompt or a screenshot.
 */
export const ARRUSTED_COMPONENT_COMPOSITION_MANIFEST = `${JSON.stringify(
  {
    kind: "arrusted-component-composition-v1",
    providers: ["@autograph/components/providers"],
    publicImports: ["@autograph/components", "@autograph/compositions", "@autograph/icons"],
    routeGlue: {
      allowedFiles: ["app/layout.tsx", "app/page.tsx"],
      allowedStyleFiles: [],
    },
    tokenEntrypoints: ["@autograph/design-system/tokens.css"],
    version: 1,
  },
  null,
  2,
)}\n`;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
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

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createSupportedRepositoryFixture(): string {
  if (process.env.APP_BUILDER_BRANCH_WORKTREE_PUBLICATION === "1") {
    mkdirSync(path.join(tmpdir(), "autograph-app-builder-branch-publication"), {
      mode: 0o700,
      recursive: true,
    });
  }
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "app-builder-eval-repository-")));
  const files: Record<string, string> = {
    ".config/mise/config.toml": [
      '[tasks."create:app"]',
      "run = 'mise exec --no-deps -- bun .config/turbo/generators/create-app.ts \"$usage_app\"'",
      "",
      '[tasks."repository:preflight"]',
      'run = "mise run repository:exec -- repository-preflight.ts"',
      "",
      '[tasks."generate:app"]',
      "run = 'turbo gen --config .config/turbo/generators/config.ts app --args \"$usage_app_id\"'",
      "",
      '[tasks."app:check-build"]',
      "run = 'bun .config/mise/scripts/repository/app-validation.ts check-build \"$usage_app\"'",
      "",
      '[tasks."app:test"]',
      'run = \'bun .config/mise/scripts/repository/app-validation.ts test "$usage_app" "$usage_shard"\'',
    ].join("\n"),
    ".config/mise/scripts/repository/app-identity.ts": `const scope = "@autograph/\${appId}";\n`,
    ".config/mise/scripts/repository/app-validation.ts": "export {};\n",
    ".config/mise/scripts/repository/repository-preflight.ts": [
      'const observed = { runtime: "nextjs" };',
      'const appIdentity = "mise run repository:exec -- app-identity.ts --app <app-id>";',
      'const appApply = "mise run create:app <app-id>";',
      'const preflight = "mise run repository:preflight";',
      'const validation = ["mise run app:check-build <app-id>", "mise run app:test <app-id> <shard>"];',
    ].join("\n"),
    ".config/mise/scripts/repository/resolved-app-creation.ts":
      'const source = { runtime: "nextjs" };\n',
    ".config/mise/tasks/repository/exec": [
      "#!/usr/bin/env bash",
      `exec mise exec -- bun ".config/mise/scripts/repository/$1" "\${@:2}"`,
      "",
    ].join("\n"),
    ".config/turbo/generators/config.ts": 'const scope = "autograph";\n',
    ".config/turbo/generators/create-app.ts": "export {};\n",
    ".config/turbo/generators/templates/app/next.config.ts.hbs": "export default {};\n",
    ".github/workflows/cd.yml": SUPPORTED_TEMPLATE_WORKFLOW_FIXTURE,
    "docs/component-composition.json": ARRUSTED_COMPONENT_COMPOSITION_MANIFEST,
    "microfrontends.json": "{}\n",
    "package.json": `${JSON.stringify(
      {
        dependencies: { next: "16.1.6" },
        name: "@autograph/supported-repository-fixture",
        private: true,
      },
      null,
      2,
    )}\n`,
  };
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = path.join(root, relativePath);
    mkdirSync(path.join(absolute, ".."), { recursive: true });
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
