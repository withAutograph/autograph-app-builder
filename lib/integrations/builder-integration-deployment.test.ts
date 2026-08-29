import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("builder integration deployment", () => {
  it("requires complete authenticated identity and workspace input", async () => {
    const source = await readFile(
      "lib/integrations/builder-integration-deployment.ts",
      "utf8",
    );
    expect(source).toContain("authenticated: true");
    expect(source).toContain("organizationId: string");
    expect(source).toContain("workspaceId: string");
    expect(source).not.toContain("workspace-unavailable");
    expect(source).not.toContain("activeWorkspaceForUser");
  });
});
