import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/builder/provision/stream", () => {
  it("rejects requests without a durable journal id", async () => {
    const response = await GET(
      new Request("https://builder.example.test/api/builder/provision/stream"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "request_invalid" });
  });
});
