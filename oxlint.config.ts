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

const referenceLifecyclePath = "evals/support/self-reproduction-reference-lifecycle.ts";
const nodeFreshBootstrapPath = "lib/repository/node-fresh-bootstrap.ts";
const nodeLocalPublicationPath = "lib/repository/node-local-publication.ts";
const postgresExecutionLeasePath = "lib/sandbox/postgres-execution-lease-store.ts";

const additionalAuthFieldPath = "components/auth/additional-field.tsx";

const sharedLintFile1 = "evals/support/self-reproduction-reference-runtime.ts";
const sharedLintFile2 = "lib/repository/supported-template.ts";
const sharedLintFile3 = "scripts/self-reproduction-live.mts";
const sharedLintFile4 = "scripts/test-capability-preload.mjs";

const sharedLintFile5 = "app/ui/builder-connections.tsx";
const sharedLintFile6 = "components/auth/error-toaster.tsx";
const sharedLintFile7 = "evals/support/self-reproduction-candidate-workflows.ts";
const sharedLintFile8 = "lib/eve/service.ts";
const sharedLintFile9 = "lib/provisioning/github-provider.test.ts";
const sharedLintFile10 = "lib/repository/fresh-bootstrap.ts";
const sharedLintFile11 = "lib/repository/github-publication.ts";
const sharedLintFile12 = "scripts/design-quality/browser.ts";
const sharedLintFile13 = "scripts/eval-self-reproduction.mts";

const sharedLintFile14 = "components/auth/sign-up.tsx";
const sharedLintFile15 = "lib/agent/product-behavior.test.ts";
const sharedLintFile16 = "lib/development/local-mode.ts";
const sharedLintFile17 = "lib/development/runtime-watch.ts";
const sharedLintFile18 = "lib/image/ghcr-bound-helper.ts";
const sharedLintFile19 = "lib/image/lifecycle.test.ts";
const sharedLintFile20 = "lib/repository/dependency-cache.test.ts";
const sharedLintFile21 = "lib/repository/node-branch-worktree-publication.ts";

const sharedLintFile22 = "components/auth/oauth-provider/oauth-consent.tsx";
const sharedLintFile23 = "e2e/auth/client-oauth-handoff.spec.ts";
const sharedLintFile24 = "lib/agent/deployment-repository-access-runtime.test.ts";
const sharedLintFile25 = "lib/auth/preview-oauth-deployment.ts";
const sharedLintFile26 = "lib/eve/hosted-service.ts";
const sharedLintFile27 = "lib/eve/public-events.ts";
const sharedLintFile28 = "lib/eve/same-origin-http.ts";
const sharedLintFile29 = "lib/image/node-lifecycle.ts";
const sharedLintFile30 = "scripts/design-quality/archive.mts";
const sharedLintFile31 = "scripts/design-quality/source.ts";
const sharedLintFile32 = "scripts/trusted-node-launcher.test.ts";

