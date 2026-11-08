import { PublicReleasePrerequisiteError } from "./public-release-prerequisite";
/* oxlint-disable unicorn/no-useless-undefined, unicorn/no-await-expression-member, eslint/require-await -- Promise mocks and direct HTTP assertions use the real asynchronous port contracts. */
import { describe, expect, it, vi } from "vitest";
import { createPublicReleaseDispatcher } from "./public-release-dispatcher";
import type { PublicReleasePorts } from "./public-release-handler";
import { authority, plan } from "./public-release-test-fixture";
import { operatorOwnerContextSchema } from "./hosted-operator-contract";
import { publicReleaseOperationRef, publicReleasePlanDigest } from "./public-release-contract";
import { initialPublicReleaseRecord } from "./public-release-store";

const ownerContext = operatorOwnerContextSchema.parse({
  kind: "direct",
  authority,
  principal: { ...authority, scopes: ["autograph:send"] },
  sessionId: plan.selection.sessionId,
  adapterSessionId: "native",
  adapterGeneration: 1,
});
const common = {
  ownerContext,
  adapterSessionId: "native",
  callId: "current-call",
  execution: { logicalSessionId: "native" },
};
// oxlint-disable-next-line anti-slop/no-object-parameters -- Malformed external JSON is deliberately sent through the real request parser.
const request = (body: object, path = "/v1/public-release") =>
  new Request(`https://operator.example${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
const fixture = () => {
  const row = {
    operationRef: publicReleaseOperationRef(plan),
    revision: 1,
    record: initialPublicReleaseRecord(plan),
  };
  const ports: PublicReleasePorts = {
    store: {
      read: vi.fn().mockResolvedValue(row),
      reserve: vi.fn().mockResolvedValue(row),
      compareAndSet: vi.fn(),
    },
    resolve: vi.fn().mockResolvedValue(plan),
    assertAuthorized: vi.fn().mockResolvedValue(undefined),
    assertApproved: vi.fn().mockRejectedValue(new Error("pending")),
    withTargetLease: vi.fn(),
    reconcileEffect: vi.fn(),
    applyEffect: vi.fn(),
    observe: vi.fn(),
  };
  const owner = {
    verifyWorkload: vi.fn().mockResolvedValue(undefined),
    assertCanonicalAppOwner: vi.fn().mockResolvedValue(undefined),
  };
  const createPorts = vi.fn().mockResolvedValue(ports);
  return {
    ports,
    owner,
    createPorts,
    handler: createPublicReleaseDispatcher({ owner, createPorts }),
  };
};
describe("public release HTTP authority boundary", () => {
  it("authenticates and checks the canonical app owner before planning without effects", async () => {
    const f = fixture();
    const result = await f.handler(
      request({ ...common, action: "public-release-plan", appId: plan.selection.appId }),
    );
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toMatchObject({ plan });
    expect(f.owner.verifyWorkload.mock.invocationCallOrder[0]).toBeLessThan(
      f.owner.assertCanonicalAppOwner.mock.invocationCallOrder[0],
    );
    expect(f.owner.assertCanonicalAppOwner.mock.invocationCallOrder[0]).toBeLessThan(
      f.createPorts.mock.invocationCallOrder[0],
    );
    expect(f.ports.applyEffect).not.toHaveBeenCalled();
  });
  it("returns a bounded actionable prerequisite while keeping arbitrary internal errors private", async () => {
    const f = fixture();
    f.createPorts.mockRejectedValue(
      new PublicReleasePrerequisiteError("same_project_auth_required"),
    );
    const result = await f.handler(
      request({ ...common, action: "public-release-plan", appId: plan.selection.appId }),
    );
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({
      authenticatedBehavior: "unassessed",
      code: "same_project_auth_required",
      status: "blocked",
    });
    expect(f.ports.applyEffect).not.toHaveBeenCalled();
  });
  it("rejects unverified workload before private composition", async () => {
    const f = fixture();
    f.owner.verifyWorkload.mockRejectedValue(new Error("secret token"));
    const result = await f.handler(
      request({ ...common, action: "public-release-plan", appId: plan.selection.appId }),
    );
    expect(result.status).toBe(403);
    expect(f.createPorts).not.toHaveBeenCalled();
    expect(await result.text()).not.toContain("secret token");
  });
  it("requires current-call approval before lease or provider writes", async () => {
    const f = fixture();
    const result = await f.handler(
      request({
        ...common,
        action: "public-release-run",
        input: {
          plan,
          operationRef: publicReleaseOperationRef(plan),
          planDigest: publicReleasePlanDigest(plan),
        },
      }),
    );
    expect(result.status).toBe(403);
    expect(f.ports.assertApproved).toHaveBeenCalled();
    expect(f.ports.withTargetLease).not.toHaveBeenCalled();
    expect(f.ports.applyEffect).not.toHaveBeenCalled();
  });
  it("refuses observation before approved effects have run", async () => {
    const f = fixture();
    const result = await f.handler(
      request({
        ...common,
        action: "public-release-observe",
        input: {
          plan,
          operationRef: publicReleaseOperationRef(plan),
          planDigest: publicReleasePlanDigest(plan),
        },
      }),
    );
    expect(result.status).toBe(403);
    expect(f.ports.assertApproved).not.toHaveBeenCalled();
    expect(f.ports.observe).not.toHaveBeenCalled();
    expect(f.ports.withTargetLease).not.toHaveBeenCalled();
  });
  it("rejects crossed adapter identity and wrong routes without planning", async () => {
    const f = fixture();
    expect(
      (
        await f.handler(
          request({
            ...common,
            adapterSessionId: "foreign",
            action: "public-release-plan",
            appId: plan.selection.appId,
          }),
        )
      ).status,
    ).toBe(403);
    expect(f.createPorts).not.toHaveBeenCalled();
    expect((await f.handler(request({}, "/v1/runtime"))).status).toBe(404);
  });
  it("does not return a plan after canonical ownership is revoked during planning", async () => {
    const f = fixture();
    f.ports.resolve = vi.fn(async () => {
      f.owner.assertCanonicalAppOwner.mockRejectedValue(new Error("revoked"));
      return plan;
    });
    expect(
      (
        await f.handler(
          request({ ...common, action: "public-release-plan", appId: plan.selection.appId }),
        )
      ).status,
    ).toBe(403);
  });
});
