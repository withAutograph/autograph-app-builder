import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import jsPlugins, { jsPluginSettings } from "ultracite/oxlint/js-plugins";
import next from "ultracite/oxlint/next";
import nextJsPlugins from "ultracite/oxlint/next/js-plugins";

const previewActivationCli = "lib/db/preview-activation-cli.mts";

const githubProviderPath = "lib/provisioning/github-provider.ts";
const productionCreatorTestPath = "lib/provisioning/repository-production-creator.test.ts";

const handoffControlsPath = "app/ui/handoff-controls.tsx";

const handoffProgressPath = "app/ui/handoff-provisioning-progress.tsx";
const builderControllerPath = "app/ui/use-builder-controller.ts";
const draftAutosavePath = "app/ui/use-builder-draft-autosave.ts";
const productionSetupTestPath = "lib/provisioning/repository-production-setup.test.ts";
const eveEvalPreloadPath = "scripts/eve-eval-fetch-preload.mjs";

const referenceLifecyclePath = "evals/support/self-reproduction-reference-lifecycle.ts";
const nodeFreshBootstrapPath = "lib/repository/node-fresh-bootstrap.ts";
const nodeLocalPublicationPath = "lib/repository/node-local-publication.ts";
const postgresExecutionLeasePath = "lib/sandbox/postgres-execution-lease-store.ts";

const additionalAuthFieldPath = "components/auth/additional-field.tsx";

