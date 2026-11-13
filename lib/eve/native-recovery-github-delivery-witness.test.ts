import { describe, expect, it } from "vitest";
import { APP_BUILDER_WORKFLOW_STATE_KEY } from "../agent/workflow-state";
import { verifySettledGitHubDelivery } from "./native-recovery-github-delivery-witness";
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
