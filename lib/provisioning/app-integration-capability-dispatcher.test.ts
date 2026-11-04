/* oxlint-disable eslint/require-await -- Controlled authority ports preserve their production Promise contracts. */
import { expect, test, vi } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Drizzle uses the complete existing schema.
import * as schema from "../db/schema";

import type { ReadOwnedBuilderDestination } from "./owned-builder-runtime";
import { operatorOwnerContextSchema } from "./hosted-operator-contract";
import { integrationCapabilityPlan as plan } from "./app-integration-capability-test-fixture";
import { createAppIntegrationCapabilityDeployment } from "./app-integration-capability-deployment";

const ownerContext = operatorOwnerContextSchema.parse({
  kind: "direct",
  authority: plan.authority,
  principal: { ...plan.authority, scopes: ["autograph:send"] },
  sessionId: plan.selection.sessionId,
  adapterSessionId: "native",
  adapterGeneration: 1,
});
const request = () =>
  new Request("https://operator.example/v1/app-integrations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "app-integration-capability-plan",
      appId: plan.selection.appId,
      ownerContext,
      adapterSessionId: "native",
      callId: "current-call",
      execution: { logicalSessionId: "native" },
    }),
  });
test("actual native factory authenticates owner then reports missing protected profile without database/provider effects", async () => {
  // postgres-js connects lazily. This test cannot reach SQL: profile validation precedes private reads.
  const client = postgres("postgresql://unused@127.0.0.1:1/unused", { max: 1 });
  const owner = {
    verifyWorkload: vi.fn(async () => {}),
    assertCanonicalAppOwner: vi.fn(async () => {}),
    // oxlint-disable-next-line unicorn/no-useless-undefined -- A never-created destination is explicitly absent under the real reader port.
    readStandardDestination: vi.fn<ReadOwnedBuilderDestination>().mockResolvedValue(undefined),
  };
  try {
    const handler = createAppIntegrationCapabilityDeployment({
      database: drizzle(client, { schema }),
      owner,
      environment: {},
    });
    const response = await handler(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      status: "blocked",
      code: "app_integration_profile_required",
      providerActivation: "unassessed",
      hostedAcceptance: "unassessed",
    });
    expect(owner.verifyWorkload.mock.invocationCallOrder[0]).toBeLessThan(
      owner.assertCanonicalAppOwner.mock.invocationCallOrder[0],
    );
    expect(owner.readStandardDestination).not.toHaveBeenCalled();
    owner.verifyWorkload.mockRejectedValue(new Error("private authorization secret"));
    const denied = await handler(request());
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain("private authorization secret");
  } finally {
    await client.end();
  }
});
