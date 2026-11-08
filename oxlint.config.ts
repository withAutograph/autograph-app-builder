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
    // Temporary migration baseline; remove these as findings are fixed.
    "typescript/promise-function-async": "off",
    "anti-slop/no-runtime-typeof": "off",
    "anti-slop/no-unknown-parameters": "off",
    "anti-slop/require-safety-comment-for-type-assertion": "off",
    "sonarjs/cognitive-complexity": "off",
    "sonarjs/no-undefined-assignment": "off",
    "typescript/no-unsafe-type-assertion": "off",
    "typescript/strict-boolean-expressions": "off",
    "eslint/complexity": "off",
    // Temporary migration items: re-enable after the existing findings are fixed.
    "eslint/sort-keys": "off",
  },
  settings: jsPluginSettings,
});
