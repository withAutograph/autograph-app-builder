import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const guidancePath = resolve(repositoryRoot, "agent/skills/create-app/references/react-19-3.md");
const homePagePath = resolve(repositoryRoot, "app/(product)/page.tsx");
const handoffPagePath = resolve(repositoryRoot, "app/(product)/handoff/[id]/page.tsx");

describe("React 19.3 generated-app guidance", () => {
  const guidance = readFileSync(guidancePath, "utf-8");

  it("keeps View Transitions opt-in and accessible", () => {
    expect(guidance).toContain("Do not apply them globally");
    expect(guidance).toContain("prefers-reduced-motion: reduce");
    expect(guidance).toContain("Do not introduce global route animation");
    expect(guidance).toContain('default="none" update="auto"');
    expect(guidance).toContain("Prefer a Server Component boundary");
  });

  it("keeps Builder route transitions server-rendered and loading fallbacks immediate", () => {
    for (const pagePath of [homePagePath, handoffPagePath]) {
      const page = readFileSync(pagePath, "utf-8");

      expect(page).not.toContain('"use client"');
      expect(page).toMatch(/import \{[^}]*\bViewTransition\b[^}]*\} from "react"/u);
      expect(page).toMatch(
        /<(Suspense|RouteProviders)\b[\s\S]*?<ViewTransition update="none">[\s\S]*?<\/ViewTransition>[\s\S]*?<\/\1>/u,
      );
    }
  });

  it("documents targeted server boundaries and Trusted Types hardening", () => {
    expect(guidance).toContain("use(browser())");
    expect(guidance).toContain("Fragment ref");
    expect(guidance).toContain("client-exported Context");
    expect(guidance).toContain("Do not enable `require-trusted-types-for 'script'` by default");
    expect(guidance).toContain("not introduce `dangerouslySetInnerHTML`");
  });
});
