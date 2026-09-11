import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadGatewayModels,
  resetGatewayModelCacheForTests,
} from "./ai-gateway-models";

afterEach(() => resetGatewayModelCacheForTests());

describe("AI Gateway model catalog", () => {
  it("keeps language models, live identifiers, ZDR metadata, and a valid configured default", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [
          {
            id: "openai/gpt-5.6-terra",
            name: "GPT 5.6 Terra",
            owned_by: "openai",
            tags: ["tool-use"],
            type: "language",
            zdr: "all",
          },
          {
            id: "openai/embedding",
            name: "Embedding",
            owned_by: "openai",
            tags: [],
            type: "embedding",
            zdr: "all",
          },
        ],
      })
    );
    const result = await loadGatewayModels({
      defaultModelId: "openai/gpt-5.6-terra",
      fetch: request,
      now: () => 1,
    });
    expect(result.status).toBe("ready");
    expect(result.entries).toEqual([
      {
        capabilities: ["tool-use"],
        id: "openai/gpt-5.6-terra",
        name: "GPT 5.6 Terra",
        provider: "openai",
        zdr: "all",
      },
    ]);
    expect(result.defaultModelId).toBe("openai/gpt-5.6-terra");
  });

  it("uses a validated cached catalog during a transient provider failure", async () => {
    await loadGatewayModels({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          data: [
            {
              id: "openai/gpt-5.6-terra",
              name: "GPT 5.6 Terra",
              owned_by: "openai",
              tags: [],
              type: "language",
              zdr: "some",
            },
          ],
        })
      ),
      now: () => 1,
    });
    const result = await loadGatewayModels({
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")),
      force: true,
      now: () => 10_000_000,
    });
    expect(result.status).toBe("ready");
    expect(result.cached).toBe(true);
  });

  it("reports unavailable instead of restoring seeded models", async () => {
    const result = await loadGatewayModels({
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 503 })),
    });
    expect(result).toEqual({
      cached: false,
      entries: [],
      status: "unavailable",
    });
  });
});
