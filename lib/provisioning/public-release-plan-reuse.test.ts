import { describe, expect, it } from "vitest";
import { reconcilePublicReleasePlanHistory } from "./public-release-plan-reuse";
import { initialPublicReleaseRecord } from "./public-release-store";
import { publicReleaseOperationRef, publicReleasePlanSchema } from "./public-release-contract";
import { plan } from "./public-release-test-fixture";
import { removal, retained } from "./public-release-integration-removal-test-fixture";

describe("public release intent and prior row reconciliation", () => {
  it("resumes the identical frozen plan after native publication moved the production ref", () => {
    const record = initialPublicReleaseRecord(plan);
    record.effects["publish-release-source"] = "pending";
    const candidate = publicReleasePlanSchema.parse({
      ...plan,
      purpose: "application",
      source: { ...plan.source, expectedProductionSha: plan.source.sourceSha },
    });
    expect(
      reconcilePublicReleasePlanHistory({ candidate, records: [record], snapshots: [] }),
    ).toEqual(plan);
  });
  it("does not let a changed release or bootstrap purpose pass an older uncertain write", () => {
    const record = initialPublicReleaseRecord(plan);
    record.effects["publish-release-source"] = "pending";
    expect(() =>
      reconcilePublicReleasePlanHistory({
        candidate: { ...plan, purpose: "auth-bootstrap" },
        records: [record],
        snapshots: [],
      }),
    ).toThrow();
    expect(() =>
      reconcilePublicReleasePlanHistory({
        candidate: { ...plan, runtime: { ...plan.runtime, releaseId: "next" } },
        records: [record],
        snapshots: [],
      }),
    ).toThrow();
  });
  it("binds each provider-observed prior row to its exact own accepted journal receipt", () => {
    const record = initialPublicReleaseRecord(plan);
    record.bindings.APP_DATABASE_URL = { state: "applied", acceptedEnvId: "env-owned" };
    record.effects = { "bind-production-runtime": "applied", "publish-release-source": "applied" };
    const candidate = publicReleasePlanSchema.parse({
      ...plan,
      runtime: { ...plan.runtime, releaseId: "next" },
    });
    const snapshot = {
      key: "APP_DATABASE_URL",
      id: "env-owned",
      operationRef: publicReleaseOperationRef(plan),
      sha256: plan.environment[0].sha256,
    };
    const selected = reconcilePublicReleasePlanHistory({
      candidate,
      records: [record],
      snapshots: [snapshot],
    });
    expect(selected.environment[0].priorBinding).toEqual({
      id: "env-owned",
      operationRef: snapshot.operationRef,
      valueSha256: snapshot.sha256,
    });
    expect(() =>
      reconcilePublicReleasePlanHistory({
        candidate,
        records: [record],
        snapshots: [{ ...snapshot, id: "foreign" }],
      }),
    ).toThrow();
    expect(() =>
      reconcilePublicReleasePlanHistory({
        candidate,
        records: [record],
        snapshots: [{ ...snapshot, sha256: "f".repeat(64) }],
      }),
    ).toThrow();
  });
});
it("requires an ordinary reviewed source revision when runtime changes need a native build", () => {
  expect(() =>
    reconcilePublicReleasePlanHistory({
      candidate: publicReleasePlanSchema.parse({
        ...plan,
        purpose: "auth-bootstrap",
        source: { ...plan.source, expectedProductionSha: plan.source.sourceSha },
      }),
      records: [],
      snapshots: [],
    }),
  ).toThrow("Runtime configuration changed");
});
it("retains the original approved activation fence when the same intent is resumed after provider activation", () => {
  const original = publicReleasePlanSchema.parse({
    ...plan,
    purpose: "application",
    project: { ...plan.project, priorActiveDeploymentId: "prior-production" },
  });
  const record = initialPublicReleaseRecord(original);
  record.effects["publish-release-source"] = "pending";
  const candidate = publicReleasePlanSchema.parse({
    ...original,
    project: { ...original.project, priorActiveDeploymentId: "now-production" },
    source: { ...original.source, expectedProductionSha: original.source.sourceSha },
  });
  expect(
    reconcilePublicReleasePlanHistory({ candidate, records: [record], snapshots: [] }),
  ).toEqual(original);
});

it("a pending removal fence blocks a changed release before runtime or source writes", () => {
  const original = publicReleasePlanSchema.parse({
    ...plan,
    purpose: "application",
    integrationRemoval: removal,
    retainedOptionalBindings: retained,
    effects: ["fence-app-integration-authority", ...plan.effects],
  });
  const record = initialPublicReleaseRecord(original);
  record.effects["fence-app-integration-authority"] = "pending";
  expect(() =>
    reconcilePublicReleasePlanHistory({ candidate: plan, records: [record], snapshots: [] }),
  ).toThrow();
});
