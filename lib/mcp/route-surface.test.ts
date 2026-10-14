import { describe, expect, it } from "vitest";

describe("MCP route surface", () => {
  it("exports a callable POST handler without a GET handler", async () => {
    const route = await import("../../app/mcp/route");
    expect(route.POST).toBeTypeOf("function");
    expect("GET" in route).toBe(false);
  });
});
