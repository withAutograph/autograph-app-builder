import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("MCP route surface", () => {
  it("exports POST only and leaves OAuth discovery to well-known routes", async () => {
    const route = await readFile("app/mcp/route.ts", "utf8");
    expect(route).toContain("export { requestHandler as POST };");
    expect(route).not.toMatch(/requestHandler as GET/u);
  });
});
