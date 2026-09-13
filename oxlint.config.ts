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
  ],
  rules: {
    "eslint/complexity": "off",
  },
});
