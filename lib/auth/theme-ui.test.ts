import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("web theme integration", () => {
  it("uses the Next.js-safe class theme provider and Better Auth UI plugin", async () => {
    const [layout, providers] = await Promise.all([
      readFile("app/layout.tsx", "utf8"),
      readFile("components/providers.tsx", "utf8"),
    ]);

    expect(layout).toContain("suppressHydrationWarning");
    expect(providers).toContain('attribute="class"');
    expect(providers).toContain('defaultTheme="system"');
    expect(providers).toContain("themePlugin({ useTheme: themeHook })");
    expect(providers).toContain("authPlugins(passkeysEnabled, useTheme)");
  });

  it("themes every web surface while preserving host-controlled MCP theming", async () => {
    const [webStyles, mcpStyles] = await Promise.all([
      readFile("app/ui/app-builder.module.css", "utf8"),
      readFile("lib/mcp/session-app/styles.css", "utf8"),
    ]);

    expect(webStyles).toContain(":global(html.dark) .appShell");
    expect(webStyles).toContain(":global(html.dark) .anonymousPage");
    expect(webStyles).toContain(":global(html.dark) .onboardingPage");
    expect(webStyles).not.toContain('html[data-theme="system"]');
    expect(mcpStyles).toContain('html[data-theme="dark"] .mcpApp');
  });
});
