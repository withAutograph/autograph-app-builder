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
  rules: {
    "sonarjs/cognitive-complexity": "off",
    "eslint/complexity": "off",
    "eslint/sort-keys": "off",
  },
  overrides: [
    {
      // Eve persists tool identifiers from these existing kebab-case and snake_case filenames.
      files: ["agent/tools/*.ts"],
      rules: {
        "unicorn/filename-case": ["error", { cases: { kebabCase: true, snakeCase: true } }],
      },
    },
  ],
  settings: jsPluginSettings,
});
