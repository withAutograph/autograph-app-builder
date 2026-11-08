import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import jsPlugins, { jsPluginSettings } from "ultracite/oxlint/js-plugins";
import next from "ultracite/oxlint/next";
import nextJsPlugins from "ultracite/oxlint/next/js-plugins";

const previewActivationCli = "lib/db/preview-activation-cli.mts";

const githubProviderPath = "lib/provisioning/github-provider.ts";
const handoffProgressPath = "app/ui/handoff-provisioning-progress.tsx";
const productionCreatorTestPath = "lib/provisioning/repository-production-creator.test.ts";

export default defineConfig({
  extends: [core, next, jsPlugins, nextJsPlugins, antiSlop],
  ignorePatterns: core.ignorePatterns,
  jsPlugins: jsPlugins.jsPlugins,
  options: {
    typeAware: true,
  },
  overrides: [
    {
      // Git object identity requires the existing SHA-1 format.
      files: [
        "lib/provisioning/github-provider.test.ts",
        githubProviderPath,
        "lib/repository/dependency-cache.test.ts",
        "lib/repository/fresh-bootstrap.ts",
        "lib/repository/github-publication.test.ts",
        "lib/repository/node-fresh-bootstrap.ts",
      ],
      rules: { "sonarjs/hashing": "off" },
    },
    {
      // Preserve existing provider and string lookup behavior pending review.
      files: [
        "evals/support/product-quality.ts",
        "lib/auth/cursor-client.ts",
        githubProviderPath,
        "lib/provisioning/vercel-provider.ts",
      ],
      rules: { "react-doctor/js-set-map-lookups": "off" },
    },
    {
      files: [
        "evals/support/self-reproduction-runtime.ts",
        "scripts/design-quality/archive.mts",
        "scripts/design-quality/rescore.mts",
        "scripts/smoke-portable-plugin.mts",
        "scripts/test-capability-preload.mjs",
      ],
      rules: { "typescript/no-unsafe-call": "off" },
    },
    {
      files: ["evals/support/self-reproduction-candidate-workflows.ts"],
      rules: { "github/no-blur": "off" },
    },
    {
      files: [githubProviderPath],
      rules: { "react-doctor/js-cache-property-access": "off" },
    },
    {
      files: ["components/auth/additional-field.tsx"],
      rules: { "react-doctor/js-hoist-intl": "off" },
    },
    {
      files: ["app/ui/handoff-controls.tsx"],
      rules: { "react-doctor/no-fetch-in-effect": "off" },
    },
    {
      files: [handoffProgressPath],
      rules: { "react-doctor/no-derived-state": "off" },
    },
    {
      files: [handoffProgressPath],
      rules: { "react-doctor/no-derived-state-effect": "off" },
    },
    {
      files: ["lib/mcp/session-app/index.tsx"],
      rules: { "react-doctor/rerender-lazy-ref-init": "off" },
    },
    {
      files: ["app/ui/use-builder-draft-autosave.ts"],
      rules: { "sonarjs/pseudo-random": "off" },
    },
    {
      // Preserve hoisting of exported environment setup functions.
      files: ["scripts/eve-worker-environment.mjs", "scripts/gate-a-eval-profile.mjs"],
      rules: { "eslint/func-style": "off" },
    },
    {
      // Retain existing receiver and callback behavior pending review.
      files: [
        "lib/auth/preview-auth-ui.test.ts",
        "lib/auth/preview-cimd-transport.ts",
        "lib/image/ghcr-bound-helper.ts",
        productionCreatorTestPath,
      ],
      rules: { "typescript/unbound-method": "off" },
    },
    {
      // Preserve existing runtime contracts pending focused migration.
      files: ["lib/eve/same-origin-http.ts"],
      rules: { "typescript/no-misused-spread": "off" },
    },
    {
      // Preserve existing runtime contracts pending focused migration.
      files: ["lib/eve/public-events.ts", "lib/eve/service.ts"],
      rules: { "typescript/switch-exhaustiveness-check": "off" },
    },
    {
      // Preserve existing runtime contracts pending focused migration.
      files: ["scripts/design-quality/archive-entry.ts", "scripts/test-capability-preload.mjs"],
      rules: { "typescript/no-unsafe-return": "off" },
    },
    {
      // Preserve exhaustive-switch errors for unexpected runtime values.
      files: [
        "lib/auth/preview-user-management.ts",
        "lib/eve/hosted-service.test.ts",
        "scripts/eval-self-reproduction.mts",
      ],
      rules: { "typescript/restrict-template-expressions": "off" },
    },
    {
      // Preserve existing callback and abort behavior pending contract review.
      files: ["lib/development/mcp-readiness.ts"],
      rules: { "typescript/only-throw-error": "off" },
    },
    {
      // Preserve existing callback and abort behavior pending contract review.
      files: [
        "components/auth/additional-field.tsx",
        "lib/agent/product-behavior.test.ts",
        "scripts/self-reproduction-live.mts",
      ],
      rules: { "typescript/no-misused-promises": "off" },
    },
    {
      // Existing findings awaiting behavior-preserving contract changes.
      files: [
        "lib/auth/postgres-organization-user-authority.ts",
        "lib/repository/local-publication.ts",
      ],
      rules: { "typescript/no-unnecessary-type-parameters": "off" },
    },
    {
      // Existing findings awaiting behavior-preserving contract changes.
      files: [
        "lib/agent/application-review-context-store.test.ts",
        "lib/agent/fresh-bootstrap-source.test.ts",
        "lib/agent/github-destination-review-workflow.test.ts",
        "lib/agent/prior-validated-private-artifact.test.ts",
        "lib/agent/product-behavior-validation.test.ts",
        "lib/eve/native-live-quiescence.test.ts",
        "lib/eve/private-hosted-approval.test.ts",
        "lib/eve/test-support/draft-reviewed-recovery.ts",
        "lib/provisioning/builder-session-destination.test.ts",
        "lib/provisioning/hosted-continuity-approval-recovery.test.ts",
        "lib/provisioning/hosted-operator-composition.test.ts",
        "lib/provisioning/hosted-operator-deployment.ts",
        "lib/provisioning/hosted-operator-export-artifacts.test.ts",
        "lib/provisioning/hosted-operator-export.test.ts",
        "lib/provisioning/hosted-operator-participant-successor.test.ts",
        "lib/provisioning/hosted-operator-unapproved-actor-journal.test.ts",
        "lib/provisioning/public-release-dispatcher.ts",
        "lib/provisioning/repository-production-setup.test.ts",
        "lib/repository/canonical-acquisition-alignment.test.ts",
        "lib/repository/local-planning-source.test.ts",
        "lib/repository/local-preview-auth-origin.test.ts",
        "lib/sandbox/managed-runtime.test.ts",
        "oxlint.config.ts",
        "scripts/eve-eval-fetch-preload.mjs",
        "scripts/eve-recovery-holder-observation.test.mjs",
      ],
      rules: { "unicorn/consistent-function-scoping": "off" },
    },
    {
      // Preserve existing rejection handling until its value contract is narrowed.
      files: ["scripts/release-publish.mts", "scripts/self-reproduction-live.mts"],
      rules: { "typescript/use-unknown-in-catch-callback-variable": "off" },
    },
    {
      // Preserve explicit boolean distinctions in existing boundary checks.
      files: [
        ".storybook/main.ts",
        "app/ui/use-builder-draft-autosave.ts",
        "components/auth/oauth-provider/oauth-consent.tsx",
        "lib/auth/postgres-organization-user-authority.ts",
        previewActivationCli,
        "lib/db/preview-activation-invited-user.ts",
        "lib/provisioning/repository-production-native.ts",
        "lib/repository/fresh-bootstrap.ts",
        "lib/repository/github-publication.ts",
      ],
      rules: { "typescript/no-unnecessary-boolean-literal-compare": "off" },
    },
    {
      // Existing explicit undefined values awaiting contract review.
      files: [
        "app/actions/builder.test.ts",
        "app/ui/app-builder.test.tsx",
        "app/ui/builder-draft-outbox.ts",
        "app/ui/handoff-controls.tsx",
        handoffProgressPath,
        "app/ui/use-builder-controller.ts",
        "components/auth/passkey/add-passkey-dialog.tsx",
        "lib/agent/deployment-repository-access-runtime.test.ts",
        "lib/agent/fresh-published-draft-preparation.test.ts",
        "lib/agent/hosted-github-publication-runtime.test.ts",
        "lib/agent/prepare-app-creation-projection.test.ts",
        "lib/agent/review-applied-product-source.test.ts",
        "lib/db/migrate-execution.test.ts",
        previewActivationCli,
        "lib/handoff/deployment.test.ts",
        "lib/handoff/page-data.test.ts",
        "lib/provisioning/hosted-operator-ready-delivery-replacement.test.ts",
        productionCreatorTestPath,
      ],
      rules: { "unicorn/no-useless-undefined": "off" },
    },
    {
      // Preserve the existing error classes at these validation boundaries.
      files: [
        ".config/mise/scripts/repository/build-hosted-arrusted-artifact.mts",
        "lib/provisioning/starter-source.ts",
      ],
      rules: { "unicorn/prefer-type-error": "off" },
    },
    {
      // These files are owned by concurrent work and retain their existing findings.
      files: [
        "app/ui/app-access.tsx",
        "app/ui/app-access.test.tsx",
        "lib/app-access/management.ts",
        "lib/app-access/native-management.ts",
        "lib/eve/private-repository-production-approval.test.ts",
        "lib/provisioning/repository-production-creator.ts",
        productionCreatorTestPath,
        "lib/provisioning/repository-production-native.ts",
        "lib/provisioning/repository-production-setup.test.ts",
        "scripts/eve-eval-fetch-preload.mjs",
      ],
      rules: { "eslint/curly": "off" },
    },
    {
      // Existing assertions awaiting behavior-preserving type boundaries.
      files: [
        "e2e/support/harness.ts",
        "lib/agent/accept-app-spec-resume.test.ts",
        "lib/auth/cursor-client.test.ts",
        "lib/auth/preview-cimd-transport.ts",
        "lib/eve/postgres-workspace-membership.test.ts",
        "lib/eve/same-origin-http.ts",
        "lib/eve/service.test.ts",
        "lib/handoff/postgres-store.test.ts",
        "lib/integrations/postgres-vercel-installation.test.ts",
        "lib/provisioning/github-provider.test.ts",
        "lib/provisioning/github-webhook.test.ts",
        "lib/repository/direct-app-creation.test.ts",
        "lib/repository/postgres-github-publication-receipt-store.test.ts",
        "lib/repository/source-receipt.ts",
        "lib/sandbox/deployment-execution-lease.ts",
        "lib/sandbox/hosted-bun-runtime.test.ts",
        "lib/sandbox/postgres-execution-lease-store.ts",
        "lib/sandbox/working-preview-lifecycle.test.ts",
        "lib/sandbox/working-preview-runtime.test.ts",
        "lib/testing/test-capability.ts",
        "scripts/design-quality/source.ts",
        "scripts/test-capability-preload.test.ts",
      ],
      rules: { "anti-slop/no-chained-type-assertions": "off" },
    },
    {
      files: ["lib/eve/hosted-service.ts"],
      rules: { "typescript/return-await": "off" },
    },
    {
      // Eve derives public tool IDs from these existing filenames.
      files: ["agent/tools/*_*.ts"],
      rules: {
        "github/filenames-match-regex": "off",
        "unicorn/filename-case": "off",
      },
    },
    {
      // These callbacks must reject on synchronous failures while returning promises.
      files: [
        "app/ui/app-access.test.tsx",
        "e2e/auth/client-oauth-handoff.spec.ts",
        "lib/agent/local-source-transport-history.test.ts",
        "lib/agent/product-behavior-validation.test.ts",
        "lib/eve/hosted-service.test.ts",
        "lib/eve/native-live-quiescence.test.ts",
        "lib/db/hosted-github-installation.test.ts",
        "lib/handoff/page-data.test.ts",
        "lib/provisioning/hosted-operator-execution-observation.test.ts",
        "lib/provisioning/hosted-operator-ready-delivery-replacement.test.ts",
        "lib/provisioning/native-target-onboarding-service.test.ts",
        "lib/repository/planning-overlay.test.ts",
      ],
      rules: { "eslint/require-await": "off" },
    },
    {
      // Retain module namespaces required by flags, live spies, adapters and database schemas.
      files: [
        ".config/mise/scripts/repository/test-postgres-sandbox-leases.mts",
        "app/.well-known/vercel/flags/route.ts",
        "app/ui/app-builder.test.tsx",
        "e2e/auth/client-oauth-handoff.spec.ts",
        "e2e/builder/builder-draft-store.spec.ts",
        "e2e/builder/builder-handoff.spec.ts",
        "evals/support/self-reproduction-reference-lifecycle.ts",
        "lib/auth/cursor-client-setup.mts",
        "lib/auth/preview-oauth-deployment.ts",
        previewActivationCli,
        "lib/integrations/preview-emulate-handler.ts",
      ],
      rules: { "sonarjs/no-wildcard-import": "off" },
    },
    {
      // Temporary migration baseline for existing test findings.
      files: ["**/*.{test,spec}.{js,jsx,ts,tsx,mjs,mts,cjs,cts}"],
      rules: {
        "sonarjs/public-static-readonly": "off",
        "anti-slop/no-module-mocking": "off",
        "github/no-inner-html": "off",
        "react-doctor/no-secrets-in-client-code": "off",
        "sonarjs/code-eval": "off",
        "sonarjs/hardcoded-secret-signatures": "off",
        "sonarjs/no-clear-text-protocols": "off",
        "sonarjs/no-hardcoded-ip": "off",
        "sonarjs/no-hardcoded-passwords": "off",
        "typescript/no-implied-eval": "off",
        "typescript/prefer-promise-reject-errors": "off",
      },
    },
  ],
  rules: {
    // Temporary migration baseline; remove these as findings are fixed.
    "typescript/promise-function-async": "off",
    "anti-slop/no-conditional-empty-object-spread": "off",
    "anti-slop/no-known-value-widening": "off",
    "anti-slop/no-runtime-typeof": "off",
    "anti-slop/no-unknown-parameters": "off",
    "anti-slop/no-unknown-returns": "off",
    "anti-slop/no-unsafe-dictionary-type": "off",
    "anti-slop/require-safety-comment-for-type-assertion": "off",
    "eslint/no-await-in-loop": "off",
    "github/filenames-match-regex": "off",
    "github/no-then": "off",
    "react-doctor/async-await-in-loop": "off",
    "react-doctor/async-parallel": "off",
    "react-doctor/effect-needs-cleanup": "off",
    "react-doctor/js-index-maps": "off",
    "react-doctor/nextjs-no-client-side-redirect": "off",
    "react-doctor/no-chain-state-updates": "off",
    "react-doctor/no-giant-component": "off",
    "react-doctor/no-pass-data-to-parent": "off",
    "react-doctor/prefer-html-dialog": "off",
    "react-doctor/server-sequential-independent-await": "off",
    "sonarjs/cognitive-complexity": "off",
    "sonarjs/expression-complexity": "off",
    "sonarjs/function-name": "off",
    "sonarjs/max-union-size": "off",
    "sonarjs/no-os-command-from-path": "off",
    "sonarjs/no-undefined-assignment": "off",
    "sonarjs/publicly-writable-directories": "off",
    "sonarjs/too-many-break-or-continue-in-loop": "off",
    "typescript/consistent-return": "off",
    "typescript/no-base-to-string": "off",
    "typescript/no-confusing-void-expression": "off",
    "typescript/no-unsafe-argument": "off",
    "typescript/no-unsafe-assignment": "off",
    "typescript/no-unsafe-member-access": "off",
    "typescript/no-unsafe-type-assertion": "off",
    "typescript/prefer-nullish-coalescing": "off",
    "typescript/strict-boolean-expressions": "off",
    "typescript/strict-void-return": "off",
    "eslint/complexity": "off",
    // Temporary migration items: re-enable after the existing findings are fixed.
    "eslint/sort-keys": "off",
  },
  settings: jsPluginSettings,
});
