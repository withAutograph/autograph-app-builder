import { describe, expect, it } from "vitest";

import { isDevelopmentRuntimePath } from "./runtime-watch";

describe("development runtime restart paths", () => {
  it.each([
    "agent/agent.ts",
    "agent/tools/plan_app_creation.ts",
    "skills/autograph-app-builder/SKILL.md",
    "schemas/app-spec.ts",
    "app/mcp/route.ts",
    "lib/eve/service.ts",
    "lib/mcp/request-handler.ts",
    "lib/sandbox/backend.ts",
    ".codex-plugin/plugin.json",
    "package.json",
    "pnpm-lock.yaml",
  ])("restarts Eve and the development package for %s", (path) => {
    expect(isDevelopmentRuntimePath(path)).toBe(true);
  });

  it.each([
    "app/page.tsx",
    "app/globals.css",
    "components/landing-page.tsx",
    "public/autograph.svg",
    "docs/plans/local-first.md",
    ".artifacts/development/state.json",
  ])("leaves Next HMR alone for %s", (path) => {
    expect(isDevelopmentRuntimePath(path)).toBe(false);
  });
});
