import type { DummyRule } from "oxlint";
import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import jsPlugins, { jsPluginSettings } from "ultracite/oxlint/js-plugins";
import next from "ultracite/oxlint/next";
import nextJsPlugins from "ultracite/oxlint/next/js-plugins";

// React Doctor remains visible as advisory analysis, including each preset rule's options.
const reactDoctorAdvisories = Object.fromEntries(
  Object.entries({
    ...core.rules,
    ...next.rules,
    ...jsPlugins.rules,
    ...nextJsPlugins.rules,
    ...antiSlop.rules,
  })
    .filter(([name]) => name.startsWith("react-doctor/"))
    .map(([name, rule]): [string, DummyRule] => [
      name,
      Array.isArray(rule) ? ["warn", ...rule.slice(1)] : "warn",
    ]),
);

export default defineConfig({
  extends: [core, next, jsPlugins, nextJsPlugins, antiSlop],
  ignorePatterns: core.ignorePatterns,
  jsPlugins: jsPlugins.jsPlugins,
  options: {
    typeAware: true,
  },
  rules: {
    ...reactDoctorAdvisories,
    // Temporary migration baseline; remove these as findings are fixed.
    "typescript/promise-function-async": "off",
    "anti-slop/require-safety-comment-for-type-assertion": "off",
    "sonarjs/cognitive-complexity": "off",
    "typescript/no-unsafe-type-assertion": "off",
    "eslint/complexity": "off",
    // Temporary migration items: re-enable after the existing findings are fixed.
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
