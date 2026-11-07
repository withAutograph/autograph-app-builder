import { createHmac, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { plan } from "./central-integration-host-test-fixture";
import {
  verifyCentralNativeDeploymentReceipt,
  retainCentralNativeDeploymentReceipt,
} from "./central-integration-deployment-receipt";

const secret = randomUUID();
const envelope = {
  id: "delivery-one",
  payload: {
    deployment: {
      id: "dpl_native_one",
      meta: {
        extra: "raw provider metadata must not be retained",
        githubCommitRef: plan.source.operationBranch,
        githubCommitSha: plan.source.reviewedSourceSha,
      },
      url: "native-immutable.vercel.app",
    },
    project: { id: plan.target.projectId },
    target: null,
    team: { id: plan.target.teamId },
  },
  type: "deployment.created",
};
const signed = (event = envelope) => {
  const raw = Buffer.from(JSON.stringify(event));
  return { plan, raw, secret, signature: createHmac("sha1", secret).update(raw).digest("hex") };
};
it("admits only actual signed exact-operation native identity and retains bounded provider facts", () => {
  const receipt = verifyCentralNativeDeploymentReceipt(signed());
  expect(receipt).toMatchObject({
    immutableOrigin: "https://native-immutable.vercel.app",
    providerDeploymentId: "dpl_native_one",
  });
  expect(JSON.stringify(receipt)).not.toContain("raw provider");
  expect(JSON.stringify(receipt)).not.toContain(secret);
  expect(() =>
    verifyCentralNativeDeploymentReceipt({ ...signed(), signature: "0".repeat(40) }),
  ).toThrow("central_deployment_receipt_rejected");
});
it("ignores other branches and projects without adopting their deployment", () => {
  expect(
    verifyCentralNativeDeploymentReceipt(
      signed({
        ...envelope,
        payload: {
          ...envelope.payload,
          deployment: {
            ...envelope.payload.deployment,
            meta: { ...envelope.payload.deployment.meta, githubCommitRef: "other-branch" },
          },
        },
      }),
    ),
  ).toBeUndefined();
  expect(
    verifyCentralNativeDeploymentReceipt(
      signed({ ...envelope, payload: { ...envelope.payload, project: { id: "other-project" } } }),
    ),
  ).toBeUndefined();
});
it("preserves idempotent out-of-order ready/created receipts without treating READY as acceptance", () => {
  const created = verifyCentralNativeDeploymentReceipt(signed());
  if (!created) {
    throw new Error("fixture receipt required");
  }
  const ready = { ...created, eventId: "delivery-ready", eventType: "deployment.ready" as const };
  const first = retainCentralNativeDeploymentReceipt({ status: "empty" }, ready);
  const both = retainCentralNativeDeploymentReceipt(first, created);
  expect(both.status).toBe("accepted");
  expect(retainCentralNativeDeploymentReceipt(both, created)).toEqual(both);
  expect(
    retainCentralNativeDeploymentReceipt(both, { ...ready, eventId: "new-delivery-id" }),
  ).toEqual(both);
});
it("retains conflicting native IDs or changed delivery bytes as a conflict rather than choosing a target", () => {
  const receipt = verifyCentralNativeDeploymentReceipt(signed());
  if (!receipt) {
    throw new Error("fixture receipt required");
  }
  const initial = retainCentralNativeDeploymentReceipt({ status: "empty" }, receipt);
  const conflict = retainCentralNativeDeploymentReceipt(initial, {
    ...receipt,
    eventId: "other-event",
    providerDeploymentId: "dpl_second",
  });
  expect(conflict).toEqual({
    providerDeploymentIds: ["dpl_native_one", "dpl_second"],
    status: "conflict",
  });
  expect(retainCentralNativeDeploymentReceipt(conflict, receipt)).toEqual(conflict);
  expect(
    retainCentralNativeDeploymentReceipt(initial, { ...receipt, bodySha256: "0".repeat(64) })
      .status,
  ).toBe("conflict");
});
