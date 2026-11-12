import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { MessageStreamEvent } from "eve/client";
import type { ApprovedBuildDecision } from "../agent/approved-build-continuation";
import { createDirectProductionGrant } from "../agent/direct-production-authorization";
import {
  repositoryProductionApprovalInput,
  repositoryProductionApprovalReference,
} from "../provisioning/repository-production-approval";
import type { OperatorOwnerContext } from "../provisioning/hosted-operator-contract";
import type { PrivateOperatorApprovalObservation } from "./private-operator-approval-observation";
import type {
  RepositoryProductionIntent,
  RepositoryProductionScope,
} from "../provisioning/repository-production-contract";
import {
  deriveInstalledEveStatus,
  outstandingInstalledEveRequests,
  projectInstalledEveEvent,
} from "./public-events";
import {
  assertDirectRepositoryProductionApproval,
  createPrivateRepositoryProductionApprovalCapture,
  readRepositoryProductionApproval,
} from "./private-repository-production-approval";

const scope: RepositoryProductionScope = {
  authority: {
    issuer: "https://builder.example/api/auth",
    audience: "https://builder.example/mcp",
    workspaceId: "workspace",
    ownerUserId: "creator-account-private-canary",
  },
  appId: "example",
  repositoryId: "repo",
  repositoryFullName: "owner/repo",
  projectId: "project",
  organizationId: "org",
  publicOrigin: "https://apps.example",
  environment: "production",
};
const intent: RepositoryProductionIntent = {
  sessionId: "session",
  sourceSha: "a".repeat(40),
  creatorRoles: ["editor"],
  storage: {
    kind: "postgres",
    releaseId: "release",
    artifactRef: "artifact",
    manifestSha256: "b".repeat(64),
    databaseEnvironment: "APP_DATABASE_URL",
  },
};
const plan = repositoryProductionApprovalInput(scope, intent);
const approvalWireInput = z.record(z.string(), z.json());
const request = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Parse intentionally malformed domain inputs at the test wire boundary.
  value: unknown = plan,
  callId = "call",
  toolName = "prepare-app-production",
): MessageStreamEvent => ({
  type: "input.requested",
  meta: { at: "2026-11-06T00:00:00Z", id: "request-event" },
  data: {
    sequence: 1,
    stepIndex: 0,
    turnId: "turn",
    requests: [
      {
        kind: "tool-approval",
        requestId: "request",
        prompt: "Set up this app?",
        action: {
          kind: "tool-call",
          toolName,
          callId,
          input: approvalWireInput.parse(value),
        },
      },
    ],
  },
});
const owner: OperatorOwnerContext = {
  kind: "direct",
  authority: scope.authority,
  principal: { ...scope.authority, scopes: ["autograph:send"] },
  sessionId: intent.sessionId,
  adapterSessionId: "native",
  adapterGeneration: 1,
};
const settle = (
  actor = scope.authority.ownerUserId,
  outcome: "approved" | "cancelled" = "approved",
): MessageStreamEvent => ({
  type: "approval.settled",
  meta: { at: "2026-11-06T00:00:01Z", id: "settlement" },
  data: {
    sequence: 2,
    stepIndex: 0,
    turnId: "turn",
    requestId: "request",
    responderPrincipalId: actor,
    outcome,
  },
});

const directApprovalHistory =
  (events: MessageStreamEvent[]) =>
  async (_start: number, observe: (event: MessageStreamEvent) => void) => {
    for (const event of events) {
      observe(event);
    }
    return await Promise.resolve({
      complete: true,
      nativeTailIndex: events.length,
      nextNativeIndex: events.length,
    });
  };

