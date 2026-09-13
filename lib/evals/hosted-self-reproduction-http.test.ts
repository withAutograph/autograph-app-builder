import { expect, it, vi } from "vitest";
import { createHostedEvalHttpHandler } from "./hosted-self-reproduction-http";
import type { HostedEvalHttpRuntime } from "./hosted-self-reproduction-http";
import { hostedSelfReproductionRuntime } from "./hosted-self-reproduction-runtime";

const fixture = () => {
  const identity = {
    ref: "refs/heads/main",
    repositoryId: "1341836922",
    runAttempt: "3",
    runId: "12",
    workflowRef: "fixed-workflow",
  };
  const status = vi.fn(() =>
    Promise.resolve({
      artifacts: [],
      cleanup: "pending",
      diagnostics: [],
      id: "1341836922:12:3",
      status: "running",
    }),
  );
  const artifact = vi.fn(() =>
    Promise.resolve({ content: new Uint8Array([1, 2]), contentType: "application/gzip" }),
  );
  const controller = vi.fn(() => Promise.resolve({ artifact, start: status, status }));
  const authorize = vi.fn(() => Promise.resolve(identity));
  const runtime = { authorize, controller } as unknown as HostedEvalHttpRuntime;
  return {
    artifact,
    authorize,
    controller,
    handle: createHostedEvalHttpHandler(() => runtime),
    status,
  };
};
const request = (body: unknown, token = "synthetic-token") =>
  new Request("https://builder/api/evals/self-reproduction", {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", authorization: `Bearer ${token}` },
    method: "POST",
  });

it("remains lazy and unavailable when deployment config is absent", async () => {
  expect(hostedSelfReproductionRuntime({})).toBeUndefined();
  const response = await createHostedEvalHttpHandler(() => {})(request({ action: "start" }));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "eval_unavailable" });
});
it("authorizes before any controller, database, or provider construction", async () => {
  const f = fixture();
  f.authorize.mockRejectedValueOnce(new Error("private JWT diagnostic"));
  const response = await f.handle(request({ action: "start" }));
  expect(response.status).toBe(401);
  expect(f.controller).not.toHaveBeenCalled();
  expect(await response.text()).not.toContain("private");
});
it("rejects caller run scope and implementation parameters", async () => {
  const f = fixture();
  const response = await f.handle(
    request({ action: "start", prompt: "caller workload", runId: "other" }),
  );
  expect(response.status).toBe(400);
  expect(f.controller).not.toHaveBeenCalled();
});
it("derives status identity from the verified run attempt only", async () => {
  const f = fixture();
  const response = await f.handle(request({ action: "status" }));
  expect(response.status).toBe(200);
  expect(f.status).toHaveBeenCalledWith("synthetic-token", "1341836922:12:3");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
it("returns private artifact bytes without content sniffing or active HTML", async () => {
  const f = fixture();
  const response = await f.handle(request({ action: "artifact", artifactId: "evidence.tar.gz" }));
  expect(f.artifact).toHaveBeenCalledWith("synthetic-token", "1341836922:12:3", "evidence.tar.gz");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-disposition")).toBe(
    'attachment; filename="evidence.tar.gz"',
  );
  expect(response.headers.get("content-security-policy")).toContain("sandbox");
});
it("sanitizes runtime errors without weakening authorization", async () => {
  const f = fixture();
  f.controller.mockRejectedValueOnce(new Error("postgres://secret"));
  const response = await f.handle(request({ action: "start" }));
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("secret");
});

it("rejects a malformed GitHub token with the real configured runtime before adapter imports", async () => {
  const runtime = hostedSelfReproductionRuntime({
    DATABASE_URL: "postgresql://unreachable.invalid/fixture",
    SELF_REPRODUCTION_GITHUB_AUDIENCE: "https://builder.example/api/evals/self-reproduction",
    VERCEL_ENV: "production",
    VERCEL_GIT_COMMIT_SHA: "deployment-owned-revision",
    VERCEL_PROJECT_ID: "prj_fixture",
    VERCEL_TEAM_ID: "team_fixture",
  });
  expect(runtime).toBeDefined();
  if (!runtime) throw new Error("Configured fixture did not produce a runtime");
  const controller = vi.spyOn(runtime, "controller");
  const response = await createHostedEvalHttpHandler(() => runtime)(
    request({ action: "start" }, "not-a-jwt"),
  );
  expect(response.status).toBe(401);
  expect(controller).not.toHaveBeenCalled();
});

it("streams retained artifacts larger than five megabytes without a buffered response length", async () => {
  const f = fixture();
  const content = new Uint8Array(6 * 1024 * 1024).fill(173);
  f.artifact.mockResolvedValueOnce({ content, contentType: "application/gzip" });
  const response = await f.handle(request({ action: "artifact", artifactId: "evidence.tar.gz" }));
  expect(response.headers.has("content-length")).toBe(false);
  expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.from(content))).toBe(true);
});

it.each(["SELF_REPRODUCTION_GITHUB_AUDIENCE", "VERCEL_PROJECT_ID", "VERCEL_GIT_COMMIT_SHA"])(
  "leaves runtime disabled without %s and makes no network request",
  async (missing) => {
    const environment: Record<string, string | undefined> = {
      DATABASE_URL: "postgresql://unreachable.invalid/fixture",
      SELF_REPRODUCTION_GITHUB_AUDIENCE: "https://builder.example/api/evals/self-reproduction",
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_SHA: "deployment-owned-revision",
      VERCEL_PROJECT_ID: "prj_fixture",
      VERCEL_TEAM_ID: "team_fixture",
      [missing]: undefined,
    };
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      expect(hostedSelfReproductionRuntime(environment)).toBeUndefined();
      const response = await createHostedEvalHttpHandler(() =>
        hostedSelfReproductionRuntime(environment),
      )(request({ action: "start" }));
      expect(response.status).toBe(503);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  },
);