export default defineConfig({
  extends: [core, next, jsPlugins, nextJsPlugins, antiSlop],
  ignorePatterns: core.ignorePatterns,
  jsPlugins: jsPlugins.jsPlugins,
  options: {
    typeAware: true,
  },
  overrides: [
    {
      // Preserve existing falsy-value fallback behavior.
      files: [
        "app/ui/use-builder-draft-autosave.ts",
        additionalAuthFieldPath,
        "components/auth/error-toaster.tsx",
        "components/auth/oauth-provider/oauth-consent.tsx",
        "components/auth/passkey/delete-passkey-dialog.tsx",
        "components/auth/passkey/passkey.tsx",
        "components/auth/settings/account/change-avatar.tsx",
        "components/auth/user/user-avatar.tsx",
        "components/auth/user/user-view.tsx",
        "lib/integrations/store-in-view-model.ts",
        "lib/mcp/session-app/view.tsx",
        "scripts/design-quality/browser.ts",
      ],
      rules: { "typescript/prefer-nullish-coalescing": "off" },
    },
    {
      // Preserve existing sequential operation ordering.
      files: [
        "components/auth/settings/account/user-profile.tsx",
        "components/auth/sign-up.tsx",
        "evals/support/self-reproduction-runtime-comparison.ts",
        "evals/support/self-reproduction-supplementary.ts",
        "lib/agent/deployment-repository-access-runtime.ts",
        "lib/development/application-root.ts",
        "lib/development/runtime-watch.ts",
        "lib/integrations/repository-access.ts",
        "lib/plugin/agent-plugin-package.ts",
        "lib/provisioning/hosted-operator-ready-replacement-native.ts",
        "lib/release/promotion.ts",
        "lib/repository/github-publication.ts",
        "lib/repository/node-branch-worktree-publication.ts",
        nodeFreshBootstrapPath,
        nodeLocalPublicationPath,
        "lib/repository/sandbox-filesystem.ts",
        "lib/repository/supported-template.ts",
        "lib/repository/target-apply.ts",
        "lib/repository/target-planning.ts",
        postgresExecutionLeasePath,
      ],
      rules: { "react-doctor/async-await-in-loop": "off" },
    },
    {
      // Preserve existing sequential operation ordering.
      files: [
        "evals/self-reproduction/default-capture-adapter.ts",
        "evals/support/self-reproduction-candidate-workflows.ts",
        referenceLifecyclePath,
        "evals/support/self-reproduction-reference-runtime.ts",
        "lib/agent/github-pr-delivery-step.ts",
        "lib/agent/github-publication-runtime.ts",
        "lib/db/better-auth-membership-readiness-cli.mts",
        "lib/db/hosted-storage-readiness-cli.mts",
        "lib/db/postgres-hosted-admin.ts",
        "lib/db/preview-activation-cli.mts",
        "lib/db/preview-activation-invited-user.ts",
        "lib/development/local-mode.ts",
        "lib/image/ghcr-bound-helper.ts",
        "lib/plugin/agent-plugin-package.ts",
        "lib/repository/github-app-http-provider.ts",
        "lib/repository/node-branch-worktree-publication.ts",
        nodeFreshBootstrapPath,
        nodeLocalPublicationPath,
        "lib/repository/supported-template.ts",
        postgresExecutionLeasePath,
      ],
      rules: { "react-doctor/server-sequential-independent-await": "off" },
    },
    {
      // Preserve documented test and tool invocation paths.
      files: [
        ".storybook/visual/app-builder.visual.spec.ts",
        "playwright.design-quality.config.ts",
        "playwright.product-quality.config.ts",
        "playwright.production-navigation.config.ts",
        "playwright.storybook.config.ts",
        "vitest.shims.d.ts",
        "evals/g2-model.vitest.config.mts",
        "evals/g2-provider-brief-first-attempt.model.test.ts",
        "evals/product-quality/product-quality.visual.playwright.ts",
      ],
      rules: { "github/filenames-match-regex": "off" },
    },
    {
      // Preserve existing callback return contracts pending review.
      files: [
        ".storybook/create-app/layouts.tsx",
        "app/ui/builder-connections.tsx",
        "app/ui/builder-destination.tsx",
        "app/ui/builder-form.tsx",
        "app/ui/builder-model-controls.tsx",
        "app/ui/builder-provider-controls.tsx",
        "app/ui/handoff-controls.tsx",
        handoffProgressPath,
        "app/ui/route-error.test.tsx",
        builderControllerPath,
        draftAutosavePath,
        "components/auth/passkey/add-passkey-dialog.tsx",
        "components/auth/passkey/delete-passkey-dialog.tsx",
        "components/auth/passkey/passkey.tsx",
        "components/auth/passkey/rename-passkey-dialog.tsx",
        "components/auth/provider-button.tsx",
        "components/auth/settings/security/fresh-session-prompt.tsx",
        "components/auth/sign-out.tsx",
        "components/create-app/provider-choice-section.tsx",
        "lib/eve/service.ts",
        "lib/mcp/session-app/approval-request.tsx",
        "lib/mcp/session-app/view.tsx",
        productionSetupTestPath,
        eveEvalPreloadPath,
      ],
      rules: { "typescript/no-confusing-void-expression": "off" },
    },
    {
      // Preserve ordering in existing sequential operations.
      files: [
        "e2e/support/harness.ts",
        "lib/agent/github-pr-delivery-lineage.test.ts",
        "lib/provisioning/hosted-operator-ready-replacement-native.ts",
        productionCreatorTestPath,
      ],
      rules: { "eslint/no-await-in-loop": "off" },
    },
    {
      files: [builderControllerPath],
      rules: { "react-doctor/no-pass-data-to-parent": "off" },
    },
    {
      files: [handoffControlsPath, "components/auth/sign-up.tsx"],
      rules: { "react-doctor/no-giant-component": "off" },
    },
    {
      files: [handoffControlsPath, handoffProgressPath],
      rules: { "react-doctor/effect-needs-cleanup": "off" },
    },
    {
      files: [
        "app/(product)/auth/setting-up/page.tsx",
        "app/ui/builder-continuation.tsx",
        handoffControlsPath,
      ],
      rules: { "react-doctor/nextjs-no-client-side-redirect": "off" },
    },
    {
      files: ["app/ui/builder-connections.tsx", "app/ui/search-combobox.tsx"],
      rules: { "react-doctor/prefer-html-dialog": "off" },
    },
    {
      files: [nodeLocalPublicationPath],
      rules: { "react-doctor/js-index-maps": "off" },
    },
    {
      files: [
        referenceLifecyclePath,
        "evals/support/self-reproduction-reference-runtime.ts",
        "lib/agent/github-pr-delivery-step.ts",
        nodeFreshBootstrapPath,
      ],
      rules: { "react-doctor/async-parallel": "off" },
    },
    {
      files: [handoffControlsPath],
      rules: { "react-doctor/no-chain-state-updates": "off" },
    },
    {
      // Git object identity requires the existing SHA-1 format.
      files: [
        "lib/provisioning/github-provider.test.ts",
        githubProviderPath,
        "lib/repository/dependency-cache.test.ts",
        "lib/repository/fresh-bootstrap.ts",
        "lib/repository/github-publication.test.ts",
        nodeFreshBootstrapPath,
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
      files: [additionalAuthFieldPath],
      rules: { "react-doctor/js-hoist-intl": "off" },
    },
    {
      files: [handoffControlsPath],
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
      files: [draftAutosavePath],
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
        additionalAuthFieldPath,
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
        productionSetupTestPath,
        "lib/repository/canonical-acquisition-alignment.test.ts",
        "lib/repository/local-planning-source.test.ts",
        "lib/repository/local-preview-auth-origin.test.ts",
        "lib/sandbox/managed-runtime.test.ts",
        "oxlint.config.ts",
        eveEvalPreloadPath,
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
        draftAutosavePath,
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
        handoffControlsPath,
        handoffProgressPath,
        builderControllerPath,
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
        productionSetupTestPath,
        eveEvalPreloadPath,
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
        postgresExecutionLeasePath,
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
        referenceLifecyclePath,
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
    "github/no-then": "off",
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
    "typescript/no-unsafe-argument": "off",
    "typescript/no-unsafe-assignment": "off",
    "typescript/no-unsafe-member-access": "off",
    "typescript/no-unsafe-type-assertion": "off",
    "typescript/strict-boolean-expressions": "off",
    "typescript/strict-void-return": "off",
    "eslint/complexity": "off",
    // Temporary migration items: re-enable after the existing findings are fixed.
    "eslint/sort-keys": "off",
  },
  settings: jsPluginSettings,
});
