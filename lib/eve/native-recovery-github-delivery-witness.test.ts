import { describe, expect, it, vi } from "vitest";
import { APP_BUILDER_WORKFLOW_STATE_KEY } from "../agent/workflow-state";
import { createGitHubPrEffectReceipt } from "../repository/github-pr-effect-journal";
import {
  verifySettledGitHubDelivery,
  verifySettledGitHubDeliveryWithPriorReceipt,
} from "./native-recovery-github-delivery-witness";
import type { PriorMergeReceiptReader } from "./native-recovery-github-delivery-witness";
import {
  approval,
  callKey,
  createCancelledDeliveryWitnessFixture as fixture,
  directKey,
  mergeSha,
  owner,
  priorDigest,
} from "./native-recovery-github-delivery-witness.test-fixture";

describe("verifySettledGitHubDelivery", () => {
  it("accepts the exact stopped reviewed call and completed schema update as historical evidence", () => {
    const { witness } = fixture();
    expect(verifySettledGitHubDelivery(witness, owner)).toBe(true);
  });

  it("requires the exact reviewed call coordinates and input", () => {
    const { witness } = fixture();
    expect(
      verifySettledGitHubDelivery({ ...witness, toolName: "observe-app-production" }, owner),
    ).toBe(false);
    expect(verifySettledGitHubDelivery({ ...witness, callId: "different-call" }, owner)).toBe(
      false,
    );
    expect(verifySettledGitHubDelivery({ ...witness, turnSequence: 10 }, owner)).toBe(false);
    expect(
      verifySettledGitHubDelivery(
        { ...witness, toolInput: { ...approval, headSha: mergeSha } },
        owner,
      ),
    ).toBe(false);
  });

  it("refuses another tenant, physical adapter, generation or future cancellation fence", () => {
    const { witness } = fixture();
    expect(verifySettledGitHubDelivery(witness, { ...owner, ownerUserId: "other-owner" })).toBe(
      false,
    );
    expect(
      verifySettledGitHubDelivery(witness, { ...owner, sourceOwnerRunId: "other-owner-run" }),
    ).toBe(false);
    expect(verifySettledGitHubDelivery(witness, { ...owner, sourceAdapterGeneration: 3 })).toBe(
      false,
    );
    expect(verifySettledGitHubDelivery(witness, { ...owner, parentCancellationRevision: 0 })).toBe(
      false,
    );
  });

  it("requires a unique captured call and the same accepted review and direct grant", () => {
    const { witness, capturedCall, context, priorGrant } = fixture();
    expect(
      verifySettledGitHubDelivery(
        {
          ...witness,
          serializedContext: { ...context, [callKey]: [capturedCall, capturedCall] },
        },
        owner,
      ),
    ).toBe(false);
    expect(
      verifySettledGitHubDelivery(
        {
          ...witness,
          serializedContext: {
            ...context,
            [APP_BUILDER_WORKFLOW_STATE_KEY]: {
              ...context[APP_BUILDER_WORKFLOW_STATE_KEY],
              reviewReceipt: { digest: priorDigest },
            },
          },
        },
        owner,
      ),
    ).toBe(false);
    expect(
      verifySettledGitHubDelivery(
        {
          ...witness,
          serializedContext: { ...context, [directKey]: { grant: priorGrant } },
        },
        owner,
      ),
    ).toBe(false);
  });

  it("requires the original revision anchor and successful schema activation evidence", () => {
    const { witness, context, grant } = fixture();
    expect(
      verifySettledGitHubDelivery(
        {
          ...witness,
          serializedContext: { ...context, [directKey]: { grant } },
        },
        owner,
      ),
    ).toBe(false);
    expect(
      verifySettledGitHubDelivery(
        {
          ...witness,
          completedSteps: [witness.completedSteps[0]],
        },
        owner,
      ),
    ).toBe(false);
  });
});

