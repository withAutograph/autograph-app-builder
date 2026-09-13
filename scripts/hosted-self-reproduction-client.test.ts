import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runHostedSelfReproductionClient } from "./hosted-self-reproduction-client.mts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});
const fixture = async (responses: (Response | Error)[]) => {
  const outputDirectory = await mkdtemp(path.join(tmpdir(), "hosted-client-test-"));
  roots.push(outputDirectory);
  let token = 0;
  const request = vi.fn<typeof fetch>((url) => {
    if (String(url).startsWith("https://github.test/")) {
      token += 1;
      return Promise.resolve(Response.json({ value: `fresh-${token}` }));
    }
    const response = responses.shift();
    if (!response) return Promise.reject(new Error("network error bearer-secret"));
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  });
  return {
    input: {
      audience: "eval-audience",
      endpoint: "https://controller.test/api/evals/self-reproduction",
      fetch: request,
      outputDirectory,
      pause: () => Promise.resolve(),
      tokenRequestToken: "request-secret",
      tokenRequestUrl: "https://github.test/token?existing=1",
    },
    outputDirectory,
    request,
  };
};
it("refreshes OIDC on each request and downloads completed artifacts", async () => {
  const f = await fixture([
    Response.json({ artifacts: [], status: "running" }),
    Response.json({
      artifacts: [{ contentType: "application/json", id: "report.json" }],
      status: "completed",
    }),
    new Response("original report"),
  ]);
  expect(await runHostedSelfReproductionClient(f.input)).toBe(0);
  expect(await readFile(path.join(f.outputDirectory, "artifacts/report.json"), "utf-8")).toBe(
    "original report",
  );
  const controllerCalls = f.request.mock.calls.filter((call) =>
    String(call[0]).startsWith("https://controller.test"),
  );
  expect(
    controllerCalls.map(
      (call) => (call[1]?.headers as Record<string, string> | undefined)?.authorization,
    ),
  ).toEqual(["Bearer fresh-1", "Bearer fresh-2", "Bearer fresh-3"]);
  expect(controllerCalls.map((call) => JSON.parse(String(call[1]?.body)))).toEqual([
    { action: "start" },
    { action: "status" },
    { action: "artifact", artifactId: "report.json" },
  ]);
  expect(String(f.request.mock.calls[0][0])).toContain("audience=eval-audience");
});
it("retains partial artifacts and receipt on failed eval even when one download fails", async () => {
  const f = await fixture([
    Response.json({
      artifacts: [
        { contentType: "application/json", id: "bad.json" },
        { contentType: "text/markdown", id: "report.md" },
      ],
      status: "failed",
    }),
    new Response("private provider error", { status: 503 }),
    new Response("partial evidence"),
  ]);
  expect(await runHostedSelfReproductionClient(f.input)).toBe(1);
  expect(await readFile(path.join(f.outputDirectory, "artifacts/report.md"), "utf-8")).toBe(
    "partial evidence",
  );
  const receipt = await readFile(path.join(f.outputDirectory, "client-receipt.json"), "utf-8");
  expect(receipt).toContain("bad.json");
  expect(receipt).not.toContain("private provider error");
});
it("rejects traversal artifact IDs while preserving valid evidence", async () => {
  const f = await fixture([
    Response.json({
      artifacts: [
        { contentType: "text/plain", id: "../escape" },
        { contentType: "text/markdown", id: "report.md" },
      ],
      status: "completed",
    }),
    new Response("retained"),
  ]);
  expect(await runHostedSelfReproductionClient(f.input)).toBe(1);
  expect(await readFile(path.join(f.outputDirectory, "artifacts/report.md"), "utf-8")).toBe(
    "retained",
  );
});
it("times out without a second start and still collects known partial output", async () => {
  const f = await fixture([
    Response.json({
      artifacts: [{ contentType: "application/json", id: "report.json" }],
      status: "running",
    }),
    new Response("partial"),
  ]);
  expect(await runHostedSelfReproductionClient({ ...f.input, timeoutMs: 0 })).toBe(1);
  expect(await readFile(path.join(f.outputDirectory, "artifacts/report.json"), "utf-8")).toBe(
    "partial",
  );
  expect(
    f.request.mock.calls.filter((call) => String(call[1]?.body).includes("start")),
  ).toHaveLength(1);
});
it("redacts transport failures from retained diagnostics", async () => {
  const f = await fixture([]);
  expect(await runHostedSelfReproductionClient(f.input)).toBe(1);
  expect(
    await readFile(path.join(f.outputDirectory, "client-receipt.json"), "utf-8"),
  ).not.toContain("bearer-secret");
});

it("recovers transient status transport and 503 failures without restarting the eval", async () => {
  const f = await fixture([
    Response.json({ artifacts: [], status: "running" }),
    new Error("network bearer-private"),
    new Response("provider private", { status: 503 }),
    Response.json({
      artifacts: [{ contentType: "application/json", id: "report.json" }],
      status: "completed",
    }),
    new Response("retained"),
  ]);
  expect(await runHostedSelfReproductionClient(f.input)).toBe(0);
  const receipt = JSON.parse(
    await readFile(path.join(f.outputDirectory, "client-receipt.json"), "utf-8"),
  );
  expect(receipt.diagnostics).toHaveLength(2);
  expect(receipt.failures).toEqual([]);
  expect(JSON.stringify(receipt)).not.toContain("bearer-private");
  expect(JSON.stringify(receipt)).not.toContain("provider private");
  const actions = f.request.mock.calls
    .filter((call) => String(call[0]).startsWith("https://controller.test"))
    .map((call) => JSON.parse(String(call[1]?.body)).action);
  expect(actions).toEqual(["start", "status", "status", "status", "artifact"]);
});

it.each([400, 401, 403])(
  "does not retry permanent status HTTP %i and retains partial artifacts",
  async (status) => {
    const f = await fixture([
      Response.json({
        artifacts: [{ contentType: "application/json", id: "report.json" }],
        status: "running",
      }),
      new Response("private auth detail", { status }),
      new Response("partial"),
    ]);
    expect(await runHostedSelfReproductionClient(f.input)).toBe(1);
    expect(await readFile(path.join(f.outputDirectory, "artifacts/report.json"), "utf-8")).toBe(
      "partial",
    );
    const receipt = JSON.parse(
      await readFile(path.join(f.outputDirectory, "client-receipt.json"), "utf-8"),
    );
    expect(receipt.diagnostics).toEqual([]);
    expect(receipt.failures).toEqual([`Controller status failed (HTTP ${status}).`]);
    expect(
      f.request.mock.calls.filter((call) => String(call[1]?.body).includes('"action":"status"')),
    ).toHaveLength(1);
  },
);

it("bounds repeated transient status failures by the existing deadline", async () => {
  const f = await fixture([
    Response.json({ artifacts: [], status: "running" }),
    new Response("transient", { status: 503 }),
  ]);
  let now = 0;
  expect(
    await runHostedSelfReproductionClient({
      ...f.input,
      now: () => now,
      pause: () => {
        now += 1;
        return Promise.resolve();
      },
      timeoutMs: 2,
    }),
  ).toBe(1);
  const receipt = JSON.parse(
    await readFile(path.join(f.outputDirectory, "client-receipt.json"), "utf-8"),
  );
  expect(receipt.diagnostics).toHaveLength(1);
  expect(receipt.failures[0]).toContain("polling timed out");
  expect(
    f.request.mock.calls.filter((call) => String(call[1]?.body).includes('"action":"start"')),
  ).toHaveLength(1);
});