describe("direct Production setup consent", () => {
  const repository = {
    repositoryId: "1234",
    owner: "withAutograph",
    name: "arrusted-development",
    defaultBranch: "main",
  };
  const storageKind = "postgres" as const;
  const directPlan = repositoryProductionApprovalInput(
    {
      ...scope,
      repositoryId: repository.repositoryId,
      repositoryFullName: "withAutograph/arrusted-development",
    },
    intent,
  );
  const subject = {
    version: 1 as const,
    authority: scope.authority,
    appId: scope.appId,
    appSpecDigest: "d".repeat(64),
    proposalDigest: "e".repeat(64),
    sessionId: "native-logical",
    buildWorkspaceId: "approved-build-workspace",
    repositoryId: repository.repositoryId,
    repositoryFullName: "withAutograph/arrusted-development" as const,
    installationId: "5432",
    baseBranch: repository.defaultBranch,
    storageKind,
  };
  const callId = "build-or-release-call";
  const grant = createDirectProductionGrant({ callId, subject, toolName: "apply_app_creation" });
  const currentSpec = {
    appId: subject.appId,
    appSpecDigest: subject.appSpecDigest,
    proposalDigest: subject.proposalDigest,
    sessionId: subject.sessionId,
    workspaceId: subject.buildWorkspaceId,
  };
  const decision: ApprovedBuildDecision = {
    version: 1,
    adapterSessionId: owner.adapterSessionId,
    workflowPhase: "reviewed",
    decision: "working",
    turnId: "turn",
    turnSequence: 1,
    directProduction: grant,
    currentSpec,
  };
  const authority = {
    plan: directPlan,
    grant,
    decision,
    destination: {
      kind: "existing-repository" as const,
      version: 1 as const,
      appId: subject.appId,
      installationId: subject.installationId,
      repository,
      confirmedByCallId: "repository-selection",
    },
    logicalSessionId: subject.sessionId,
    owner,
    publishedDescription: true,
  };
  it.each(["apply_app_creation", "release-app-production"] as const)(
    "uses the genuine settled owner approval for %s",
    async (toolName) => {
      const approved = createDirectProductionGrant({ callId, subject, toolName });
      await expect(
        readRepositoryProductionApproval({
          plan: directPlan,
          callId,
          owner,
          directProduction: { grant: approved, logicalSessionId: subject.sessionId },
          assertOwner: async () => {},
          readHistory: directApprovalHistory([
            request({ directProduction: subject }, callId, toolName),
            settle(),
          ]),
        }),
      ).resolves.toEqual({ approvalId: "request", approvedByCallId: callId });
    },
  );
  it.each([
    { name: "private Build", events: [request({}, callId, grant.toolName), settle()] },
    {
      name: "changed scope",
      events: [
        request({ directProduction: { ...subject, storageKind: "none" } }, callId, grant.toolName),
        settle(),
      ],
    },
    {
      name: "wrong call",
      events: [request({ directProduction: subject }, "different-call", grant.toolName), settle()],
    },
    {
      name: "another responder",
      events: [request({ directProduction: subject }, callId, grant.toolName), settle("other")],
    },
    {
      name: "cancelled approval",
      events: [
        request({ directProduction: subject }, callId, grant.toolName),
        settle(scope.authority.ownerUserId, "cancelled"),
      ],
    },
  ])("rejects $name as delegated Production consent", async ({ events }) => {
    await expect(
      readRepositoryProductionApproval({
        plan: directPlan,
        callId,
        owner,
        directProduction: { grant, logicalSessionId: subject.sessionId },
        assertOwner: async () => {},
        readHistory: directApprovalHistory(events),
      }),
    ).resolves.toBeNull();
  });
  it("uses the approved logical session with the exact reviewed and published app", () => {
    expect(() => {
      assertDirectRepositoryProductionApproval(authority);
    }).not.toThrow();
  });
  it("does not use a combined revision approval to change Production setup", () => {
    const revision = createDirectProductionGrant({
      callId,
      toolName: grant.toolName,
      subject: {
        ...subject,
        revision: { priorGrantDigest: "b".repeat(64), priorProposalDigest: "c".repeat(64) },
      },
    });
    expect(() => {
      assertDirectRepositoryProductionApproval({
        ...authority,
        grant: revision,
        decision: { ...decision, directProduction: revision },
      });
    }).toThrow("repository_production_approval_required");
  });
  it.each([
    { name: "unpublished source", change: { publishedDescription: false } },
    { name: "different logical session", change: { logicalSessionId: "different-session" } },
    {
      name: "unreviewed current source",
      change: { decision: { ...decision, workflowPhase: "applied" } },
    },
    {
      name: "stopped delivery",
      change: { decision: { ...decision, decision: "blocked" as const } },
    },
    {
      name: "different Build workspace",
      change: {
        decision: {
          ...decision,
          currentSpec: { ...currentSpec, workspaceId: "other" },
        },
      },
    },
    {
      name: "different repository branch",
      change: {
        destination: {
          ...authority.destination,
          repository: { ...repository, defaultBranch: "other" },
        },
      },
    },
    {
      name: "different managed storage",
      change: {
        plan: repositoryProductionApprovalInput(directPlan.scope, {
          ...intent,
          storage: { kind: "none" },
        }),
      },
    },
    {
      name: "broader signup access",
      change: {
        plan: repositoryProductionApprovalInput(directPlan.scope, {
          ...intent,
          access: { mode: "self-signup", eligibility: "public", appRoles: [] },
        }),
      },
    },
  ])("rejects $name before retaining approval", ({ change }) => {
    expect(() => {
      assertDirectRepositoryProductionApproval({ ...authority, ...change });
    }).toThrow("repository_production_approval_required");
  });
});

