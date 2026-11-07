import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import jsPlugins, { jsPluginSettings } from "ultracite/oxlint/js-plugins";
import next from "ultracite/oxlint/next";
import nextJsPlugins from "ultracite/oxlint/next/js-plugins";

export default defineConfig({
  extends: [core, next, jsPlugins, nextJsPlugins, antiSlop],
  ignorePatterns: core.ignorePatterns,
  jsPlugins: jsPlugins.jsPlugins,
  options: {
    typeAware: true,
  },
  overrides: [
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
        "lib/agent/application-review-fallback.test.ts",
        "lib/agent/application-review-sandbox-reader.test.ts",
        "lib/agent/continuity-approval-recovery.test.ts",
        "lib/agent/draft-reconciliation-workflow.test.ts",
        "lib/agent/github-pr-delivery-runtime.test.ts",
        "lib/agent/hosted-runtime-execution-wait.test.ts",
        "lib/agent/hosted-runtime-identity-wait.test.ts",
        "lib/agent/local-source-prerequisite-response.test.ts",
        "lib/agent/local-source-transport-history.test.ts",
        "lib/agent/native-target-onboarding-runtime.test.ts",
        "lib/agent/planned-proposal-authoring.test.ts",
        "lib/agent/prepare-workspace-source.test.ts",
        "lib/agent/product-behavior-tool.test.ts",
        "lib/agent/product-behavior-validation.test.ts",
        "lib/auth/postgres-organization-user-authority.test.ts",
        "lib/auth/preview-oauth-deployment.test.ts",
        "lib/eve/historical-approval-replay-orchestration.test.ts",
        "lib/eve/hosted-service.test.ts",
        "lib/eve/native-live-quiescence.test.ts",
        "lib/eve/local-native-recovery.ts",
        "lib/eve/private-export-approval.test.ts",
        "lib/eve/private-native-target-approval.test.ts",
        "lib/eve/service.test.ts",
        "lib/provisioning/builder-session-destination.test.ts",
        "lib/provisioning/hosted-operator-composition.ts",
        "lib/provisioning/hosted-operator-composition.test.ts",
        "lib/provisioning/hosted-operator-execution-observation.test.ts",
        "lib/provisioning/hosted-operator-managed-runtime-projection.ts",
        "lib/provisioning/hosted-operator-ready-delivery-replacement.test.ts",
        "lib/provisioning/hosted-operator-sandbox-fetch.test.ts",
        "lib/provisioning/native-target-onboarding-service.ts",
        "lib/provisioning/native-target-onboarding-service.test.ts",
        "lib/provisioning/native-target-vercel-provider.test.ts",
        "lib/repository/dependency-cache.test.ts",
        "lib/repository/local-planning-source.test.ts",
        "lib/repository/local-preview-auth-origin.test.ts",
        "lib/repository/planning-overlay.test.ts",
        "lib/repository/private-compute-check-policy.test.ts",
        "lib/repository/supported-template-development.test.ts",
        "lib/repository/target-validation.ts",
        "lib/repository/workspace-path-inspection-baseline.test.ts",
        "lib/sandbox/working-preview-runtime.test.ts",
        "scripts/eve-model-protocol-diagnostic.test.mjs",
        "scripts/eve-recovery-holder-closure.test.mjs",
        "scripts/eve-repeatable-recovery.test.mjs",
        "scripts/vitest-browser-diagnostics.test.ts",
      ],
      rules: { "eslint/require-await": "off" },
    },
  ],
  rules: {
    "eslint/complexity": "off",
    "eslint/curly": "off",
  },
  settings: jsPluginSettings,
});
