import { createDirectProductionGrant } from "../agent/direct-production-authorization";
import { githubPrDeliveryInputDigest } from "../agent/github-pr-delivery-authority-state";
import type { GitHubPrDeliveryApproval } from "../agent/github-pr-delivery-approval";
import { APP_BUILDER_WORKFLOW_STATE_KEY } from "../agent/workflow-state";
import type { RepositoryProductionSchemaActivation } from "../provisioning/repository-production-delivery";
import type { RepositoryProductionNativeStatus } from "../provisioning/repository-production-native-status-contract";
import { tenantKeyFor } from "./hosted-auth";
import type {
  CancelledGitHubDeliveryOwner,
  CancelledGitHubDeliveryWitness,
} from "./native-recovery-github-delivery-witness";

export const callKey = "autograph-app-builder.github-pr-delivery-call-scopes.v1";
export const directKey = "autograph-app-builder.direct-production-authorization.v1";
const appId = "fixture-label-log";
const logicalSessionId = "logical-fixture-session";
const callId = "github-delivery-call";
const turnId = "stopped-delivery-turn";
const toolName = "finish-github-pr-delivery";
const candidateDigest = "a".repeat(64);
export const priorDigest = "b".repeat(64);
export const mergeSha = "c".repeat(40);
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
export const owner: CancelledGitHubDeliveryOwner = {
  ...authority,
  scopes: ["autograph:start"],
  sourceOwnerRunId: "source-owner-run",
  sourceAdapterGeneration: 2,
  parentCancellationRevision: 3,
};
export const approval = {
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
interface MergedDeliveryStep {
  status: "merged";
  mergeCommitSha: string;
  nativeProductionTarget: { appId: string; repositoryId: string; repositoryFullName: string };
  schemaActivation: Omit<RepositoryProductionSchemaActivation, "mergeSha" | "reviewedHeadSha">;
}
export const createCancelledDeliveryWitnessFixture = (
  options: {
    callId?: string;
    turnId?: string;
    turnSequence?: number;
    logicalSessionId?: string;
    checkpointOwnerRunId?: string;
    sourceOwnerRunId?: string;
    toolInput?: GitHubPrDeliveryApproval;
  } = {},
) => {
  const fixtureOwner = {
    ...owner,
    sourceOwnerRunId: options.sourceOwnerRunId ?? owner.sourceOwnerRunId,
  };
  const fixtureApproval = options.toolInput ?? approval;
  const { installationId } = fixtureApproval;
  if (installationId === undefined) {
    throw new Error("A retained delivery fixture requires a connected repository.");
  }
  const fixtureCallId = options.callId ?? callId;
  const fixtureTurnId = options.turnId ?? turnId;
  const fixtureSessionId = options.logicalSessionId ?? logicalSessionId;
  const fixtureDestination = {
    repositoryId: fixtureApproval.repositoryId,
    repositoryFullName: destination.repositoryFullName,
  };
  const priorGrant = createDirectProductionGrant({
    callId: "prior-build-call",
    toolName: "apply_app_creation",
    subject: {
      ...fixtureDestination,
      version: 1,
      appId,
      appSpecDigest: "2".repeat(64),
      proposalDigest: priorDigest,
      sessionId: fixtureSessionId,
      buildWorkspaceId: "retained-build-workspace",
      authority,
      installationId,
      baseBranch: fixtureApproval.baseBranch,
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
  const schemaActivation = { deliveryCallId: fixtureCallId, mergeIntentDigest: "5".repeat(64) };
  const completedStep = (
    name: string,
    output: MergedDeliveryStep | RepositoryProductionNativeStatus,
    argument?: RepositoryProductionSchemaActivation,
  ) => ({
    name,
    args: [
      {
        args: argument === undefined ? [fixtureApproval, null] : [fixtureApproval, null, argument],
        context: {
          callId: fixtureCallId,
          toolName,
          session: {
            id: fixtureSessionId,
            ownerRunId: options.checkpointOwnerRunId ?? "proved-native-handoff-leaf",
            ownerAnchorRunId: fixtureSessionId,
            turn: { id: fixtureTurnId, sequence: options.turnSequence ?? 9 },
          },
        },
        contextIndexes: [1],
      },
    ],
    output: { kind: "result", output, authorized: [] },
  });

  const capturedCall = {
    owner: {
      ownerKey: tenantKeyFor(fixtureOwner),
      adapterSessionId: fixtureOwner.sourceOwnerRunId,
      adapterGeneration: fixtureOwner.sourceAdapterGeneration,
      cancellationRevision: 1,
    },
    callId: fixtureCallId,
    turnId: fixtureTurnId,
    turnSequence: options.turnSequence ?? 9,
    cancelled: true as const,
    inputDigest: githubPrDeliveryInputDigest(fixtureApproval),
    directProductionGrantDigest: grant.digest,
    subject: {
      appId,
      appSpecDigest,
      reviewDigest,
      proposalDigest: fixtureApproval.proposalDigest,
      installationId,
    },
    requirements: [],
  };
  const context = {
    "eve.sessionId": fixtureSessionId,
    [APP_BUILDER_WORKFLOW_STATE_KEY]: {
      phase: "reviewed",
      appSpec: { appId, digest: appSpecDigest },
      proposal: { digest: candidateDigest },
      workspace: { workspaceId: grant.subject.buildWorkspaceId },
      reviewReceipt: { digest: reviewDigest },
      githubDraftProposal: { proposal: { digest: fixtureApproval.proposalDigest, reviewDigest } },
      publishedGitHubDraftProposalDigest: fixtureApproval.proposalDigest,
    },
    [callKey]: [capturedCall],
    [directKey]: { grant, revisionAnchor: { proposalDigest: candidateDigest, priorGrant } },
  };
  const witness = {
    toolName,
    callId: fixtureCallId,
    turnId: fixtureTurnId,
    turnSequence: capturedCall.turnSequence,
    logicalSessionId: fixtureSessionId,
    checkpointOwnerRunId: options.checkpointOwnerRunId ?? "proved-native-handoff-leaf",
    toolInput: fixtureApproval,
    serializedContext: context,
    completedSteps: [
      completedStep("continueGitHubPrDelivery", {
        status: "merged",
        mergeCommitSha: mergeSha,
        nativeProductionTarget: { ...fixtureDestination, appId },
        schemaActivation,
      }),
      completedStep(
        "continueGitHubProductionSchema",
        {
          version: 1,
          appId,
          observedAt: "2026-11-13T10:00:00Z",
          status: "available",
          destination: fixtureDestination,
          deployment: { state: "active" },
          app: { state: "sign-in-required", url: "https://apps.example/fixture-label-log" },
          requestedRevision: "live",
        },
        { ...schemaActivation, mergeSha, reviewedHeadSha: fixtureApproval.headSha },
      ),
    ],
  } satisfies CancelledGitHubDeliveryWitness;
  return { capturedCall, context, witness, grant, priorGrant, owner: fixtureOwner };
};
