import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core],
  ignorePatterns: core.ignorePatterns,
  rules: {
    "unicorn/import-style": "off",
    "eslint/curly": "off",
    "eslint/no-shadow": "off",
    "eslint/no-nested-ternary": "off",
    "eslint/func-style": "off",
    "eslint/require-await": "off",
    "eslint/complexity": "off",
    "eslint/sort-keys": "off",
    "promise/avoid-new": "off",
    "typescript/no-non-null-assertion": "off",
    "unicorn/filename-case": "off",
    "unicorn/no-await-expression-member": "off",
    "unicorn/no-useless-undefined": "off",
  },
});
