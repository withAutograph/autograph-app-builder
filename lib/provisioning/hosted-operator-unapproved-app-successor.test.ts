import { describe, expect, it } from "vitest";
import {
  hostedOperatorPlanSchema,
  normalActorPreparationSchema,
  operatorPlanDigest,
} from "./hosted-operator-contract";
import { inspectUnapprovedAppSuccessor } from "./hosted-operator-unapproved-app-successor";
import { readUnapprovedCapturePredecessor } from "./hosted-operator-unapproved-capture-history";
import {
  captureFixture,
  context,
  observedAt,
  requiredFixture,
} from "./hosted-operator-unapproved-app-successor.test-support";

const operationRef = "00000000-0000-4000-8000-000000000001";

describe("unapproved app successor eligibility", () => {
  it("retains real prior account and bootstrap authority with no old app approval", () => {
    const { record, added } = captureFixture();
    const before = structuredClone(record);
    const result = inspectUnapprovedAppSuccessor(
      record,
      context.target,
      added,
      Date.parse(observedAt),
    );
    expect(result?.account.accountApprovalId).toBe("account-approval");
    expect(result?.bootstrap.auth.approvalId).toBe("actual-approval");
    expect(result?.priorOperator.approvalId).toBeUndefined();
    expect(result?.priorOperator.receipts).toHaveLength(3);
    expect(record).toEqual(before);
  });
  it("treats expired leases as idle but rejects a lease with unknown expiry", () => {
    const { record, added } = captureFixture();
    record.leaseId = "00000000-0000-4000-8000-000000000009";
    record.leaseExpiresAt = "2026-10-13T00:00:00Z";
    expect(
      inspectUnapprovedAppSuccessor(record, context.target, added, Date.parse(observedAt)),
    ).toBeDefined();
    delete record.leaseExpiresAt;
    expect(
      inspectUnapprovedAppSuccessor(record, context.target, added, Date.parse(observedAt)),
    ).toBeUndefined();
  });
  it.each([
    "lease",
    "pending-effect",
    "running",
    "approved",
    "tampered-plan",
    "different-db",
    "not-additive",
    "missing-bootstrap",
    "tampered-receipt",
  ])("rejects %s", (change) => {
    const { record, added } = captureFixture();
    const operator = requiredFixture(record.operator);
    if (change === "lease") {
      record.leaseId = "00000000-0000-4000-8000-000000000009";
      record.leaseExpiresAt = "2030-01-01T00:00:00Z";
    }
    if (change === "pending-effect") {
      operator.pendingEffectId = "auth-schema";
    }
    if (change === "running") {
      record.executionObservation = {
        state: "running",
        attemptRef: "00000000-0000-4000-8000-000000000010",
        operationRef,
        planDigest: operator.planDigest,
        callId: "call",
        approvalId: "approval",
      };
    }
    if (change === "approved") {
      operator.approvalId = "approval";
    }
    if (change === "tampered-plan") {
      operator.planDigest = "a".repeat(64);
    }
    if (change === "different-db") {
      requiredFixture(record.accountPreparation).accountPlan.appDatabase.database = "other";
    }
    if (change === "missing-bootstrap") {
      delete record.retainedAuth;
    }
    if (change === "tampered-receipt") {
      operator.receipts[0].resourceVersion = "wrong";
    }
    const requested =
      change === "not-additive" ? requiredFixture(operator.plan.normalActorProgram) : added;
    expect(
      inspectUnapprovedAppSuccessor(record, context.target, requested, Date.parse(observedAt)),
    ).toBeUndefined();
  });
  it("resolves only the archived exact account and bootstrap authority", () => {
    const { record, added } = captureFixture();
    const before = inspectUnapprovedAppSuccessor(
      record,
      context.target,
      added,
      Date.parse(observedAt),
    );
    if (before === undefined) {
      throw new Error("missing candidate");
    }
    record.unapprovedAppProposalHistory = [
      {
        approvedByCallId: "operator:unapproved-plan",
        operator: before.priorOperator,
        preparation: before.account,
        retainedAuth: before.bootstrap.auth,
        retainedParticipantGateway: record.retainedParticipantGateway,
      },
    ];
    const auth = before.bootstrap.auth;
    const next = hostedOperatorPlanSchema.parse({
      ...before.account.accountPlan,
      normalActorProgram: added,
      normalActorCapturePredecessor: {
        preparation: normalActorPreparationSchema.strip().parse(before.account),
        bootstrapOperationRef: auth.operationRef,
        bootstrapPlanDigest: auth.planDigest,
        bootstrapApprovalId: auth.approvalId,
        bootstrapApprovedByCallId: auth.approvedByCallId,
      },
    });
    expect(
      readUnapprovedCapturePredecessor(record, next, Date.parse(observedAt))?.account
        .accountApprovalId,
    ).toBe("account-approval");
    requiredFixture(next.normalActorCapturePredecessor).bootstrapApprovalId = "different-approval";
    expect(readUnapprovedCapturePredecessor(record, next, Date.parse(observedAt))).toBeUndefined();
  });

  it("rechecks a separately approved retained Gateway and rejects its tampered pointer", () => {
    const { record, added } = captureFixture();
    const operator = requiredFixture(record.operator);
    const original = requiredFixture(record.retainedAuth);
    const completion = structuredClone(original);
    completion.operationRef = "00000000-0000-4000-8000-000000000004";
    completion.approvalId = "gateway-approval";
    completion.approvedByCallId = "gateway-call";
    completion.plan = operator.plan;
    completion.planDigest = operatorPlanDigest(completion.plan);
    completion.fenceGeneration = 1;
    completion.receipts = completion.plan.effects.map((effect) => ({
      effectId: effect.id,
      observedAt,
      resourceVersion: "actual-readback",
      ...(effect.kind === "access" ? { fenceGeneration: 1 } : {}),
    }));
    const candidate = {
      ...requiredFixture(operator.gatewayDeliveryCandidates?.[0]),
      operationRef: completion.operationRef,
      deploymentId: "separate-gateway",
    };
    requiredFixture(operator.gatewayDeliveryCandidates).push(candidate);
    operator.deliveredGatewayDeploymentId = candidate.deploymentId;
    record.retainedParticipantGateway = { completion, candidate };
    const found = inspectUnapprovedAppSuccessor(
      record,
      context.target,
      added,
      Date.parse(observedAt),
    );
    expect(found?.bootstrap.gateway?.approvalId).toBe("gateway-approval");
    if (found === undefined || found.bootstrap.gateway === undefined) {
      throw new Error("missing gateway authority");
    }
    record.unapprovedAppProposalHistory = [
      {
        approvedByCallId: "operator:unapproved-plan",
        operator,
        preparation: found.account,
        retainedAuth: found.bootstrap.auth,
        retainedParticipantGateway: record.retainedParticipantGateway,
      },
    ];
    const auth = found.bootstrap.auth;
    const gateway = found.bootstrap.gateway;
    const next = hostedOperatorPlanSchema.parse({
      ...found.account.accountPlan,
      normalActorProgram: added,
      normalActorCapturePredecessor: {
        preparation: normalActorPreparationSchema.strip().parse(found.account),
        bootstrapOperationRef: auth.operationRef,
        bootstrapPlanDigest: auth.planDigest,
        bootstrapApprovalId: auth.approvalId,
        bootstrapApprovedByCallId: auth.approvedByCallId,
        gateway: {
          operationRef: gateway.operationRef,
          planDigest: gateway.planDigest,
          approvalId: gateway.approvalId,
          approvedByCallId: gateway.approvedByCallId,
        },
      },
    });
    expect(
      readUnapprovedCapturePredecessor(record, next, Date.parse(observedAt))?.bootstrap.gateway
        ?.approvalId,
    ).toBe("gateway-approval");
    requiredFixture(requiredFixture(next.normalActorCapturePredecessor).gateway).approvalId =
      "wrong";
    expect(readUnapprovedCapturePredecessor(record, next, Date.parse(observedAt))).toBeUndefined();
  });
});
