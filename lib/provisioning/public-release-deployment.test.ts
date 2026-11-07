/* oxlint-disable unicorn/no-useless-undefined -- Mocked optional owner/project reads preserve their real absence contracts. */
import { describe, expect, it, vi } from "vitest";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { operatorOwnerContextSchema } from "./hosted-operator-contract";
import { createPublicReleaseDeployment } from "./public-release-deployment";
import { plan, authority } from "./public-release-test-fixture";

const ownerContext = operatorOwnerContextSchema.parse({
  kind: "direct",
  authority,
  principal: { ...authority, scopes: ["autograph:send"] },
  sessionId: plan.selection.sessionId,
  adapterSessionId: "native",
  adapterGeneration: 1,
});
const request = () =>
  new Request("https://operator.example/v1/public-release", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "public-release-plan",
      appId: plan.selection.appId,
      ownerContext,
      adapterSessionId: "native",
      callId: "current-call",
      execution: { logicalSessionId: "native" },
    }),
  });
const fixture = () => {
  const limit = vi.fn(() => Promise.resolve([]));
  const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit }) }) }));
  // SAFETY: This test supplies only the exact read-only Drizzle query chain consumed by the readiness reader; no write/effect method exists.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- The deliberately partial read-only database fixture exercises the real HTTP prerequisite path.
  const database = { select } as unknown as ReturnType<typeof openHostedPostgresDatabase>;
  const owner = {
    verifyWorkload: vi.fn<() => Promise<void>>().mockResolvedValue(),
    assertCanonicalAppOwner: vi.fn<() => Promise<void>>().mockResolvedValue(),
    readStandardDestination: vi.fn<
      Parameters<typeof createPublicReleaseDeployment>[0]["owner"]["readStandardDestination"]
    >(() => Promise.resolve({ ...plan.project })),
  };
  return { owner, select, handler: createPublicReleaseDeployment({ database, owner }) };
};
describe("mounted public release native preparation inspection", () => {
  it("requires the canonical normal Builder destination before any runtime journal read", async () => {
    const f = fixture();
    f.owner.readStandardDestination.mockResolvedValue(undefined);
    const response = await f.handler(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "builder_destination_required" });
    expect(f.select).not.toHaveBeenCalled();
  });
  it("requires actual dedicated normal repository creation provenance before reading or publishing source", async () => {
    const f = fixture();
    const response = await f.handler(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "public_release_source_required" });
    expect(f.select).toHaveBeenCalledTimes(1);
    expect(f.owner.readStandardDestination).toHaveBeenCalledWith({
      authority,
      ownerContext,
      target: plan.selection,
    });
  });
});
