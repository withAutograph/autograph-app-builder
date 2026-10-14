import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/eve/vercel-workload-identity", () => ({
  createVercelWorkloadIdentity: () => ({}),
}));
vi.mock("@/lib/mcp/hosted-route", () => ({
  createDeploymentMcpRequestHandler: () => () => new Response(null, { status: 204 }),
}));

describe("MCP route surface", () => {
  it("exports a callable POST handler without a GET handler", async () => {
    const route = await import("../../app/mcp/route");
    expect(route.POST).toBeTypeOf("function");
    expect("GET" in route).toBe(false);
    const response = await route.POST(
      new Request("https://builder.example/mcp", { method: "POST" }),
    );
    expect(response.status).toBe(204);
  });
});
