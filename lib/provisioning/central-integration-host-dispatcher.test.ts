import { publicApprovalDescription } from "../agent/approval-receipt";
import { expect, test, vi } from "vitest";
import { createCentralHostDispatcher } from "./central-integration-host-dispatcher";
import {
  centralHostApprovalInputSchema,
  centralHostTransportRequestSchema,
} from "./central-integration-host-transport";
import {
  centralHostOperationRef,
  centralHostPlanDigest,
} from "./central-integration-host-contract";
import { CentralHostPrerequisiteError } from "./central-integration-host-prerequisite";
import { plan } from "./central-integration-host-test-fixture";
import { operatorOwnerContextSchema } from "./hosted-operator-contract";
const input = {
  plan,
  operationRef: centralHostOperationRef(plan),
  planDigest: centralHostPlanDigest(plan),
};
const ownerContext = operatorOwnerContextSchema.parse({
  kind: "direct",
  authority: plan.authority,
  principal: { ...plan.authority, scopes: ["autograph:send"] },
  sessionId: plan.selection.sessionId,
  adapterSessionId: "native",
  adapterGeneration: 1,
});
const body = {
  ownerContext,
  adapterSessionId: "native",
  callId: "current",
  execution: { logicalSessionId: "native" },
  action: "central-integration-host-prepare" as const,
  input,
};
// oxlint-disable-next-line anti-slop/no-object-parameters -- Test HTTP serialization intentionally includes malformed closed request variants.
const request = (value: object = body) =>
  new Request("https://operator.example/v1/central-integrations", {
    method: "POST",
    body: JSON.stringify(value),
  });
test("complete intent and native owner tuple are closed before effects", () => {
  expect(centralHostApprovalInputSchema.parse(input)).toEqual(input);
  expect(() =>
    centralHostApprovalInputSchema.parse({
      ...input,
      plan: {
        ...plan,
        environment: [{ key: "INTEGRATIONS_DATABASE_URL", sha256: "9".repeat(64) }],
      },
    }),
  ).toThrow();
  expect(() =>
    centralHostTransportRequestSchema.parse({ ...body, adapterSessionId: "foreign" }),
  ).toThrow();
  expect(() =>
    centralHostTransportRequestSchema.parse({
      ...body,
      input: {
        ...input,
        plan: { ...plan, selection: { ...plan.selection, sessionId: "foreign" } },
      },
    }),
  ).toThrow();
});
test("workload verification precedes owner, journal, and JSON interpretation", async () => {
  const assertCanonicalAppOwner = vi.fn();
  const createPorts = vi.fn(() => Promise.reject(new Error("must not execute")));
  const dispatch = createCentralHostDispatcher({
    owner: {
      verifyWorkload: () => Promise.reject(new Error("private credential")),
      assertCanonicalAppOwner,
    },
    createPorts,
  });
  const response = await dispatch(request());
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ code: "central_host_unavailable" });
  expect(assertCanonicalAppOwner).not.toHaveBeenCalled();
  expect(createPorts).not.toHaveBeenCalled();
});
test("real missing profile is actionable and no synthetic ports are substituted", async () => {
  const assertCanonicalAppOwner = vi.fn(() => Promise.resolve());
  const dispatch = createCentralHostDispatcher({
    owner: { verifyWorkload: () => Promise.resolve(), assertCanonicalAppOwner },
    createPorts: () =>
      Promise.reject(new CentralHostPrerequisiteError("central_host_profile_required")),
  });
  const response = await dispatch(
    request({
      ...body,
      action: "central-integration-host-plan",
      input: { kind: "setup", appId: plan.selection.initiatingAppId },
    }),
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    status: "blocked",
    code: "central_host_profile_required",
  });
  expect(assertCanonicalAppOwner).toHaveBeenCalledOnce();
});

test("ordinary approval explains exact effect destination and rejects a changed digest", () => {
  const description = publicApprovalDescription(input, "prepare-app-central-integrations");
  expect(description).toContain(plan.target.projectId);
  expect(description).toContain(plan.source.operationBranch);
  expect(description).toContain(plan.control.resource.database);
  expect(description).toContain("register-deployment-receiver");
  expect(
    publicApprovalDescription(
      { ...input, planDigest: "0".repeat(64) },
      "prepare-app-central-integrations",
    ),
  ).toBeUndefined();
});
