import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import jsPlugins, { jsPluginSettings } from "ultracite/oxlint/js-plugins";
import next from "ultracite/oxlint/next";
import nextJsPlugins from "ultracite/oxlint/next/js-plugins";

const sharedLintFile23 = "e2e/auth/client-oauth-handoff.spec.ts";

export default defineConfig({
  extends: [core, next, jsPlugins, nextJsPlugins, antiSlop],
  ignorePatterns: core.ignorePatterns,
  jsPlugins: jsPlugins.jsPlugins,
  options: {
    typeAware: true,
  },
  overrides: [
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
      // Temporary migration baseline for existing test findings.
      files: ["**/*.{test,spec}.{js,jsx,ts,tsx,mjs,mts,cjs,cts}"],
      rules: {
        "anti-slop/no-module-mocking": "off",
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
