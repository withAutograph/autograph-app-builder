/* oxlint-disable eslint/require-await -- In-memory ports expose the production async contract. */
import { describe, expect, it, vi } from "vitest";
import { operatorPlanDigest } from "./hosted-operator-contract";
import { createNormalActorJournal } from "./hosted-operator-normal-actor-journal";
import type { NormalActorJournalPorts } from "./hosted-operator-normal-actor-journal";
import { createHostedOperatorNormalActorOperations } from "./hosted-operator-normal-actor-operations";
import type { NormalActorOperationsDependencies } from "./hosted-operator-normal-actor-operations";
import { initialNormalActorState } from "./hosted-operator-normal-actor-program";
import { encryptNormalActorState } from "./hosted-operator-normal-actor-state";
import { inspectUnapprovedAppSuccessor } from "./hosted-operator-unapproved-app-successor";
import { createUnapprovedParticipantPlan } from "./hosted-operator-unapproved-participant-plan";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import {
  captureFixture,
  context,
  observedAt,
  requiredFixture,
} from "./hosted-operator-unapproved-app-successor.test-support";

describe("expired pre-delivery captured account", () => {
  it("initializes the real successor, requests a reconnect without replaying its cookie, and rejects a changed actor", async () => {
    const { record, added } = captureFixture();
    const original = requiredFixture(record.accountPreparation);
    const originalState = initialNormalActorState(original.program, original.accountOperationRef);
    originalState.actors[0] = {
      actorKey: "owner",
      session: {
        actorId: "original-actor",
        expiresAt: "2026-10-13T00:00:00Z",
        origin: original.program.origin,
        realmSessionId: "expired-session",
        reference: "00000000-0000-4000-8000-000000000010",
      },
      signup: "complete",
      storageState: {
        cookies: [
          {
            domain: "apps.example",
            expires: -1,
            httpOnly: true,
            name: "fixture-session",
            path: "/",
            sameSite: "Lax",
            secure: true,
            value: "expired",
          },
        ],
        origins: [],
      },
    };
    const keyring = { tokenKey: Buffer.alloc(32, 7), tokenKeyVersion: "v1" };
    original.sealedState = encryptNormalActorState({
      authority: context.authority,
      config: keyring,
      operationRef: original.accountOperationRef,
      ownerSessionId: context.target.sessionId,
      program: original.program,
      state: originalState,
    });
    const candidate = inspectUnapprovedAppSuccessor(
      record,
      context.target,
      added,
      Date.parse(observedAt),
    );
    if (candidate === undefined) {
      throw new Error("missing candidate");
    }
    const plan = createUnapprovedParticipantPlan(candidate, added);
    const newRef = "00000000-0000-4000-8000-000000000011";
    record.unapprovedAppProposalHistory = [
      {
        approvedByCallId: "operator:unapproved-plan",
        operator: structuredClone(candidate.priorOperator),
        preparation: structuredClone(original),
        retainedAuth: structuredClone(candidate.bootstrap.auth),
        retainedParticipantGateway: record.retainedParticipantGateway,
      },
    ];
    record.operator = {
      approvalId: "new-approval",
      mode: "protected-operator-v1",
      operationRef: newRef,
      plan,
      planDigest: operatorPlanDigest(plan),
      receipts: [],
    };
    record.approvedByCallId = "new-call";
    let row = { record: hostedRuntimeJournalRecordSchema.parse(record), revision: 1 };
    const store: NormalActorJournalPorts["store"] = {
      compareAndSet: async (input) => {
        if (input.expectedRevision !== row.revision) {
          // oxlint-disable-next-line unicorn/no-useless-undefined -- CAS explicitly returns no row.
          return undefined;
        }
        row = {
          record: hostedRuntimeJournalRecordSchema.parse(input.record),
          revision: row.revision + 1,
        };
        return structuredClone(row);
      },
      read: async () => structuredClone(row),
    };
    const journalPorts: NormalActorJournalPorts = {
      assertAccountApproval: async () => {},
      assertAuthorized: async () => {},
      assertMutationAuthority: async () => {},
      keyring,
      now: () => Date.parse(observedAt),
      store,
    };
    const network = vi.fn<typeof fetch>(async () => {
      throw new Error("expired cookie used");
    });
    const invitation = vi.fn<NormalActorOperationsDependencies["prepareActorCapture"]>(async () => {
      throw new Error("ordinary invitation");
    });
    const deps: NormalActorOperationsDependencies = {
      assertCurrentPlan: async () => {},
      assertPlanningAuthorized: async () => {},
      collectOrganizationOwnerProof: vi.fn(),
      executeOrganization: vi.fn(),
      inspectOrganization: vi.fn(),
      journalPorts,
      normalRealmFetch: async () => network,
      prepareActorCapture: invitation,
    };
    const operations = createHostedOperatorNormalActorOperations(deps);
    const input = {
      ...context,
      approvalId: "new-approval",
      callId: "new-call",
      operationRef: newRef,
      plan,
      planDigest: operatorPlanDigest(plan),
    };
    await expect(operations.ensureNormalActorCapture(input)).rejects.toThrow("ordinary invitation");
    expect(invitation).toHaveBeenCalledWith(
      expect.objectContaining({ actorKey: "owner", organizationId: undefined }),
    );
    expect(network).not.toHaveBeenCalled();
    const saved = await createNormalActorJournal(journalPorts).read(context);
    expect(saved?.state.actors[0]).toEqual(originalState.actors[0]);
    const changed = structuredClone(requiredFixture(saved).state);
    requiredFixture(requiredFixture(changed.actors[0]).session).actorId = "different-actor";
    const before = structuredClone(row);
    await expect(
      createNormalActorJournal(journalPorts).checkpoint(context, changed),
    ).rejects.toThrow("normal_actor_journal_authority_mismatch");
    expect(row).toEqual(before);
  });
});
