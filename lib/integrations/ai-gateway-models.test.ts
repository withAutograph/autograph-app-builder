import { afterEach, describe, expect, it, vi } from "vitest";

import { loadGatewayModels, resetGatewayModelCacheForTests } from "./ai-gateway-models";

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
      defaultModelId: "openai/gpt-5.6-terra",
    });
    expect(result.status).toBe("ready");
    expect(result.entries).toEqual([
      {
        id: "openai/gpt-5.6-terra",
        name: "GPT 5.6 Terra",
        provider: "openai",
        capabilities: ["tool-use"],
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
              type: "language",
              zdr: "some",
              tags: [],
            },
          ],
        }),
      ),
    });
    const result = await loadGatewayModels({
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")),
    });
    expect(result.status).toBe("ready");
    expect(result.cached).toBe(true);
  });

  it("reports unavailable instead of restoring seeded models", async () => {
    const result = await loadGatewayModels({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 })),
    });
    expect(result).toEqual({
      status: "unavailable",
      entries: [],
      cached: false,
    });
  });

  it("retries after failure and never uses last-known-good as a freshness cache", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("offline"))
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      .mockImplementation(async () =>
        Response.json({
          data: [
            {
              id: "openai/gpt-5.6-terra",
              name: "Terra",
              owned_by: "openai",
              type: "language",
              tags: [],
            },
          ],
        }),
      );
    expect((await loadGatewayModels({ fetch: request })).status).toBe("unavailable");
    expect((await loadGatewayModels({ fetch: request })).status).toBe("ready");
    expect((await loadGatewayModels({ fetch: request })).cached).toBe(false);
    expect(request).toHaveBeenCalledTimes(3);
  });
});
