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
        "lib/agent/local-source-transport-history.test.ts",
        "lib/agent/product-behavior-validation.test.ts",
        "lib/eve/hosted-service.test.ts",
        "lib/eve/native-live-quiescence.test.ts",
        "lib/provisioning/hosted-operator-execution-observation.test.ts",
        "lib/provisioning/hosted-operator-ready-delivery-replacement.test.ts",
        "lib/provisioning/native-target-onboarding-service.test.ts",
        "lib/repository/planning-overlay.test.ts",
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
