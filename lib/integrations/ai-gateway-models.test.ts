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
            id: "openai/live-model",
            name: "Live Model",
            owned_by: "openai",
            type: "language",
            zdr: "all",
            tags: ["tool-use"],
          },
          {
            id: "openai/embedding",
            name: "Embedding",
            owned_by: "openai",
            type: "embedding",
            zdr: "all",
            tags: [],
          },
        ],
      }),
    );
    const result = await loadGatewayModels({
      fetch: request,
      defaultModelId: "openai/live-model",
      now: () => 1,
    });
    expect(result.status).toBe("ready");
    expect(result.entries).toEqual([
      {
        id: "openai/live-model",
        name: "Live Model",
        provider: "openai",
        capabilities: ["tool-use"],
        zdr: "all",
      },
    ]);
    expect(result.defaultModelId).toBe("openai/live-model");
  });

  it("uses a validated cached catalog during a transient provider failure", async () => {
    await loadGatewayModels({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          data: [
            {
              id: "a/model",
              name: "Model",
              owned_by: "a",
              type: "language",
              zdr: "some",
              tags: [],
            },
          ],
        }),
      ),
      now: () => 1,
    });
    const result = await loadGatewayModels({
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")),
      now: () => 10_000_000,
      force: true,
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
      status: "unavailable",
      entries: [],
      cached: false,
    });
  });
});
