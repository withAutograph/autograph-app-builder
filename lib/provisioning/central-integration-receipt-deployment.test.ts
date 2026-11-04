/* oxlint-disable eslint/require-await -- Closed workload and HTTP boundary fixtures. */
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { createCentralIntegrationReceiptDeploymentHandler } from "./central-integration-receipt-deployment";
const url =
  "https://builder.example/api/central-integrations/deployment-events/11111111-1111-4111-a111-111111111111";
const request = (body: BodyInit = "provider-body") =>
  new Request(url, {
    method: "POST",
    headers: {
      "x-vercel-signature": "a".repeat(40),
      authorization: "Bearer caller-controlled",
      cookie: "do-not-forward",
    },
    body,
  });
test("public ingress forwards exact bounded bytes only to configured operator with its own fresh workload", async () => {
  let tokenCalls = 0;
  const bytes = Uint8Array.from([0, 255, 1, 254]);
  const fetcher = vi.fn<typeof fetch>(async (target, init) => {
    expect(target).toEqual(new URL("https://operator.example/v1/central-deployment-events"));
    expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer current-workload-${tokenCalls}`);
    expect(headers.get("x-vercel-trusted-oidc-idp-token")).toBe(`current-workload-${tokenCalls}`);
    expect(headers.get("cookie")).toBeNull();
    const body = z
      .strictObject({ subscriptionRef: z.uuid(), signature: z.string(), bodyBase64: z.string() })
      .parse(JSON.parse(z.string().parse(init?.body)));
    expect(body.signature).toBe("a".repeat(40));
    expect(Buffer.from(body.bodyBase64, "base64")).toEqual(Buffer.from(bytes));
    return Response.json({ code: "accepted" });
  });
  const relay = createCentralIntegrationReceiptDeploymentHandler(
    { HOSTED_RUNTIME_OPERATOR_URL: "https://operator.example" },
    {
      fetch: fetcher,
      token: async () => {
        tokenCalls += 1;
        return `current-workload-${tokenCalls}`;
      },
    },
  );
  const first = await relay(request(bytes));
  const second = await relay(request(bytes));
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(tokenCalls).toBe(2);
});
test.each([
  undefined,
  "http://operator.example",
  "https://operator.example/not-an-origin",
  "https://operator.example/?upstream=https://foreign.example",
])("unconfigured or changed upstream cannot acquire workload or dispatch: %s", async (endpoint) => {
  const token = vi.fn(async () => "must-not-read");
  const fetcher = vi.fn<typeof fetch>();
  const response = await createCentralIntegrationReceiptDeploymentHandler(
    { HOSTED_RUNTIME_OPERATOR_URL: endpoint },
    { token, fetch: fetcher },
  )(request());
  expect(response.status).toBe(503);
  expect(token).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});
test("oversized input is refused before token acquisition regardless of declared body size", async () => {
  const token = vi.fn(async () => "must-not-read");
  const fetcher = vi.fn<typeof fetch>();
  const response = await createCentralIntegrationReceiptDeploymentHandler(
    { HOSTED_RUNTIME_OPERATOR_URL: "https://operator.example" },
    { token, fetch: fetcher },
  )(request("x".repeat(262145)));
  expect(response.status).toBe(503);
  expect(token).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});
test("provider or upstream raw bodies never become a callback response", async () => {
  const relay = createCentralIntegrationReceiptDeploymentHandler(
    { HOSTED_RUNTIME_OPERATOR_URL: "https://operator.example" },
    {
      token: async () => "own-workload",
      fetch: async () => new Response("private-provider-body", { status: 403 }),
    },
  );
  const response = await relay(request());
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private-provider-body");
});
test("aborted public delivery cannot acquire workload or contact operator", async () => {
  const cancellation = new AbortController();
  cancellation.abort();
  const token = vi.fn(async () => "must-not-read");
  const fetcher = vi.fn<typeof fetch>();
  const incoming = new Request(url, {
    method: "POST",
    headers: { "x-vercel-signature": "a".repeat(40) },
    body: "body",
    signal: cancellation.signal,
  });
  const response = await createCentralIntegrationReceiptDeploymentHandler(
    { HOSTED_RUNTIME_OPERATOR_URL: "https://operator.example" },
    { token, fetch: fetcher },
  )(incoming);
  expect(response.status).toBe(503);
  expect(token).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});
