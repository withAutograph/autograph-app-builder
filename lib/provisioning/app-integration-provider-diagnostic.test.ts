import { expect, it } from "vitest";
import { integrationProviderHttpError } from "./app-integration-provider-diagnostic";

it("derives closed codes from HTTP and drops unbounded or URL-bearing request references", () => {
  for (const reference of [
    "https://private.example/secret",
    "token with spaces",
    "x".repeat(161),
  ]) {
    expect(
      integrationProviderHttpError(
        new Response("not parsed", { headers: { "x-request-id": reference }, status: 429 }),
      ).diagnostic,
    ).toEqual({ code: "rate_limited", provider: "ampersand", statusCode: 429 });
  }
});
