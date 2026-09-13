import { expect, test } from "playwright/test";

test("compiled public catalog cache reuses, revalidates, falls back, and recovers", async ({
  request,
}) => {
  const probe = "/production-cache-probe";
  const reset = await request.post(probe, { data: "reset" });
  expect(reset.status()).toBe(204);
  const cold = await request.get(probe);
  expect(cold.ok()).toBe(true);
  expect(await cold.json()).toMatchObject({
    models: { cached: false, entries: [{ name: "Navigation catalog 1" }], status: "ready" },
    upstreamCalls: 1,
  });

  const cached = await request.get(probe);
  expect(await cached.json()).toMatchObject({ upstreamCalls: 1 });

  const advance = await request.post(probe, { data: "advance" });
  expect(advance.status()).toBe(204);
  const revalidated = await request.get(probe);
  expect(await revalidated.json()).toMatchObject({
    models: { cached: false, entries: [{ name: "Navigation catalog 2" }], status: "ready" },
    upstreamCalls: 2,
  });

  const fail = await request.post(probe, { data: "fail" });
  expect(fail.status()).toBe(204);
  const fallback = await request.get(probe);
  expect(await fallback.json()).toMatchObject({
    models: { cached: true, entries: [{ name: "Navigation catalog 2" }], status: "ready" },
    upstreamCalls: 3,
  });

  const recover = await request.post(probe, { data: "recover" });
  expect(recover.status()).toBe(204);
  const recovered = await request.get(probe);
  expect(await recovered.json()).toMatchObject({
    models: { cached: false, entries: [{ name: "Navigation catalog 3" }], status: "ready" },
    upstreamCalls: 4,
  });
  const recached = await request.get(probe);
  expect(await recached.json()).toMatchObject({ upstreamCalls: 4 });
});
