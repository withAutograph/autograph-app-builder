import config from "./operator-host/vercel.json";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import entrypoint from "./operator-host/entrypoint";
import { createHostedOperatorNativeHandler } from "./hosted-operator-native";
import { HostedOperatorError } from "./hosted-operator-contract";
import type { ProtectedHostedOperatorDependencies } from "./hosted-operator-service";

const request = () =>
  new Request("https://operator.example.test/v1/runtime", {
    body: JSON.stringify({
      action: "plan",
      operation: "prepare",
      selection: {
        appId: "reports",
        branch: "qualification",
        environment: "preview",
        projectId: "prj_reports",
        sessionId: "session_reports",
      },
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
const forbidden = async (): Promise<never> => await Promise.reject(new Error("Unexpected effect"));
const deniedDependencies = (): ProtectedHostedOperatorDependencies => ({
  assertAuthorized: forbidden,
  authorize: vi.fn(
    async () => await Promise.reject(new HostedOperatorError("authorization_required")),
  ),
  bindings: forbidden,
  executeEffect: forbidden,
  plan: forbidden,
  readApproval: forbidden,
  reconcile: forbidden,
  store: {
    compareAndSet: forbidden,
    read: forbidden,
    reserve: forbidden,
    reserveFenceGeneration: forbidden,
  },
  verify: forbidden,
  withResourceLease: forbidden,
});
describe("separate native operator host", () => {
  it("defines only a native operator service and exact reachable ingress, with no root build", () => {
    const root = path.resolve(import.meta.dirname, "../..");
    expect(config.services).toEqual({
      operator: {
        entrypoint: "entrypoint.ts",
        framework: "hono",
        root: ".",
      },
    });
    expect(config.rewrites).toEqual([
      { destination: { service: "operator" }, source: "/v1/runtime" },
    ]);
    expect(readFileSync(path.join(root, "vercel.json"), "utf-8")).toContain("next build");
  });
  it("the actual entrypoint returns503 until a real factory is statically wired, without readiness claims", async () => {
    const response = await entrypoint.fetch(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ code: "protected_operator_required" });
  });
  it.each([
    new Request("https://operator.example.test/health"),
    new Request("https://operator.example.test/v1/runtime"),
  ])("rejects other routes/methods before factory loading", async (input) => {
    const loader = vi.fn(async () => await Promise.resolve(deniedDependencies()));
    const response = await createHostedOperatorNativeHandler({ createDependencies: loader })(input);
    expect(response.status).toBe(404);
    expect(loader).not.toHaveBeenCalled();
  });
  it("delegates authorization to the real protected operator and shares successful initialization", async () => {
    const dependencies = deniedDependencies();
    const loader = vi.fn(async () => await Promise.resolve(dependencies));
    const handler = createHostedOperatorNativeHandler({ createDependencies: loader });
    const responses = await Promise.all([handler(request()), handler(request())]);
    expect(
      await Promise.all(
        responses.map(async (response) => {
          const value: unknown = await response.json();
          return value;
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        authenticatedBehavior: "unassessed",
        code: "authorization_required",
        status: "blocked",
      }),
      expect.objectContaining({
        authenticatedBehavior: "unassessed",
        code: "authorization_required",
        status: "blocked",
      }),
    ]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(dependencies.authorize).toHaveBeenCalledTimes(2);
  });
  it("does not expose initialization errors and retries a failed factory rather than claim readiness", async () => {
    const dependencies = deniedDependencies();
    const loader = vi.fn(async () => {
      if (loader.mock.calls.length === 1) {
        return await Promise.reject(new Error("private credential material"));
      }
      return await Promise.resolve(dependencies);
    });
    const handler = createHostedOperatorNativeHandler({ createDependencies: loader });
    const first = await handler(request());
    expect(first.status).toBe(503);
    expect(await first.text()).not.toContain("private credential material");
    const retry = await handler(request());
    expect(retry.status).not.toBe(503);
    expect(loader).toHaveBeenCalledTimes(2);
  });
  it("rejects an incomplete concrete factory through existing dependency validation", async () => {
    const dependencies = deniedDependencies();
    Reflect.deleteProperty(dependencies, "store");
    const handler = createHostedOperatorNativeHandler({
      createDependencies: async () => await Promise.resolve(dependencies),
    });
    const response = await handler(request());
    expect(response.status).toBe(503);
    expect(dependencies.authorize).not.toHaveBeenCalled();
  });
});