export default defineConfig({
  extends: [core, next, jsPlugins, nextJsPlugins, antiSlop],
  ignorePatterns: core.ignorePatterns,
  jsPlugins: jsPlugins.jsPlugins,
  options: {
    typeAware: true,
  },
  overrides: [
    {
      // Exercise rejection of insecure non-loopback endpoints.
      files: ["scripts/eve-worker-environment.test.ts"],
      rules: { "sonarjs/no-clear-text-protocols": "off" },
    },
    {
      // Preserve existing control flow pending focused review.
      files: [
        ".config/mise/scripts/repository/build-hosted-arrusted-artifact.mts",
        "lib/agent/proposed-source-inspection.ts",
        "lib/development/local-mode.ts",
        sharedLintFile26,
        "lib/eve/native-recovery-repeatable-apply.ts",
        "lib/eve/private-apply-denial-evidence.ts",
        "lib/eve/private-continuity-approval.ts",
        "lib/eve/private-repository-production-approval.ts",
        sharedLintFile27,
        sharedLintFile29,
        "lib/integrations/repository-access.ts",
        "lib/provisioning/github-provider.ts",
        "lib/provisioning/hosted-operator-export-customer.ts",
        "lib/provisioning/hosted-operator-membership-inspection.ts",
        "lib/provisioning/hosted-operator-native-preview-recovery.ts",
        "lib/provisioning/hosted-operator-pending-account-restoration.ts",
        "lib/provisioning/hosted-operator-ready-delivery-replacement.ts",
        "lib/provisioning/hosted-operator-retention-renewal.ts",
        "lib/provisioning/public-release-handler.ts",
        "lib/provisioning/repository-production-setup.ts",
        "lib/repository/local-planning-source-capture.ts",
        "lib/repository/local-source-baseline-store.ts",
        sharedLintFile21,
        nodeFreshBootstrapPath,
        "lib/repository/node-local-publication.ts",
        "lib/repository/target-validation.ts",
        "lib/sandbox/vercel-backend.ts",
        "lib/testing/eve-eval-lifecycle.ts",
        "scripts/design-quality/css-source-map.ts",
        sharedLintFile31,
      ],
      rules: { "sonarjs/too-many-break-or-continue-in-loop": "off" },
    },
    {
      // Preserve existing control flow pending focused review.
      files: [
        "agent/tools/artifact_workflow_status.ts",
        "agent/tools/target_execution_status.ts",
        "app/(product)/local-connections/*/complete/route.ts",
        "app/(product)/local-oauth/*/approve/completion.ts",
        "app/ui/handoff-controls.tsx",
        "app/ui/use-builder-controller.ts",
        sharedLintFile22,
        "components/auth/sign-in.tsx",
        "components/auth/sign-up.tsx",
        "components/auth/user/user-button.tsx",
        "evals/design-guidance.eval.ts",
        sharedLintFile7,
        "lib/agent/approval-receipt.ts",
        "lib/agent/prepare-app-creation.ts",
        "lib/agent/prototype-artifacts.ts",
        "lib/agent/target-execution.ts",
        "lib/auth/github-app-installation.ts",
        sharedLintFile25,
        "lib/auth/preview-oauth-runtime.ts",
        "lib/db/preview-activation.ts",
        sharedLintFile26,
        "lib/eve/postgres-hosted-store.ts",
        sharedLintFile27,
        sharedLintFile28,
        "lib/image/lifecycle.ts",
        "lib/mcp/request-handler.ts",
        "lib/provisioning/hosted-operator-contract.ts",
        "lib/provisioning/repository-production-creator.ts",
        "lib/provisioning/repository-production-workers.ts",
        "lib/provisioning/vercel-provider.ts",
        "lib/repository/dependency-cache.ts",
        sharedLintFile10,
        sharedLintFile11,
        sharedLintFile21,
        nodeFreshBootstrapPath,
      ],
      rules: { "sonarjs/expression-complexity": "off" },
    },
    {
      // Existing type contracts awaiting focused review.
      files: [
        "agent/hooks/release-sandbox-compute.ts",
        "agent/tools/artifact_workflow_status.ts",
        "agent/tools/workspace_status.ts",
        "app/(docs)/docs/docs-registry.ts",
        "app/ui/handoff-provisioning-progress.test.tsx",
        "components/auth/user/user-button.tsx",
        "evals/support/product-quality.ts",
        "evals/support/self-reproduction-preview-observation.ts",
        "evals/support/self-reproduction-public.ts",
        "lib/agent/component-composition-policy.ts",
        sharedLintFile15,
        "lib/agent/target-dependency-preparation.ts",
        "lib/agent/target-execution.ts",
        "lib/agent/workflow-state.ts",
        "lib/auth/auth-plugin.ts",
        "lib/auth/github-app-installation.ts",
        "lib/db/postgres-hosted-admin.ts",
        "lib/eve/hosted-auth.ts",
        sharedLintFile8,
        sharedLintFile19,
        "lib/mcp/request-handler.ts",
        "lib/repository/branch-worktree-publication.ts",
        sharedLintFile20,
        sharedLintFile10,
        "lib/repository/local-publication.ts",
        sharedLintFile21,
        nodeLocalPublicationPath,
        "lib/repository/target-apply.ts",
        sharedLintFile31,
        "scripts/hosted-portable-proof.test.ts",
        "scripts/self-reproduction-public-driver.test.ts",
      ],
      rules: { "sonarjs/max-union-size": "off" },
    },
    {
      // Existing type contracts awaiting focused review.
      files: [
        "app/ui/builder-connections.tsx",
        "app/ui/connections-section.stories.tsx",
        additionalAuthFieldPath,
        "components/auth/auth-continuity.tsx",
        "components/auth/settings/account/change-avatar.tsx",
        "components/auth/sign-in.tsx",
        sharedLintFile14,
        "components/create-app/choice-card.stories.tsx",
        "evals/product-quality/product-quality.visual.playwright.ts",
        "evals/support/self-reproduction-reference-navigation.ts",
        "evals/support/self-reproduction-reference-runtime.ts",
        "evals/support/self-reproduction-template-source.ts",
        sharedLintFile15,
        "lib/development/dev-package.ts",
        sharedLintFile16,
        "lib/development/process-supervisor.ts",
        sharedLintFile17,
        "lib/eve/local-eve-launch.ts",
        sharedLintFile8,
        sharedLintFile18,
        sharedLintFile29,
        "lib/mcp/session-app/index.tsx",
        "lib/plugin/installing-docs.test.ts",
        "lib/provisioning/starter-source.ts",
        sharedLintFile20,
        nodeFreshBootstrapPath,
        "lib/sandbox/working-preview-ownership.test.ts",
        "scripts/design-quality/browser-node.test.ts",
        sharedLintFile12,
        "scripts/release-prove.mts",
        "scripts/release-publish.mts",
        "scripts/run-with-test-capability.mts",
        "scripts/self-reproduction-live.mts",
        "scripts/test-production-navigation.mts",
      ],
      rules: { "typescript/strict-void-return": "off" },
    },
    {
      // Existing findings awaiting a focused migration.
      files: [
        "evals/self-reproduction/workflow-adapter.test.ts",
        "evals/support/self-reproduction-navigation-command.test.ts",
        "evals/support/self-reproduction-reference-capture-fixture.test.ts",
        "evals/support/self-reproduction-reference-runtime.test.ts",
        "evals/support/self-reproduction-template-source.test.ts",
        "lib/development/local-mode.test.ts",
        "lib/eve/local-eve-launch.test.ts",
        "lib/eve/local-vercel-oidc.test.ts",
        sharedLintFile19,
        "lib/release/promotion.test.ts",
        "lib/repository/supported-template-development.test.ts",
        "scripts/design-quality/archive-path.test.ts",
        "scripts/design-quality/browser-fixture.test.ts",
        "scripts/development.mts",
        "scripts/eval-self-reproduction.test.ts",
        "scripts/production-navigation-task.test.ts",
        "scripts/self-reproduction-public-entrypoint.test.ts",
        "scripts/test-production-navigation.mts",
        sharedLintFile32,
      ],
      rules: { "sonarjs/publicly-writable-directories": "off" },
    },
    {
      // Existing findings awaiting a focused migration.
      files: [
        "app/ui/app-access.tsx",
        "app/ui/handoff-controls.test.tsx",
        "components/auth/settings/account/user-profile.tsx",
        sharedLintFile24,
        "lib/agent/prepared-provider-context.test.ts",
        sharedLintFile15,
        "lib/auth/github-app-installation.test.ts",
        sharedLintFile25,
        "lib/auth/preview-oauth-runtime.test.ts",
        "lib/development/mcp-readiness.test.ts",
        "lib/eve/same-origin-http.test.ts",
        "lib/integrations/provider-connection-return.ts",
        "lib/integrations/vercel-installation.test.ts",
        "lib/mcp/handoff-oauth.test.ts",
        "lib/mcp/handoff-provider-test-harness.ts",
        sharedLintFile9,
        "lib/provisioning/starter-source.test.ts",
        "lib/provisioning/vercel-provider.test.ts",
        "lib/repository/arrusted-template-reader.test.ts",
        "lib/repository/github-app-http-provider.test.ts",
        "lib/repository/github-app-http-provider.ts",
        "lib/sandbox/working-preview-runtime.test.ts",
        "mdx-components.tsx",
        sharedLintFile13,
        "scripts/hosted-portable-proof.test.ts",
        "scripts/self-reproduction-public-driver.test.ts",
      ],
      rules: { "typescript/no-base-to-string": "off" },
    },
    {
      // Existing findings awaiting a focused migration.
      files: [
        ".config/mise/scripts/repository/image-lifecycle.ts",
        "agent/tools/inspect_existing_app.ts",
        sharedLintFile5,
        "evals/support/self-reproduction-candidate-capabilities.ts",
        sharedLintFile7,
        "evals/support/self-reproduction-reference-navigation.ts",
        "lib/agent/prepare-workspace-source.test.ts",
        "lib/agent/prototype-artifacts.ts",
        "lib/auth/preview-cimd-transport.test.ts",
        "lib/development/dev-package.ts",
        sharedLintFile16,
        "lib/development/process-supervisor.ts",
        sharedLintFile17,
        sharedLintFile26,
        "lib/eve/local-eve-launch.test.ts",
        sharedLintFile8,
        "lib/hosted/session-authority.ts",
        "lib/image/lifecycle.ts",
        sharedLintFile29,
        sharedLintFile10,
        sharedLintFile11,
        "lib/testing/eve-eval-lifecycle.ts",
        sharedLintFile12,
        sharedLintFile13,
        "scripts/test-capability-protocol.mts",
      ],
      rules: { "anti-slop/no-known-value-widening": "off" },
    },
    {
      // Existing findings awaiting a focused migration.
      files: [
        "app/**/route.ts",
        "app/(product)/auth/sign-up/page.tsx",
        "app/(product)/github/installations/callback/route.ts",
        "app/(product)/local-connections/[provider]/complete/route.ts",
        "app/(product)/local-connections/vercel/oauth-callback/route.ts",
        "app/(product)/local-oauth/[provider]/approve/[approval]/route.ts",
        "app/(product)/local-oauth/[provider]/approve/route.ts",
        "app/(product)/preview/[sessionId]/[digest]/route.ts",
        "app/(product)/settings/account/page.tsx",
        "app/.well-known/oauth-protected-resource/route.ts",
        "app/api/builder/draft/route.ts",
        "app/api/builder/handoffs/[id]/renew/route.ts",
        "app/api/builder/handoffs/[id]/route.ts",
        "app/api/builder/handoffs/route.ts",
        "app/api/builder/provision/stream/route.ts",
        "app/api/github/webhooks/route.ts",
        "app/healthz/route.ts",
        sharedLintFile5,
        "app/ui/builder-form-content.test.tsx",
        "app/ui/builder-form-islands.tsx",
        "app/ui/emulation-approval.tsx",
        "app/ui/sign-up-request-boundary.test.tsx",
        "app/ui/use-builder-draft-autosave.test.tsx",
        sharedLintFile6,
        "components/create-app/provider-choice-section.tsx",
        "components/ui/badge.tsx",
        "components/ui/item.tsx",
        "e2e/production-navigation/cache-probe.route.ts",
      ],
      rules: { "sonarjs/function-name": "off" },
    },
    {
      // Existing calls awaiting a focused contract review.
      files: [
        handoffControlsPath,
        additionalAuthFieldPath,
        sharedLintFile6,
        "evals/cancel-dependency-preparation.eval.ts",
        "evals/self-reproduction/workflow-adapter.ts",
        "evals/support/self-reproduction-supplementary.ts",
        "lib/auth/real-oauth-test-harness.ts",
        "lib/mcp/handoff-provider-test-harness.ts",
        "lib/release/promotion.ts",
        "lib/repository/reviewed-receipt-contract.test.ts",
        "lib/testing/test-capability-registry.cjs",
        "scripts/build-openai-package.mts",
        "scripts/build-portable-release.mts",
        sharedLintFile30,
        sharedLintFile12,
        "scripts/design-quality/rescore.mts",
        "scripts/eve-eval-fetch-preload.mjs",
        "scripts/smoke-portable-plugin.mts",
        sharedLintFile4,
        "scripts/test-portable-release.mts",
      ],
      rules: { "typescript/no-unsafe-argument": "off" },
    },
    {
      // Existing calls awaiting a focused contract review.
      files: [
        "evals/branch-worktree-publication-negative.eval.ts",
        "evals/branch-worktree-publication-stale.eval.ts",
        "evals/branch-worktree-publication.eval.ts",
        "evals/pre-journal-branch-worktree-publication.eval.ts",
        "evals/support/self-reproduction-reference-runtime.test.ts",
        sharedLintFile1,
        "evals/support/supported-repository.ts",
        sharedLintFile19,
        nodeLocalPublicationPath,
        "lib/repository/supported-template-development.test.ts",
        sharedLintFile2,
        "scripts/eval-design.mts",
        sharedLintFile13,
        sharedLintFile3,
        "scripts/self-reproduction-public.mts",
        sharedLintFile32,
      ],
      rules: { "sonarjs/no-os-command-from-path": "off" },
    },
    {
      // Preserve existing falsy-value fallback behavior.
      files: [
        "app/ui/use-builder-draft-autosave.ts",
        additionalAuthFieldPath,
        sharedLintFile6,
        sharedLintFile22,
        "components/auth/passkey/delete-passkey-dialog.tsx",
        "components/auth/passkey/passkey.tsx",
        "components/auth/settings/account/change-avatar.tsx",
        "components/auth/user/user-avatar.tsx",
        "components/auth/user/user-view.tsx",
        "lib/integrations/store-in-view-model.ts",
        "lib/mcp/session-app/view.tsx",
        sharedLintFile12,
      ],
      rules: { "typescript/prefer-nullish-coalescing": "off" },
    },
    {
      // Preserve existing sequential operation ordering.
      files: [
        "components/auth/settings/account/user-profile.tsx",
        sharedLintFile14,
        "evals/support/self-reproduction-runtime-comparison.ts",
        "evals/support/self-reproduction-supplementary.ts",
        "lib/agent/deployment-repository-access-runtime.ts",
        "lib/development/application-root.ts",
        sharedLintFile17,
        "lib/integrations/repository-access.ts",
        "lib/plugin/agent-plugin-package.ts",
        "lib/provisioning/hosted-operator-ready-replacement-native.ts",
        "lib/release/promotion.ts",
        sharedLintFile11,
        sharedLintFile21,
        nodeFreshBootstrapPath,
        nodeLocalPublicationPath,
        "lib/repository/sandbox-filesystem.ts",
        sharedLintFile2,
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
        sharedLintFile7,
        referenceLifecyclePath,
        sharedLintFile1,
        "lib/agent/github-pr-delivery-step.ts",
        "lib/agent/github-publication-runtime.ts",
        "lib/db/better-auth-membership-readiness-cli.mts",
        "lib/db/hosted-storage-readiness-cli.mts",
        "lib/db/postgres-hosted-admin.ts",
        "lib/db/preview-activation-cli.mts",
        "lib/db/preview-activation-invited-user.ts",
        sharedLintFile16,
        sharedLintFile18,
        "lib/plugin/agent-plugin-package.ts",
        "lib/repository/github-app-http-provider.ts",
        sharedLintFile21,
        nodeFreshBootstrapPath,
        nodeLocalPublicationPath,
        sharedLintFile2,
        postgresExecutionLeasePath,
      ],
      rules: { "react-doctor/server-sequential-independent-await": "off" },
    },
    {
      // Preserve documented test and tool invocation paths.
      files: [
        "evals/g2-model.vitest.config.mts",
        "evals/g2-provider-brief-first-attempt.model.test.ts",
        "evals/product-quality/product-quality.visual.playwright.ts",
      ],
      rules: { "github/filenames-match-regex": "off" },
    },
    {
      // Preserve existing callback return contracts pending review.
      files: [
        sharedLintFile5,
        "app/ui/builder-destination.tsx",
        "app/ui/builder-model-controls.tsx",
        "app/ui/builder-provider-controls.tsx",
        "components/auth/passkey/delete-passkey-dialog.tsx",
        "components/auth/passkey/rename-passkey-dialog.tsx",
        "components/auth/provider-button.tsx",
        "components/auth/settings/security/fresh-session-prompt.tsx",
        "components/create-app/provider-choice-section.tsx",
        "lib/mcp/session-app/approval-request.tsx",
        "lib/mcp/session-app/view.tsx",
        productionSetupTestPath,
      ],
      rules: { "typescript/no-confusing-void-expression": "off" },
    },
    {
      // Preserve ordering in existing sequential operations.
      files: [
        "e2e/support/harness.ts",
        "lib/provisioning/hosted-operator-ready-replacement-native.ts",
        productionCreatorTestPath,
      ],
      rules: { "eslint/no-await-in-loop": "off" },
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
      files: [nodeLocalPublicationPath],
      rules: { "react-doctor/js-index-maps": "off" },
    },
    {
      files: [
        referenceLifecyclePath,
        sharedLintFile1,
        "lib/agent/github-pr-delivery-step.ts",
        nodeFreshBootstrapPath,
      ],
      rules: { "react-doctor/async-parallel": "off" },
    },
    {
      // Git object identity requires the existing SHA-1 format.
      files: [
        sharedLintFile9,
        githubProviderPath,
        sharedLintFile20,
        sharedLintFile10,
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
        sharedLintFile30,
        "scripts/design-quality/rescore.mts",
        "scripts/smoke-portable-plugin.mts",
        sharedLintFile4,
      ],
      rules: { "typescript/no-unsafe-call": "off" },
    },
    {
      files: [draftAutosavePath],
      rules: { "sonarjs/pseudo-random": "off" },
    },
    {
      // Retain existing receiver and callback behavior pending review.
      files: ["lib/auth/preview-auth-ui.test.ts", sharedLintFile18, productionCreatorTestPath],
      rules: { "typescript/unbound-method": "off" },
    },
    {
      // Preserve existing runtime contracts pending focused migration.
      files: ["scripts/design-quality/archive-entry.ts"],
      rules: { "typescript/no-unsafe-return": "off" },
    },
    {
      // Existing findings awaiting behavior-preserving contract changes.
      files: [
        "lib/agent/application-review-context-store.test.ts",
        "lib/agent/fresh-bootstrap-source.test.ts",
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
        "oxlint.config.ts",
        "scripts/eve-recovery-holder-observation.test.mjs",
      ],
      rules: { "unicorn/consistent-function-scoping": "off" },
    },
    {
      // Preserve explicit boolean distinctions in existing boundary checks.
      files: [
        ".storybook/main.ts",
        draftAutosavePath,
        sharedLintFile22,
        "lib/auth/postgres-organization-user-authority.ts",
        previewActivationCli,
        "lib/db/preview-activation-invited-user.ts",
        "lib/provisioning/repository-production-native.ts",
        sharedLintFile10,
        sharedLintFile11,
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
        sharedLintFile24,
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
        sharedLintFile28,
        "lib/eve/service.test.ts",
        "lib/handoff/postgres-store.test.ts",
        "lib/integrations/postgres-vercel-installation.test.ts",
        sharedLintFile9,
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
        sharedLintFile31,
        "scripts/test-capability-preload.test.ts",
      ],
      rules: { "anti-slop/no-chained-type-assertions": "off" },
    },
    {
      files: [sharedLintFile26],
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
        sharedLintFile23,
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
        sharedLintFile23,
        "e2e/builder/builder-draft-store.spec.ts",
        "e2e/builder/builder-handoff.spec.ts",
        referenceLifecyclePath,
        "lib/auth/cursor-client-setup.mts",
        sharedLintFile25,
        previewActivationCli,
        "lib/integrations/preview-emulate-handler.ts",
      ],
      rules: { "sonarjs/no-wildcard-import": "off" },
    },
    {
      // Temporary migration baseline for existing test findings.
      files: ["**/*.{test,spec}.{js,jsx,ts,tsx,mjs,mts,cjs,cts}"],
      rules: {
        "anti-slop/no-module-mocking": "off",
        "sonarjs/code-eval": "off",
        "sonarjs/no-hardcoded-ip": "off",
      },
    },
  ],
  rules: {
    // Temporary migration baseline; remove these as findings are fixed.
    "typescript/promise-function-async": "off",
    "anti-slop/no-conditional-empty-object-spread": "off",
    "anti-slop/no-runtime-typeof": "off",
    "anti-slop/no-unknown-parameters": "off",
    "anti-slop/no-unknown-returns": "off",
    "anti-slop/no-unsafe-dictionary-type": "off",
    "anti-slop/require-safety-comment-for-type-assertion": "off",
    "github/no-then": "off",
    "sonarjs/cognitive-complexity": "off",
    "sonarjs/no-undefined-assignment": "off",
    "typescript/consistent-return": "off",
    "typescript/no-unsafe-assignment": "off",
    "typescript/no-unsafe-member-access": "off",
    "typescript/no-unsafe-type-assertion": "off",
    "typescript/strict-boolean-expressions": "off",
    "eslint/complexity": "off",
    // Temporary migration items: re-enable after the existing findings are fixed.
    "eslint/sort-keys": "off",
  },
  settings: jsPluginSettings,
});