describe("Production setup consent", () => {
  it.each([
    { name: "private database", intent },
    {
      name: "roleless frontend",
      intent: { ...intent, creatorRoles: [], storage: { kind: "none" as const } },
    },
    {
      name: "roleless public signup database",
      intent: {
        ...intent,
        creatorRoles: [],
        access: { mode: "self-signup" as const, eligibility: "public" as const, appRoles: [] },
        entryPath: "/example",
      },
    },
    {
      name: "approved-email signup",
      intent: {
        ...intent,
        creatorEmail: "creator@example.com",
        access: {
          mode: "self-signup" as const,
          eligibility: "approved-email" as const,
          allowedEmails: ["invitee@example.com"],
          appRoles: ["editor"],
        },
        entryPath: "/example",
      },
    },
  ])("accepts the settled compact reference for $name", ({ intent: selectedIntent }) => {
    const expected = repositoryProductionApprovalInput(scope, selectedIntent);
    const reference = repositoryProductionApprovalReference(expected);
    const capture = createPrivateRepositoryProductionApprovalCapture({
      callId: "call",
      plan: expected,
    });
    capture.observe(structuredClone(request(reference)));
    expect(capture.read()).toBeNull();
    capture.observe(settle());
    expect(capture.read()).toEqual({ approvalId: "request", approvedByCallId: "call" });
    expect(reference).not.toHaveProperty("intent");
    if (selectedIntent.storage.kind === "postgres") {
      expect(JSON.stringify(reference)).not.toContain(selectedIntent.storage.manifestSha256);
      expect(JSON.stringify(reference)).not.toContain(selectedIntent.storage.artifactRef);
    }
  });

  const reference = repositoryProductionApprovalReference(plan);
  it.each([
    { name: "unsupported version", value: { ...reference, version: 3 } },
    { name: "malformed hash", value: { ...reference, planDigest: "not-a-digest" } },
    { name: "changed hash", value: { ...reference, planDigest: "c".repeat(64) } },
    {
      name: "changed operation",
      value: { ...reference, operationRef: "11111111-1111-4111-8111-111111111111" },
    },
    { name: "changed app", value: { ...reference, appId: "other-app" } },
    { name: "changed repository identity", value: { ...reference, repositoryId: "other-repo" } },
    {
      name: "changed repository",
      value: { ...reference, review: { ...reference.review, repositoryFullName: "owner/other" } },
    },
    {
      name: "changed storage",
      value: { ...reference, review: { ...reference.review, storageKind: "none" } },
    },
    {
      name: "excessive roles",
      value: { ...reference, review: { ...reference.review, creatorRoles: ["admin"] } },
    },
    {
      name: "changed creator",
      value: { ...reference, review: { ...reference.review, creatorEmail: "other@example.com" } },
    },
    {
      name: "changed access",
      value: {
        ...reference,
        review: {
          ...reference.review,
          access: { mode: "self-signup", eligibility: "public", appRoles: [] },
        },
      },
    },
    { name: "missing review", value: { ...reference, review: null } },
    { name: "extra top-level field", value: { ...reference, manifestSha256: "b".repeat(64) } },
    {
      name: "extra review field",
      value: { ...reference, review: { ...reference.review, manifestSha256: "b".repeat(64) } },
    },
    {
      name: "extra access field",
      value: {
        ...reference,
        review: { ...reference.review, access: { mode: "private", administrator: true } },
      },
    },
    { name: "legacy plan with reference tag", value: { ...plan, version: 2 } },
  ])("rejects a compact reference with $name", ({ value }) => {
    const capture = createPrivateRepositoryProductionApprovalCapture({ callId: "call", plan });
    capture.observe(request(value));
    capture.observe(settle());
    expect(capture.read()).toBeNull();
  });

  it.each([
    { name: "another actor", actor: "other", outcome: "approved" as const, callId: "call" },
    {
      name: "cancellation",
      actor: scope.authority.ownerUserId,
      outcome: "cancelled" as const,
      callId: "call",
    },
    {
      name: "an old call",
      actor: scope.authority.ownerUserId,
      outcome: "approved" as const,
      callId: "old-call",
    },
  ])("rejects compact-reference consent from $name", ({ actor, outcome, callId }) => {
    const capture = createPrivateRepositoryProductionApprovalCapture({ callId: "call", plan });
    capture.observe(request(reference, callId));
    capture.observe(settle(actor, outcome));
    expect(capture.read()).toBeNull();
  });

  it.each(["owner", "session"] as const)(
    "rejects a compact reference before reading history when the %s binding changes",
    async (variation) => {
      const changedOwner = {
        ...owner,
        authority:
          variation === "owner" ? { ...owner.authority, ownerUserId: "other" } : owner.authority,
        sessionId: variation === "session" ? "other-session" : owner.sessionId,
      };
      const readHistory = vi
        .fn<Parameters<typeof readRepositoryProductionApproval>[0]["readHistory"]>()
        .mockResolvedValue({
          complete: true,
          nextNativeIndex: 2,
          nativeTailIndex: 2,
        });
      await expect(
        readRepositoryProductionApproval({
          plan,
          callId: "call",
          owner: changedOwner,
          assertOwner: async () => {},
          readHistory,
        }),
      ).rejects.toThrow();
      expect(readHistory).not.toHaveBeenCalled();
    },
  );

  it("does not grant compact-reference consent after canonical ownership is lost", async () => {
    const save = vi.fn(async () => {});
    await expect(
      readRepositoryProductionApproval({
        plan,
        callId: "call",
        owner,
        observation: { save },
        assertOwner: vi.fn<() => Promise<void>>().mockRejectedValue(new Error("Owner changed")),
        readHistory: async (_start, observe) => {
          for (const event of [request(reference), settle()]) {
            observe(event);
          }
          return await Promise.resolve({ complete: true, nextNativeIndex: 2, nativeTailIndex: 2 });
        },
      }),
    ).rejects.toThrow("Owner changed");
    expect(save).not.toHaveBeenCalled();
  });

  it("resumes compact-reference observation from the existing intent cursor and waits for the complete tail", async () => {
    let checkpoint: PrivateOperatorApprovalObservation = {
      adapterSessionId: owner.adapterSessionId,
      adapterGeneration: owner.adapterGeneration,
      nextNativeIndex: 27,
      capture: createPrivateRepositoryProductionApprovalCapture({
        callId: "call",
        plan,
      }).snapshot(),
    };
    const starts: number[] = [];
    const readHistory = async (start: number, observe: (event: MessageStreamEvent) => void) => {
      starts.push(start);
      if (starts.length === 1) {
        for (const event of [request(reference), settle()]) {
          observe(event);
        }
        return await Promise.resolve({ complete: false, nextNativeIndex: 29, nativeTailIndex: 30 });
      }
      return await Promise.resolve({ complete: true, nextNativeIndex: 30, nativeTailIndex: 30 });
    };
    const read = async () =>
      await readRepositoryProductionApproval({
        plan,
        callId: "call",
        owner,
        observation: {
          state: checkpoint,
          // oxlint-disable-next-line typescript/promise-function-async -- This synchronous fixture checkpoint returns the required promise without changing event ordering.
          save: (state) => {
            checkpoint = state;
            return Promise.resolve();
          },
        },
        assertOwner: async () => {},
        readHistory,
      });
    await expect(read()).rejects.toThrow();
    expect(checkpoint.nextNativeIndex).toBe(29);
    expect(checkpoint.capture.request).toEqual({
      action: "repository-production",
      planRef: plan.operationRef,
      planDigest: plan.planDigest,
      idempotencyKey: scope.appId,
    });
    await expect(read()).resolves.toEqual({ approvalId: "request", approvedByCallId: "call" });
    expect(starts).toEqual([27, 29]);
  });

  it.each(["postgres", "none"] as const)(
    "shows the ordinary setup approval for %s without treating the card as consent",
    (storageKind) => {
      const setupPlan = repositoryProductionApprovalInput(scope, {
        ...intent,
        storage: storageKind === "none" ? { kind: "none" } : intent.storage,
      });
      const pending = request(setupPlan);
      const projected = projectInstalledEveEvent(pending, 0);
      expect(projected).toMatchObject([
        {
          request: {
            kind: "approval",
            requestId: "request",
          },
          type: "input.requested",
        },
      ]);
      const [publicRequest] = outstandingInstalledEveRequests([pending]);
      expect(publicRequest?.description).toContain(scope.appId);
      expect(publicRequest?.description).toContain(scope.repositoryFullName);
      expect(publicRequest?.description).toContain(
        storageKind === "postgres" ? "database and keeps it" : "does not need a database",
      );
      expect(deriveInstalledEveStatus([pending])).toBe("input_required");
      expect(JSON.stringify(projected)).not.toContain(scope.authority.ownerUserId);
      expect(JSON.stringify(projected)).not.toContain(intent.sessionId);
      const capture = createPrivateRepositoryProductionApprovalCapture({
        callId: "call",
        plan: setupPlan,
      });
      capture.observe(pending);
      expect(capture.read()).toBeNull();
      capture.observe(settle());
      expect(capture.read()).toEqual({ approvalId: "request", approvedByCallId: "call" });
      expect(outstandingInstalledEveRequests([pending, settle()])).toEqual([]);
    },
  );
  it.each([
    { ...plan, scope: null },
    { ...plan, intent: { ...intent, creatorRoles: null } },
    { ...plan, intent: { ...intent, storage: { kind: "unsupported" } } },
  ])("keeps an unreadable setup confirmation closed", (invalidPlan) => {
    const pending = request();
    if (pending.type !== "input.requested") {
      throw new Error("Expected the approval request");
    }
    const [approval] = pending.data.requests;
    if (approval.kind !== "tool-approval") {
      throw new Error("Expected the tool approval");
    }
    approval.action.input = invalidPlan;
    expect(projectInstalledEveEvent(pending, 0)).toMatchObject([
      { code: "confirmation_unavailable", type: "error.public" },
      { status: "failed", type: "status" },
    ]);
    expect(outstandingInstalledEveRequests([pending])).toEqual([]);
    expect(deriveInstalledEveStatus([pending])).toBe("failed");
    const capture = createPrivateRepositoryProductionApprovalCapture({ callId: "call", plan });
    capture.observe(pending);
    capture.observe(settle());
    expect(capture.read()).toBeNull();
  });
  it("shows the selected creator account and binds it to the actual setup approval", () => {
    const selected = repositoryProductionApprovalInput(scope, {
      ...intent,
      creatorEmail: "app@example.com",
    });
    const [card] = outstandingInstalledEveRequests([request(selected)]);
    expect(card?.description).toContain("app@example.com");
    const capture = createPrivateRepositoryProductionApprovalCapture({
      callId: "call",
      plan: selected,
    });
    capture.observe(request(selected));
    capture.observe(settle());
    expect(capture.read()).toMatchObject({ approvedByCallId: "call" });
    expect(selected.planDigest).not.toBe(plan.planDigest);
  });
  it("accepts the actual creator settlement for the current setup call", () => {
    const capture = createPrivateRepositoryProductionApprovalCapture({ callId: "call", plan });
    capture.observe(request());
    expect(capture.read()).toBeNull();
    capture.observe(settle());
    expect(capture.read()).toEqual({ approvalId: "request", approvedByCallId: "call" });
  });
  it.each([
    "organization",
    "recipient",
    "role",
    "schema",
    "storage",
    "session",
    "old-call",
    "actor",
    "cancelled",
  ])("rejects changed or unauthorised %s", (variation) => {
    const changedScope = { ...scope };
    if (variation === "organization") {
      changedScope.organizationId = "other";
    }
    const changedIntent: RepositoryProductionIntent = { ...intent };
    if (variation === "recipient") {
      changedIntent.creatorEmail = "app@example.com";
    }
    if (variation === "role") {
      changedIntent.creatorRoles = ["admin"];
    }
    if (variation === "session") {
      changedIntent.sessionId = "other";
    }
    if (variation === "storage") {
      changedIntent.storage = { kind: "none" };
    }
    if (variation === "schema" && intent.storage.kind === "postgres") {
      changedIntent.storage = { ...intent.storage, manifestSha256: "c".repeat(64) };
    }
    const capture = createPrivateRepositoryProductionApprovalCapture({ callId: "call", plan });
    capture.observe(
      request(
        repositoryProductionApprovalInput(changedScope, changedIntent),
        variation === "old-call" ? "old" : "call",
      ),
    );
    capture.observe(
      settle(
        variation === "actor" ? "other" : scope.authority.ownerUserId,
        variation === "cancelled" ? "cancelled" : "approved",
      ),
    );
    expect(capture.read()).toBeNull();
  });
  it("keeps resource consent stable when only the source commit changes", () => {
    expect(
      repositoryProductionApprovalInput(scope, { ...intent, sourceSha: "f".repeat(40) }).planDigest,
    ).toBe(plan.planDigest);
  });
  it("does not treat a partial history as settled consent", async () => {
    const assertOwner = vi.fn(async () => {});
    const result = readRepositoryProductionApproval({
      plan,
      callId: "call",
      owner: {
        kind: "direct",
        authority: scope.authority,
        principal: { ...scope.authority, scopes: ["autograph:send"] },
        sessionId: "session",
        adapterSessionId: "native",
        adapterGeneration: 1,
      },
      assertOwner,
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
      readHistory: (_start, observe) => {
        observe(request());
        observe(settle());
        return Promise.resolve({ complete: false, nextNativeIndex: 2, nativeTailIndex: 2 });
      },
    });
    await expect(result).rejects.toThrow("complete durable tail");
    expect(assertOwner).toHaveBeenCalled();
  });
});