describe("verifySettledGitHubDeliveryWithPriorReceipt", () => {
  it("accepts an exact completed earlier merge for a stopped repeat of the same delivery", async () => {
    const { witness, priorMergeReceipt } = fixture({ priorMerge: true });
    const readReceipt = vi.fn(async () => await Promise.resolve(priorMergeReceipt));
    expect(verifySettledGitHubDelivery(witness, owner)).toBe(false);
    await expect(
      verifySettledGitHubDeliveryWithPriorReceipt(witness, owner, readReceipt),
    ).resolves.toBe(true);
    expect(readReceipt).toHaveBeenCalledExactlyOnceWith(priorMergeReceipt.intentDigest);
  });

  it("does not trust an earlier live result when its original Ready receipt is unavailable", async () => {
    const { witness, priorMergeReceipt } = fixture({ priorMerge: true });
    const unrelatedReceipt = createGitHubPrEffectReceipt({
      status: "succeeded",
      approvedByCallId: priorMergeReceipt.approvedByCallId,
      intent: { ...priorMergeReceipt.intent, pullRequestNumber: 43 },
      evidence: priorMergeReceipt.evidence,
    });
    const journal = new Map([[unrelatedReceipt.intentDigest, unrelatedReceipt]]);
    const readReceipt = vi.fn<PriorMergeReceiptReader>(
      async (digest) => await Promise.resolve(journal.get(digest)),
    );

    await expect(
      verifySettledGitHubDeliveryWithPriorReceipt(witness, owner, readReceipt),
    ).resolves.toBe(false);
    expect(readReceipt).toHaveBeenCalledTimes(1);
  });

  it("rejects a canonical receipt for a different delivery call or Ready cycle", async () => {
    const { witness, priorMergeReceipt } = fixture({ priorMerge: true });
    const changedCall = createGitHubPrEffectReceipt({
      status: "succeeded",
      approvedByCallId: witness.callId,
      intent: priorMergeReceipt.intent,
      evidence: priorMergeReceipt.evidence,
    });
    const changedReadyCycle = createGitHubPrEffectReceipt({
      status: "succeeded",
      approvedByCallId: priorMergeReceipt.approvedByCallId,
      intent: { ...priorMergeReceipt.intent, readyAt: "2026-11-13T09:05:00Z" },
      evidence: priorMergeReceipt.evidence,
    });
    await Promise.all(
      [changedCall, changedReadyCycle].map(async (receipt) => {
        await expect(
          verifySettledGitHubDeliveryWithPriorReceipt(
            witness,
            owner,
            async () => await Promise.resolve(receipt),
          ),
        ).resolves.toBe(false);
      }),
    );
  });

  it("checks the earlier call and live result before reading the merge journal", async () => {
    const {
      witness,
      context,
      capturedCall,
      priorCapturedCall,
      priorMergeReceipt,
      committedDelivery,
    } = fixture({
      priorMerge: true,
    });
    const readReceipt = vi.fn(async () => await Promise.resolve(priorMergeReceipt));
    const missingEarlierTurn = {
      ...witness,
      serializedContext: {
        ...context,
        [callKey]: [
          { ...priorCapturedCall, turnSequence: capturedCall.turnSequence },
          capturedCall,
        ],
      },
    };
    const missingEarlierFence = {
      ...witness,
      serializedContext: {
        ...context,
        [callKey]: [{ ...priorCapturedCall, owner: capturedCall.owner }, capturedCall],
      },
    };
    const invalidCommitted = [
      missingEarlierTurn,
      missingEarlierFence,
      {
        ...witness,
        readCommittedDelivery: () => ({
          ...committedDelivery,
          toolInput: { ...committedDelivery.toolInput, headSha: mergeSha },
        }),
      },
      {
        ...witness,
        readCommittedDelivery: () => ({
          ...committedDelivery,
          result: { ...committedDelivery.result, schemaUpdatePending: true },
        }),
      },
      {
        ...witness,
        readCommittedDelivery: () => ({
          ...committedDelivery,
          result: {
            ...committedDelivery.result,
            nativeProduction: {
              ...committedDelivery.result.nativeProduction,
              deployment: { state: "active", requestedRevisionActive: true },
            },
          },
        }),
      },
    ];
    await Promise.all(
      invalidCommitted.map(async (candidate) => {
        await expect(
          verifySettledGitHubDeliveryWithPriorReceipt(candidate, owner, readReceipt),
        ).resolves.toBe(false);
      }),
    );
    expect(readReceipt).not.toHaveBeenCalled();
  });
});
