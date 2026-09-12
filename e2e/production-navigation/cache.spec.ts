import { expect, test } from "playwright/test";

test("compiled public catalog cache reuses, revalidates, falls back, and recovers", async ({
  request,
}) => {
  const probe = "/__production-cache-probe";
  expect((await request.post(probe, { data: "reset" })).status()).toBe(204);
  const cold = await request.get(probe);
  expect(cold.ok()).toBe(true);
  expect(await cold.json()).toMatchObject({
    upstreamCalls: 1,
    models: { status: "ready", cached: false, entries: [{ name: "Navigation catalog 1" }] },
  });

  expect(await (await request.get(probe)).json()).toMatchObject({ upstreamCalls: 1 });

  expect((await request.post(probe, { data: "advance" })).status()).toBe(204);
  expect(await (await request.get(probe)).json()).toMatchObject({
    upstreamCalls: 2,
    models: { status: "ready", cached: false, entries: [{ name: "Navigation catalog 2" }] },
  });

  expect((await request.post(probe, { data: "fail" })).status()).toBe(204);
  expect(await (await request.get(probe)).json()).toMatchObject({
    upstreamCalls: 3,
    models: { status: "ready", cached: true, entries: [{ name: "Navigation catalog 2" }] },
  });

  expect((await request.post(probe, { data: "recover" })).status()).toBe(204);
  expect(await (await request.get(probe)).json()).toMatchObject({
    upstreamCalls: 4,
    models: { status: "ready", cached: false, entries: [{ name: "Navigation catalog 3" }] },
  });
  expect(await (await request.get(probe)).json()).toMatchObject({ upstreamCalls: 4 });
});
