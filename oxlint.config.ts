import type { DummyRule } from "oxlint";
import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import jsPlugins, { jsPluginSettings } from "ultracite/oxlint/js-plugins";
import next from "ultracite/oxlint/next";
import nextJsPlugins from "ultracite/oxlint/next/js-plugins";

// React Doctor remains visible as advisory analysis, including each preset rule's options.
const reactDoctorAdvisories: Record<string, DummyRule> = {};
for (const [name, rule] of Object.entries({
  ...core.rules,
  ...next.rules,
  ...jsPlugins.rules,
  ...nextJsPlugins.rules,
  ...antiSlop.rules,
})) {
  if (name.startsWith("react-doctor/")) {
    reactDoctorAdvisories[name] = Array.isArray(rule) ? ["warn", ...rule.slice(1)] : "warn";
  }
}

export default defineConfig({
  extends: [core, next, jsPlugins, nextJsPlugins, antiSlop],
  ignorePatterns: core.ignorePatterns,
  jsPlugins: jsPlugins.jsPlugins,
  options: {
    typeAware: true,
  },
  rules: {
    ...reactDoctorAdvisories,
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
