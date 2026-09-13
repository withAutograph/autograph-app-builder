import { expect, it } from "vitest";
import { InMemoryHostedEveStore } from "../../lib/eve/hosted-store";
import { hostedEveOperationScopes } from "../../lib/eve/hosted-auth";
import { exerciseReferenceLifecycle } from "./self-reproduction-reference-lifecycle";

it("exercises service recreation and continuation idempotency without claiming generation or browser proof", async () => {
  const result = await exerciseReferenceLifecycle({
    principal: {
      audience: "test",
      issuer: "https://test.example",
      ownerUserId: "owner",
      scopes: Object.values(hostedEveOperationScopes),
      workspaceId: "workspace",
    },
    store: new InMemoryHostedEveStore(),
  });
  expect(result.generationEvidence).toBe(false);
  expect(result.browserParityEvidence).toBe(false);
  expect(result.counts).toEqual({ cancels: 1, sends: 1, starts: 2 });
  expect(result.assertions.find((row) => row.id === "continuation-result-persists")?.passed).toBe(
    true,
  );
  expect(
    result.assertions.find((row) => row.id === "service-recreation-restores-session")?.passed,
  ).toBe(true);
});
