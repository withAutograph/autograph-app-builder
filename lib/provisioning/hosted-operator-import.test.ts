import { afterEach, expect, it, vi } from "vitest";

// A native operator has no agent tool runtime. Reproduce that deployment
// boundary without changing the installed dependency cache or any provider.
// oxlint-disable-next-line anti-slop/no-module-mocking -- Reproduce the actual missing deployment dependency; no runtime implementation is replaced.
vi.mock("eve/tools", () => {
  throw new Error("Agent tools are unavailable in the native operator");
});
// oxlint-disable-next-line anti-slop/no-module-mocking -- Reproduce the actual missing inference dependency while exercising the real operator and runner.
vi.mock("ai", () => {
  throw new Error("Model inference is unavailable in the native operator");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it("cold-starts the actual native operator and returns its configured failure response without the agent tool or inference runtime", async () => {
  vi.stubEnv("PROTECTED_HOSTED_OPERATOR_CONFIGURATION", "");
  vi.stubEnv("PROTECTED_HOSTED_OPERATOR_AUTHORIZATION_CONFIGURATION", "");
  const { default: entrypoint } = await import("./hosted-operator-function");
  const response = await entrypoint.fetch(
    new Request("https://operator.example/v1/runtime", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ code: "protected_operator_required" });
  expect(response.headers.get("cache-control")).toBe("no-store");
});
