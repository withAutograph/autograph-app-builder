import { beforeEach, describe, expect, it, vi } from "vitest";
import { cacheLife, cacheTag } from "next/cache";
import { loadGatewayModels } from "./ai-gateway-models";
import { loadNextGatewayModels } from "./ai-gateway-models.next";

// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled server-only dependency used by this test.
vi.mock("server-only", () => ({}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled next/cache dependency used by this test.
vi.mock("next/cache", () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled ./ai-gateway-models dependency used by this test.
vi.mock("./ai-gateway-models", () => ({ loadGatewayModels: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

describe("Next public catalog adapter", () => {
  it("caches only the public loader with explicit freshness", async () => {
    vi.mocked(loadGatewayModels).mockResolvedValue({ cached: false, entries: [], status: "ready" });
    await loadNextGatewayModels();
    expect(loadGatewayModels).toHaveBeenCalledWith();
    expect(cacheTag).toHaveBeenCalledWith("public-ai-gateway-models");
    expect(cacheLife).toHaveBeenCalledExactlyOnceWith({
      expire: 3600,
      revalidate: 300,
      stale: 300,
    });
  });

  it.each(["unavailable", "fallback"])(
    "retries %s without the normal five-minute lifetime",
    async (state) => {
      vi.mocked(loadGatewayModels).mockResolvedValue({
        cached: state === "fallback",
        entries: [],
        status: state === "unavailable" ? "unavailable" : "ready",
      });
      await loadNextGatewayModels();
      expect(cacheLife).toHaveBeenCalledExactlyOnceWith({ expire: 60, revalidate: 1, stale: 30 });
    },
  );

  it("explicit server retry bypasses the cached scope", async () => {
    vi.mocked(loadGatewayModels).mockResolvedValue({
      cached: false,
      entries: [],
      status: "unavailable",
    });
    await loadNextGatewayModels({ force: true });
    expect(loadGatewayModels).toHaveBeenCalledOnce();
    expect(cacheLife).not.toHaveBeenCalled();
    expect(cacheTag).not.toHaveBeenCalled();
  });
});
