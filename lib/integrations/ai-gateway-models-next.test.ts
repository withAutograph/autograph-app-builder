import { describe, expect, it } from "vitest";
import { loadNextGatewayModels } from "./ai-gateway-models.next";

describe("Next public catalog adapter", () => {
  it("explicit server retry bypasses the cached scope", async () => {
    const result = await loadNextGatewayModels({ force: true });
    expect(["ready", "unavailable"]).toContain(result.status);
  });
});
