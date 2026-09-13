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
const fixture = async (responses: Response[]) => {
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
    return Promise.resolve(response);
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
