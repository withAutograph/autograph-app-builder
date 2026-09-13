import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core],
  ignorePatterns: core.ignorePatterns,
  overrides: [
    {
      files: ["agent/tools/**/*.ts"],
      rules: {
        "unicorn/filename-case": "off",
      },
    },
    {
      files: [
        ".config/mise/scripts/repository/generate-hosted-runtime-assets.mts",
        "agent/tools/**/*.ts",
        "evals/self-reproduction.eval.ts",
        "evals/self-reproduction/**/*.ts",
        "evals/support/self-reproduction*.ts",
        "lib/agent/apply-implementation-files.test.ts",
        "lib/repository/target-validation.ts",
        "scripts/eval-self-reproduction.mts",
      ],
      rules: {
        "eslint/func-style": "off",
        "eslint/no-nested-ternary": "off",
        "eslint/no-useless-return": "off",
        "eslint/sort-keys": "off",
        "promise/avoid-new": "off",
        "typescript/no-non-null-assertion": "off",
        "unicorn/import-style": "off",
        "unicorn/no-await-expression-member": "off",
      },
    },
  ],
  rules: {
    "eslint/complexity": "off",
    "eslint/curly": "off",
  },
});
