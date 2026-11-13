import { describe, expect, it } from "vitest";
import { createDirectProductionGrant } from "../agent/direct-production-authorization";
import { githubPrDeliveryInputDigest } from "../agent/github-pr-delivery-authority-state";
import { APP_BUILDER_WORKFLOW_STATE_KEY } from "../agent/workflow-state";
import type { RepositoryProductionSchemaActivation } from "../provisioning/repository-production-delivery";
import type { RepositoryProductionNativeStatus } from "../provisioning/repository-production-native-status-contract";
import { tenantKeyFor } from "./hosted-auth";
import { verifySettledGitHubDelivery } from "./native-recovery-github-delivery-witness";
import type {
  CancelledGitHubDeliveryOwner,
  CancelledGitHubDeliveryWitness,
} from "./native-recovery-github-delivery-witness";

const callKey = "autograph-app-builder.github-pr-delivery-call-scopes.v1";
const directKey = "autograph-app-builder.direct-production-authorization.v1";
const appId = "fixture-label-log";
const logicalSessionId = "logical-fixture-session";
const callId = "github-delivery-call";
const turnId = "stopped-delivery-turn";
const toolName = "finish-github-pr-delivery";
const candidateDigest = "a".repeat(64);
const priorDigest = "b".repeat(64);
const mergeSha = "c".repeat(40);
const appSpecDigest = "d".repeat(64);
const reviewedHeadSha = "e".repeat(40);
const publicationDigest = "f".repeat(64);
const reviewDigest = "1".repeat(64);
const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "fixture-tenant",
  ownerUserId: "fixture-owner",
};
const owner: CancelledGitHubDeliveryOwner = {
  ...authority,
  scopes: ["autograph:start"],
  sourceOwnerRunId: "source-owner-run",
  sourceAdapterGeneration: 2,
  parentCancellationRevision: 3,
};
const approval = {
  repositoryId: "100",
  owner: "withAutograph",
  name: "arrusted-development",
  installationId: "200",
  baseBranch: "main",
  headSha: reviewedHeadSha,
  proposalDigest: publicationDigest,
  pullRequestNumber: 42,
};
const destination = {
  repositoryId: approval.repositoryId,
  repositoryFullName: "withAutograph/arrusted-development",
} as const;
const priorGrant = createDirectProductionGrant({
  callId: "prior-build-call",
  toolName: "apply_app_creation",
  subject: {
    ...destination,
    version: 1,
    appId,
    appSpecDigest: "2".repeat(64),
    proposalDigest: priorDigest,
    sessionId: logicalSessionId,
    buildWorkspaceId: "retained-build-workspace",
    authority,
    installationId: approval.installationId,
    baseBranch: approval.baseBranch,
    storageKind: "postgres",
  },
});
const grant = createDirectProductionGrant({
  callId: "current-build-call",
  toolName: "apply_app_creation",
  subject: {
    ...priorGrant.subject,
    appSpecDigest,
    proposalDigest: candidateDigest,
    revision: {
      priorGrantDigest: priorGrant.digest,
      priorProposalDigest: priorGrant.subject.proposalDigest,
      schemaChange: {
        kind: "add-optional-text-field",
        priorCueSha256: "3".repeat(64),
        candidateCueSha256: "4".repeat(64),
      },
    },
  },
});
const schemaActivation = { deliveryCallId: callId, mergeIntentDigest: "5".repeat(64) };
interface MergedDeliveryStep {
  status: "merged";
  mergeCommitSha: string;
  nativeProductionTarget: { appId: string; repositoryId: string; repositoryFullName: string };
  schemaActivation: Omit<RepositoryProductionSchemaActivation, "mergeSha" | "reviewedHeadSha">;
}
const completedStep = (
  name: string,
  output: MergedDeliveryStep | RepositoryProductionNativeStatus,
  argument?: RepositoryProductionSchemaActivation,
) => ({
  name,
  args: [
    {
      args: argument === undefined ? [approval, null] : [approval, null, argument],
      context: { callId, toolName, session: { id: logicalSessionId } },
      contextIndexes: [1],
    },
  ],
  output: { kind: "result", output, authorized: [] },
});

const fixture = () => {
  const capturedCall = {
    owner: {
      ownerKey: tenantKeyFor(owner),
      adapterSessionId: owner.sourceOwnerRunId,
      adapterGeneration: owner.sourceAdapterGeneration,
      cancellationRevision: 1,
    },
    callId,
    turnId,
    turnSequence: 9,
    cancelled: true as const,
    inputDigest: githubPrDeliveryInputDigest(approval),
    directProductionGrantDigest: grant.digest,
    subject: {
      appId,
      appSpecDigest,
      reviewDigest,
      proposalDigest: publicationDigest,
      installationId: approval.installationId,
    },
    requirements: [],
  };
  const context = {
    "eve.sessionId": logicalSessionId,
    [APP_BUILDER_WORKFLOW_STATE_KEY]: {
      phase: "reviewed",
      appSpec: { appId, digest: appSpecDigest },
      proposal: { digest: candidateDigest },
      workspace: { workspaceId: grant.subject.buildWorkspaceId },
      reviewReceipt: { digest: reviewDigest },
      githubDraftProposal: { proposal: { digest: publicationDigest, reviewDigest } },
      publishedGitHubDraftProposalDigest: publicationDigest,
    },
    [callKey]: [capturedCall],
    [directKey]: { grant, revisionAnchor: { proposalDigest: candidateDigest, priorGrant } },
  };
  const witness = {
    toolName,
    callId,
    turnId,
    turnSequence: capturedCall.turnSequence,
    logicalSessionId,
    checkpointOwnerRunId: "proved-native-handoff-leaf",
    toolInput: approval,
    serializedContext: context,
    completedSteps: [
      completedStep("continueGitHubPrDelivery", {
        status: "merged",
        mergeCommitSha: mergeSha,
        nativeProductionTarget: { ...destination, appId },
        schemaActivation,
      }),
      completedStep(
        "continueGitHubProductionSchema",
        {
          version: 1,
          appId,
          observedAt: "2026-11-13T10:00:00Z",
          status: "available",
          destination,
          deployment: { state: "active" },
          app: { state: "sign-in-required", url: "https://apps.example/fixture-label-log" },
          requestedRevision: "live",
        },
        { ...schemaActivation, mergeSha, reviewedHeadSha },
      ),
    ],
  } satisfies CancelledGitHubDeliveryWitness;
  return { capturedCall, context, witness };
};

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
    const { witness, capturedCall, context } = fixture();
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
    const { witness, context } = fixture();
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
