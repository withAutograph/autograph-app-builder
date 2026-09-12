import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

const deferredRules = Object.fromEntries(
  ["eslint/max-classes-per-file"].map((rule) => [rule, "off"]),
);

export default defineConfig({
  extends: [core],
  ignorePatterns: core.ignorePatterns,
  rules: {
    ...deferredRules,
    "import/consistent-type-specifier-style": "off",

    "typescript/array-type": "off",
    "typescript/consistent-type-definitions": "off",
    "typescript/consistent-type-imports": "off",
    "eslint/curly": "off",
    "eslint/no-await-in-loop": "off",
    "eslint/no-bitwise": "off",
    "eslint/no-shadow": "off",
    "eslint/no-nested-ternary": "off",
    "eslint/no-use-before-define": "off",
    "eslint/func-style": "off",
    "eslint/complexity": "off",
    "eslint/prefer-named-capture-group": "off",
    "eslint/require-await": "off",
    "eslint/require-unicode-regexp": "off",
    "eslint/sort-keys": "off",
    "jsdoc/check-tag-names": "off",
    "promise/prefer-await-to-then": "off",
    "promise/avoid-new": "off",
    "promise/prefer-await-to-callbacks": "off",
    "typescript/no-non-null-assertion": "off",
    "unicorn/consistent-function-scoping": "off",
    "unicorn/filename-case": "off",
    "unicorn/import-style": "off",
    "unicorn/no-array-sort": "off",
    "unicorn/no-await-expression-member": "off",
    "unicorn/no-useless-undefined": "off",
    "unicorn/numeric-separators-style": "off",
    "unicorn/prefer-event-target": "off",
    "unicorn/require-post-message-target-origin": "off",
    "unicorn/text-encoding-identifier-case": "off",
  },
});
