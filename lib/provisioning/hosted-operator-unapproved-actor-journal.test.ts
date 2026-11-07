/* oxlint-disable eslint/require-await, unicorn/no-useless-undefined -- In-memory asynchronous ports reproduce the production CAS contract. */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createNormalActorJournal } from "./hosted-operator-normal-actor-journal";
import {
  initialNormalActorState,
  normalActorProgramDigest,
  normalActorProgramSchema,
} from "./hosted-operator-normal-actor-program";
import { encryptNormalActorState } from "./hosted-operator-normal-actor-state";
import { operatorPlanDigest } from "./hosted-operator-contract";
import { inspectUnapprovedAppSuccessor } from "./hosted-operator-unapproved-app-successor";
import { createUnapprovedParticipantPlan } from "./hosted-operator-unapproved-participant-plan";
import {
  captureFixture,
  context,
  observedAt,
  requiredFixture,
} from "./hosted-operator-unapproved-app-successor.test-support";
import type { HostedRuntimeJournalRow } from "./hosted-runtime-journal";

const now = () => Date.parse("2026-10-20T12:00:00Z");

describe("unapproved app capture continuity", () => {
  it("carries the original actor and checks both approved prerequisites", async () => {
    const { record, added: baseAdded } = captureFixture();
    const added = normalActorProgramSchema.parse({
      ...baseAdded,
      memberships: [{ actorKey: "reviewer", organizationId: "qa-org", role: "owner" }],
      organizations: [
        { name: "QA", organizationId: "qa-org", ownerActorKey: "reviewer", slug: "qa" },
      ],
    });
    const previous = requiredFixture(record.operator);
    const gateway = structuredClone(requiredFixture(record.retainedAuth));
    gateway.operationRef = "00000000-0000-4000-8000-000000000004";
    gateway.approvalId = "gateway-approval";
    gateway.approvedByCallId = "gateway-call";
    gateway.plan = previous.plan;
    gateway.planDigest = operatorPlanDigest(gateway.plan);
    gateway.fenceGeneration = 1;
    gateway.receipts = gateway.plan.effects.map((effect) => {
      const receipt = {
        effectId: effect.id,
        observedAt,
        resourceVersion: "actual-readback",
      };
      return effect.kind === "access" ? { ...receipt, fenceGeneration: 1 } : receipt;
    });
    const gatewayCandidate = {
      ...requiredFixture(previous.gatewayDeliveryCandidates?.[0]),
      deploymentId: "separate-gateway",
      operationRef: gateway.operationRef,
    };
    previous.gatewayDeliveryCandidates?.push(gatewayCandidate);
    previous.deliveredGatewayDeploymentId = gatewayCandidate.deploymentId;
    record.retainedParticipantGateway = { candidate: gatewayCandidate, completion: gateway };
    const account = requiredFixture(record.accountPreparation);
    const original = initialNormalActorState(account.program, account.accountOperationRef);
    original.actors[0] = {
      actorKey: "owner",
      session: {
        actorId: "original",
        expiresAt: "2026-10-19T12:00:00Z",
        origin: account.program.origin,
        realmSessionId: "real-session",
        reference: "22222222-2222-4222-8222-222222222222",
      },
      signup: "complete",
      storageState: { cookies: [], origins: [] },
    };
    const keyring = { tokenKey: Buffer.alloc(32, 7), tokenKeyVersion: "v1" };
    account.sealedState = encryptNormalActorState({
      authority: context.authority,
      config: keyring,
      operationRef: account.accountOperationRef,
      ownerSessionId: context.target.sessionId,
      program: account.program,
      state: original,
    });
    const candidate = requiredFixture(
      inspectUnapprovedAppSuccessor(record, context.target, added, now()),
    );
    const nextPlan = createUnapprovedParticipantPlan(candidate, added);
    const pointer = requiredFixture(nextPlan.normalActorCapturePredecessor);
    const { auth } = candidate.bootstrap;
    const old = structuredClone(requiredFixture(record.operator));
    record.unapprovedAppProposalHistory = [
      {
        approvedByCallId: "operator:unapproved-plan",
        operator: old,
        preparation: structuredClone(account),
        retainedAuth: auth,
        retainedParticipantGateway: {
          candidate: candidate.bootstrap.candidate,
          completion: candidate.bootstrap.gateway ?? auth,
        },
      },
    ];
    const nextOperation = "00000000-0000-4000-8000-000000000005";
    record.operator = {
      approvalId: "new-approval",
      mode: "protected-operator-v1",
      operationRef: nextOperation,
      plan: nextPlan,
      planDigest: operatorPlanDigest(nextPlan),
      receipts: [],
    };
    record.approvedByCallId = "new-call";
    let row: HostedRuntimeJournalRow = { record, revision: 1 };
    const checks: string[] = [];
    let revoked = "";
    const journal = createNormalActorJournal({
      assertAccountApproval: async (_context, preparation) => {
        checks.push(preparation.accountApprovalId);
        if (preparation.accountApprovalId === revoked) {
          throw new Error("approval_revoked");
        }
      },
      assertAuthorized: async () => {},
      assertMutationAuthority: async () => {},
      keyring,
      now,
      store: {
        compareAndSet: async (input) => {
          if (input.expectedRevision !== row.revision) {
            return undefined;
          }
          row = { record: input.record, revision: row.revision + 1 };
          return structuredClone(row);
        },
        read: async () => structuredClone(row),
      },
    });
    const input = {
      accountApprovalId: "new-approval",
      accountApprovedByCallId: "new-call",
      accountOperationRef: nextOperation,
      accountPlan: nextPlan,
      accountPlanDigest: operatorPlanDigest(nextPlan),
      capturePredecessor: pointer,
      program: added,
      programDigest: normalActorProgramDigest(added),
    };
    revoked = account.accountApprovalId;
    await expect(
      journal.initializeSuccessor(
        context,
        input,
        async () => {},
        async (_preparation, state) => state,
      ),
    ).rejects.toThrow("approval_revoked");
    expect(row.record.accountPreparation?.accountOperationRef).toBe(account.accountOperationRef);
    revoked = auth.approvalId;
    await expect(
      journal.initializeSuccessor(
        context,
        input,
        async () => {},
        async (_preparation, state) => state,
      ),
    ).rejects.toThrow("approval_revoked");
    expect(row.record.accountPreparation?.accountOperationRef).toBe(account.accountOperationRef);
    revoked = "gateway-approval";
    await expect(
      journal.initializeSuccessor(
        context,
        input,
        async () => {},
        async (_preparation, state) => state,
      ),
    ).rejects.toThrow("approval_revoked");
    expect(row.record.accountPreparation?.accountOperationRef).toBe(account.accountOperationRef);
    revoked = "";
    await journal.initializeSuccessor(
      context,
      input,
      async () => {},
      async (_preparation, state) => state,
    );
    const after = await journal.read(context);
    expect(after?.state?.actors.find((entry) => entry.actorKey === "owner")).toEqual(
      original.actors[0],
    );
    expect(checks).toContain(account.accountApprovalId);
    expect(checks).toContain(auth.approvalId);
    expect(checks).toContain("gateway-approval");
    expect(checks).toContain("new-approval");
    expect(row.record.unapprovedAppProposalHistory?.[0]?.operator.approvalId).toBeUndefined();

    const cookie = {
      domain: "apps.example",
      expires: -1 as const,
      hostOnly: true,
      httpOnly: true as const,
      name: "session",
      path: "/",
      sameSite: "Lax" as const,
      secure: true as const,
      value: "fresh-cookie",
    };
    const proof = "independently-confirmed-capture";
    const proofSha256 = createHash("sha256").update(proof).digest("hex");
    const capture = async (nonce: string, actorId: string) => {
      const reference = await journal.authorizeCapture(context, {
        actorKey: "owner",
        expiresAt: "2027-01-01T00:00:00Z",
        nonceSha256: nonce,
        proofSha256,
      });
      const session = {
        activeOrganizationId: "existing-organization",
        actorId,
        expiresAt: "2027-01-01T00:00:00Z",
        origin: account.program.origin,
        realmSessionId: "fresh-session",
        reference,
      };
      await journal.capture(context, {
        actorKey: "owner",
        nonceSha256: nonce,
        normalCookie: cookie,
        proof,
        proofSha256,
        session,
        version: 1,
      });
      const { hostOnly, ...storageCookie } = cookie;
      void hostOnly;
      const currentState = await journal.read(context);
      const refreshed = structuredClone(requiredFixture(currentState?.state));
      refreshed.actors[0] = {
        actorKey: "owner",
        session,
        signup: "complete",
        storageState: { cookies: [storageCookie], origins: [] },
      };
      return refreshed;
    };
    const changedActor = await capture("1".repeat(64), "different-actor");
    await expect(journal.checkpoint(context, changedActor)).rejects.toThrow(
      "normal_actor_journal_authority_mismatch",
    );
    const refreshed = await capture("2".repeat(64), "original");
    const forgedCookie = structuredClone(refreshed);
    requiredFixture(
      requiredFixture(requiredFixture(forgedCookie.actors[0]).storageState).cookies[0],
    ).value = "forged-cookie";
    await expect(journal.checkpoint(context, forgedCookie)).rejects.toThrow(
      "normal_actor_journal_authority_mismatch",
    );
    await journal.checkpoint(context, refreshed);
    const confirmedState = await journal.read(context);
    expect(confirmedState?.state.actors[0]).toEqual(refreshed.actors[0]);
    expect(row.record.unapprovedAppProposalHistory?.[0]?.preparation.sealedState).toEqual(
      account.sealedState,
    );
    const qaSession = {
      actorId: "qa-actor",
      expiresAt: "2027-01-01T00:00:00Z",
      origin: added.origin,
      realmSessionId: "qa-session",
      reference: "88888888-8888-4888-8888-888888888888",
    };
    const currentState = await journal.read(context);
    const organizationState = structuredClone(requiredFixture(currentState?.state));
    const qa = organizationState.actors.find((actor) => actor.actorKey === "reviewer");
    if (qa === undefined) {
      throw new Error("missing QA actor");
    }
    qa.signup = "complete";
    qa.session = qaSession;
    qa.storageState = { cookies: [], origins: [] };
    organizationState.organizationSessions = [
      {
        actorKey: "reviewer",
        organizationId: "qa-org",
        selection: "pending",
        session: qaSession,
        storageState: { cookies: [], origins: [] },
      },
    ];
    await journal.checkpoint(context, organizationState);
    const binding = {
      audience: "https://operator.example",
      authResourceId: nextPlan.authDatabase.resourceId,
      bootstrapPlanDigest: input.accountPlanDigest,
      browserOrigin: added.origin,
      endpointOrigin: candidate.bootstrap.candidate.origin,
      issuer: added.origin,
      transportSource: {
        audience: "https://vercel.com/team",
        environment: "preview" as const,
        issuer: "https://oidc.vercel.com/team",
        ownerId: "team",
        projectId: "builder",
      },
    };
    const proofResult = await journal.prepareOrganizationProof(context, {
      assertBootstrapCurrent: async () => {},
      binding,
      bootstrap: candidate.bootstrap,
      organizationId: "qa-org",
      owner: qaSession,
      ownerActorKey: "reviewer",
    });
    expect(proofResult.record.organizationId).toBe("qa-org");
  });
});
