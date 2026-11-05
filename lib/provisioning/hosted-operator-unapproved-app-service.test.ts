/* oxlint-disable eslint/require-await -- The in-memory operator ports perform no I/O. */
import { describe, expect, it, vi } from "vitest";
import { operatorPublicResultSchema } from "./hosted-operator-contract";
import { createProtectedHostedOperatorHandler } from "./hosted-operator-service";
import type { ProtectedHostedOperatorDependencies } from "./hosted-operator-service";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import { inspectUnapprovedAppSuccessor } from "./hosted-operator-unapproved-app-successor";
import { createUnapprovedParticipantPlan } from "./hosted-operator-unapproved-participant-plan";
import {
  captureFixture,
  context,
  observedAt,
  requiredFixture,
} from "./hosted-operator-unapproved-app-successor.test-support";

describe("unapproved app successor service integration", () => {
  const serviceFixture = () => {
    const { record, added } = captureFixture();
    const candidate = inspectUnapprovedAppSuccessor(
      record,
      context.target,
      added,
      Date.parse(observedAt),
    );
    if (!candidate) {
      throw new Error("missing candidate");
    }
    const next = createUnapprovedParticipantPlan(candidate, added);
    let row = { record: structuredClone(record), revision: 1 };
    let deniedCall: string | undefined;
    let raceOnNextCas = false;
    const readApproval = vi.fn(
      async (input: { action: "prepare" | "cleanup"; callId: string; planDigest: string }) => {
        if (input.callId === deniedCall) {
          return null;
        }
        let id: string | undefined;
        if (input.callId === candidate.account.accountApprovedByCallId) {
          id = candidate.account.accountApprovalId;
        } else if (input.callId === candidate.bootstrap.auth.approvedByCallId) {
          id = candidate.bootstrap.auth.approvalId;
        }
        return id === undefined
          ? null
          : {
              approved: true,
              action: input.action,
              callId: input.callId,
              planDigest: input.planDigest,
              approvalId: id,
            };
      },
    );
    const executeEffect = vi.fn();
    const deps: ProtectedHostedOperatorDependencies = {
      authorize: async () => context,
      assertAuthorized: vi.fn(async () => {}),
      plan: vi.fn(async () => next),
      readApproval,
      executeEffect,
      reconcile: vi.fn(async () => ({ status: "unknown" as const })),
      verify: vi.fn(),
      bindings: vi.fn(),
      withResourceLease: vi.fn(),
      now: () => Date.parse(observedAt),
      store: {
        read: async () => structuredClone(row),
        reserve: async () => structuredClone(row),
        reserveFenceGeneration: vi.fn(),
        compareAndSet: async (input: { expectedRevision: number; record: typeof record }) => {
          if (raceOnNextCas) {
            raceOnNextCas = false;
            requiredFixture(row.record.operator).pendingEffectId = "auth-schema";
            row.revision += 1;
          }
          if (input.expectedRevision !== row.revision) {
            // CAS failure explicitly returns no row.
            // oxlint-disable-next-line unicorn/no-useless-undefined
            return undefined;
          }
          row = {
            record: hostedRuntimeJournalRecordSchema.parse(input.record),
            revision: row.revision + 1,
          };
          return structuredClone(row);
        },
      },
    };
    const handler = createProtectedHostedOperatorHandler(deps);
    const request = async () => {
      const response = await handler(
        new Request("https://operator.example/v1/runtime", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "plan",
            operation: "prepare",
            selection: requiredFixture(record.operator).plan.selection,
            normalActorProgram: added,
          }),
        }),
      );
      return operatorPublicResultSchema.parse(await response.json());
    };
    return {
      request,
      readApproval,
      executeEffect,
      before: record,
      next,
      deny(callId: string) {
        deniedCall = callId;
      },
      race() {
        raceOnNextCas = true;
      },
      get row() {
        return row;
      },
    };
  };

  it("archives the unapproved proposal and inherited receipts, checks original approvals, and proposes only new participants", async () => {
    const f = serviceFixture();
    const result = await f.request();
    expect(result.status).toBe("planned");
    const proposed = requiredFixture(result.plan);
    expect(proposed.stage).toBe("auth-participants");
    expect(proposed.effects.map((effect: { kind: string }) => effect.kind)).toEqual([
      "normal-accounts",
    ]);
    expect(
      requiredFixture(proposed.normalActorCapturePredecessor).preparation.accountApprovalId,
    ).toBe("account-approval");
    expect(f.row.record.unapprovedAppProposalHistory?.[0]?.operator).toEqual(f.before.operator);
    expect(f.row.record.unapprovedAppProposalHistory?.[0]?.operator.receipts).toHaveLength(3);
    expect(f.row.record.accountPreparation).toEqual(f.before.accountPreparation);
    expect(f.row.record.privateState).toEqual(f.before.privateState);
    expect(f.readApproval.mock.calls.some(([input]) => input.callId === "account-call")).toBe(true);
    expect(
      f.readApproval.mock.calls.some(([input]) => input.callId === "ordinary-public-approval"),
    ).toBe(true);
    expect(f.executeEffect).not.toHaveBeenCalled();
    const retry = await f.request();
    expect(retry.status).toBe("planned");
    expect(retry.operationRef).toBe(result.operationRef);
    expect(f.executeEffect).not.toHaveBeenCalled();
  });
  it.each(["account-call", "ordinary-public-approval"])(
    "requires the real prior %s approval",
    async (callId) => {
      const f = serviceFixture();
      f.deny(callId);
      const before = structuredClone(f.row);
      const result = await f.request();
      expect(result.status).toBe("blocked");
      expect(result.code).toBe("authorization_required");
      expect(f.row).toEqual(before);
      expect(f.executeEffect).not.toHaveBeenCalled();
    },
  );
  it.each([
    { expiration: "2026-10-13T00:00:00Z", expected: "planned" },
    { expiration: "2026-10-15T00:00:00Z", expected: "blocked" },
  ])("handles lease expiry $expiration without effects", async ({ expiration, expected }) => {
    const f = serviceFixture();
    f.row.record.leaseId = "00000000-0000-4000-8000-000000000009";
    f.row.record.leaseExpiresAt = expiration;
    const result = await f.request();
    expect(result).toMatchObject({ status: expected });
    if (expected === "planned") {
      expect(f.row.record.leaseId).toBeUndefined();
      expect(f.row.record.unapprovedAppProposalHistory?.[0]?.operator.receipts).toHaveLength(3);
    } else {
      expect(f.row.record.leaseExpiresAt).toBe(expiration);
      expect(f.row.record.unapprovedAppProposalHistory).toBeUndefined();
    }
    expect(f.executeEffect).not.toHaveBeenCalled();
  });
  it("does not supersede a concurrent pending effect after a CAS race", async () => {
    const f = serviceFixture();
    f.race();
    const result = await f.request();
    expect(result.status).toBe("blocked");
    expect(requiredFixture(f.row.record.operator).pendingEffectId).toBe("auth-schema");
    expect(f.row.record.unapprovedAppProposalHistory).toBeUndefined();
    expect(f.executeEffect).not.toHaveBeenCalled();
  });
});
