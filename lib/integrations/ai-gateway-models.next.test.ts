import { beforeEach, describe, expect, it, vi } from "vitest";
import { cacheLife, cacheTag } from "next/cache";
import { loadGatewayModels } from "./ai-gateway-models";
import { loadNextGatewayModels } from "./ai-gateway-models.next";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));
vi.mock("./ai-gateway-models", () => ({ loadGatewayModels: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

describe("Next public catalog adapter", () => {
  it("caches only the public loader with explicit freshness", async () => {
    vi.mocked(loadGatewayModels).mockResolvedValue({ status: "ready", entries: [], cached: false });
    await loadNextGatewayModels();
    expect(loadGatewayModels).toHaveBeenCalledWith();
    expect(cacheTag).toHaveBeenCalledWith("public-ai-gateway-models");
    expect(cacheLife).toHaveBeenCalledExactlyOnceWith({
      stale: 300,
      revalidate: 300,
      expire: 3600,
    });
  });

  it.each(["unavailable", "fallback"])(
    "retries %s without the normal five-minute lifetime",
    async (state) => {
      vi.mocked(loadGatewayModels).mockResolvedValue({
        status: state === "unavailable" ? "unavailable" : "ready",
        entries: [],
        cached: state === "fallback",
      });
      await loadNextGatewayModels();
      expect(cacheLife).toHaveBeenCalledExactlyOnceWith({ stale: 30, revalidate: 1, expire: 60 });
    },
  );

  it("explicit server retry bypasses the cached scope", async () => {
    vi.mocked(loadGatewayModels).mockResolvedValue({
      status: "unavailable",
      entries: [],
      cached: false,
    });
    await loadNextGatewayModels({ force: true });
    expect(loadGatewayModels).toHaveBeenCalledOnce();
    expect(cacheLife).not.toHaveBeenCalled();
    expect(cacheTag).not.toHaveBeenCalled();
  });
});
