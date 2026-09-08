// For more info, see https://github.com/storybookjs/eslint-plugin-storybook#configuration-flat-config-format
import storybook from "eslint-plugin-storybook";

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".artifacts/**",
    ".eve/**",
    ".output/**",
    "lib/sandbox/hosted-artifact.generated.ts",
    "out/**",
    "build/**",
    "storybook-static/**",
    "next-env.d.ts",
  ]),
  {
    files: [
      "app/**/*.{js,jsx,ts,tsx}",
      "components/**/*.{js,jsx,ts,tsx}",
      "lib/**/*.{js,jsx,ts,tsx}",
    ],
    ignores: ["**/*.stories.{js,jsx,ts,tsx}", "**/*.test.{js,jsx,ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/.storybook/**", "**/.storybook/**"],
              message:
                "Production modules must not depend on Storybook infrastructure.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["lib/**/*.{js,jsx,ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/app/**", "@/components/**", "@/agent/**"],
              message:
                "Library modules are UI- and runtime-agnostic; compose them from app, components, or agent entry points instead.",
            },
          ],
        },
      ],
    },
  },
  ...storybook.configs["flat/recommended"],
]);

export default eslintConfig;
