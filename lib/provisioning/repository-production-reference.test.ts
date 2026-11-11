/* oxlint-disable eslint/require-await -- Controlled service ports retain the asynchronous native authorization and setup interfaces. */
/* oxlint-disable sonarjs/no-internal-api-use -- Fresh installed Eve contexts exercise actual retained managed-service state. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { MessageStreamEvent } from "eve/client";
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import { createRepositoryProductionClient } from "../agent/repository-production-client";
import { managedProductionDeliveryRequirements } from "../agent/production-delivery-requirement";
import { readRepositoryProductionApproval } from "../eve/private-repository-production-approval";
import type { RepositoryProductionApprovalReference } from "./repository-production-approval";
import {
  assertRepositoryProductionApprovalReference,
  repositoryProductionApprovalInput,
  repositoryProductionApprovalInputSchema,
  repositoryProductionPrepareInputSchema,
} from "./repository-production-approval";
import type {
  RepositoryProductionIntent,
  RepositoryProductionScope,
} from "./repository-production-contract";
import { outstandingInstalledEveRequests, deriveInstalledEveStatus } from "../eve/public-events";
import {
  createRepositoryProductionHandler,
  repositoryProductionRequestSchema,
} from "./repository-production-dispatcher";
import type { RepositoryProductionHandlerDependencies } from "./repository-production-dispatcher";

const scope: RepositoryProductionScope = {
  authority: {
    issuer: "https://builder.example/api/auth",
    audience: "https://builder.example/mcp",
    workspaceId: "workspace",
    ownerUserId: "creator",
  },
  appId: "notebook",
  repositoryId: "repository",
  repositoryFullName: "example/apps",
  projectId: "project",
  organizationId: "organization",
  publicOrigin: "https://apps.example",
  environment: "production",
};
const manifest = Buffer.from('{"app":"notebook","schema_version":"notes-v1"}\n');
const manifestSha256 = createHash("sha256").update(manifest).digest("hex");
const initialIntent: RepositoryProductionIntent = {
  sessionId: "saved-session",
  sourceSha: "a".repeat(40),
  creatorRoles: [],
  creatorEmail: "creator@example.com",
  access: { mode: "self-signup", eligibility: "public", appRoles: [] },
  storage: {
    kind: "postgres",
    releaseId: "notes-v1",
    artifactRef: "captured-release",
    manifestSha256,
    databaseEnvironment: "NOTEBOOK_DATABASE_URL",
  },
};
const ownerContext = {
  kind: "direct" as const,
  authority: scope.authority,
  principal: { ...scope.authority, scopes: ["autograph:send"] },
  sessionId: initialIntent.sessionId,
  adapterSessionId: "native-session",
  adapterGeneration: 1,
};

const approvalEvents = (input: RepositoryProductionApprovalReference): MessageStreamEvent[] => [
  {
    type: "input.requested",
    meta: { at: "2026-11-10T00:00:00Z", id: "request-event" },
    data: {
      sequence: 1,
      stepIndex: 0,
      turnId: "turn",
      requests: [
        {
          kind: "tool-approval",
          requestId: "approval-request",
          prompt: "Set up the app?",
          action: {
            kind: "tool-call",
            toolName: "prepare-app-production",
            callId: "prepare-call",
            input,
          },
        },
      ],
    },
  },
  {
    type: "approval.settled",
    meta: { at: "2026-11-10T00:00:01Z", id: "settlement" },
    data: {
      sequence: 2,
      stepIndex: 0,
      turnId: "turn",
      requestId: "approval-request",
      responderPrincipalId: scope.authority.ownerUserId,
      outcome: "approved",
    },
  },
];

const fixture = (intent = initialIntent) => {
  let currentScope = structuredClone(scope);
  let currentIntent = structuredClone(intent);
  let humanApproval: RepositoryProductionApprovalReference | undefined;
  let ownerActive = true;
  const controller = new AbortController();
  const effects: RepositoryProductionIntent[] = [];
  const requests: z.infer<typeof repositoryProductionRequestSchema>[] = [];
  const assertOwner = () => {
    if (!ownerActive) {
      throw new Error("authorization_required");
    }
  };
  const assertRequestOwner = (
    owner: Parameters<RepositoryProductionHandlerDependencies["resolvePlan"]>[0],
  ) => {
    assertOwner();
    if (
      !isDeepStrictEqual(owner.ownerContext, ownerContext) ||
      owner.appId !== currentScope.appId
    ) {
      throw new Error("authorization_required");
    }
  };
  const prepare = async (
    _scope: RepositoryProductionScope,
    requested: RepositoryProductionIntent,
  ) => {
    assertOwner();
    effects.push(structuredClone(requested));
    return {
      operationRef: repositoryProductionApprovalInput(currentScope, currentIntent).operationRef,
      state: "ready" as const,
    };
  };
  const handler = createRepositoryProductionHandler({
    verifyBuilderWorkload: async (request) => {
      if (request.headers.get("authorization") !== "Bearer controlled-workload") {
        throw new Error("authorization_required");
      }
    },
    verifyAuthWorkload: async () => {
      throw new Error("unexpected auth callback");
    },
    resolvePlan: async (owner) => {
      assertRequestOwner(owner);
      return { scope: currentScope, intent: currentIntent };
    },
    resolveSetup: async (owner, callId, _email, reference) => {
      assertRequestOwner(owner);
      const plan = repositoryProductionApprovalInput(currentScope, currentIntent);
      if (reference !== undefined) {
        assertRepositoryProductionApprovalReference(plan, reference);
      }
      const approved = await readRepositoryProductionApproval({
        plan,
        owner: owner.ownerContext,
        callId,
        assertOwner: async () => {
          assertOwner();
        },
        readHistory: async (_start, observe) => {
          const events = humanApproval === undefined ? [] : approvalEvents(humanApproval);
          for (const event of events) {
            observe(event);
          }
          return { complete: true, nextNativeIndex: events.length, nativeTailIndex: events.length };
        },
      });
      if (approved === null) {
        throw new Error("repository_production_approval_required");
      }
      return { scope: currentScope, intent: currentIntent, setup: { prepare, status: prepare } };
    },
    readSetup: async () => ({
      operationRef: repositoryProductionApprovalInput(currentScope, currentIntent).operationRef,
      state: "ready",
    }),
    readDeliveryStatus: async (_owner, target) => ({
      version: 1,
      appId: currentScope.appId,
      ...target,
      applicable: false,
    }),
    management: {
      read: async () => ({
        sessionId: initialIntent.sessionId,
        appId: currentScope.appId,
        appName: "Notebook",
        organizationName: "Dev",
        canManage: true,
        roles: [],
        members: [],
        invitations: [],
        creator: { status: "ready" },
      }),
      execute: async () => {
        throw new Error("unexpected People effect");
      },
      completeInvitation: async () => {
        throw new Error("unexpected invitation effect");
      },
    },
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async (resource, init) => {
    const request = new Request(resource, init);
    requests.push(repositoryProductionRequestSchema.parse(await request.clone().json()));
    return await handler(request);
  });
  const workloadToken = vi.fn(async () => "controlled-workload");
  const client = createRepositoryProductionClient({
    endpoint: "https://operator.example/",
    ownerContext,
    callId: "prepare-call",
    signal: controller.signal,
    workloadToken,
    fetch,
  });
  return {
    client,
    fetch,
    workloadToken,
    controller,
    requests,
    effects,
    handler,
    approve: (reference: RepositoryProductionApprovalReference) => {
      humanApproval = structuredClone(reference);
    },
    revise: (next: RepositoryProductionIntent, nextScope = currentScope) => {
      currentIntent = structuredClone(next);
      currentScope = structuredClone(nextScope);
    },
    revoke: () => {
      ownerActive = false;
    },
  };
};

const inContext = <T>(run: () => T) => contextStorage.run(new ContextContainer(), run);

describe("server-owned Production setup handoff", () => {
  it("forwards the original release approval call without a creator override", async () => {
    await inContext(async () => {
      const h = fixture({ ...initialIntent, access: { mode: "private" } });
      const { approvalReference } = await h.client.plan(scope.appId);
      await expect(h.client.prepare(approvalReference, "original-release-call")).rejects.toThrow();
      const prepared = h.requests.find((request) => request.action === "prepare");
      expect(prepared).toMatchObject({
        action: "prepare",
        approvalReference,
        approvedByCallId: "original-release-call",
      });
      expect(prepared).not.toHaveProperty("creatorEmail");
      expect(h.effects).toEqual([]);
    });
  });

  it("projects an ordinary compact-reference approval without exposing private setup metadata", () => {
    const h = fixture();
    expect(h.effects).toEqual([]);
    const reference = repositoryProductionPrepareInputSchema.parse({
      version: 2,
      appId: scope.appId,
      repositoryId: scope.repositoryId,
      operationRef: repositoryProductionApprovalInput(scope, initialIntent).operationRef,
      planDigest: repositoryProductionApprovalInput(scope, initialIntent).planDigest,
      review: {
        repositoryFullName: scope.repositoryFullName,
        storageKind: initialIntent.storage.kind,
        creatorRoles: initialIntent.creatorRoles,
        creatorEmail: initialIntent.creatorEmail,
        access: initialIntent.access,
      },
    });
    if (!("version" in reference)) {
      throw new Error("Expected the compact test reference");
    }
    const events = approvalEvents(reference).slice(0, 1);
    expect(deriveInstalledEveStatus(events)).toBe("input_required");
    const [card] = outstandingInstalledEveRequests(events);
    expect(card).toMatchObject({ kind: "approval", requestId: "approval-request" });
    expect(card?.description).toContain(scope.appId);
    expect(card?.description).toContain(scope.repositoryFullName);
    expect(card?.description).toContain(initialIntent.creatorEmail);
    expect(JSON.stringify(card)).not.toContain(manifestSha256);
    expect(JSON.stringify(card)).not.toContain(initialIntent.sessionId);
    expect(JSON.stringify(card)).not.toContain(scope.authority.workspaceId);
    expect(h.effects).toEqual([]);
  });

  it.each(["postgres", "none"] as const)(
    "plans and prepares %s without roundtripping database release fields through the model",
    async (storage) => {
      await inContext(async () => {
        const intent =
          storage === "none"
            ? { ...initialIntent, storage: { kind: "none" as const } }
            : initialIntent;
        const h = fixture(intent);
        const result = await h.client.plan(scope.appId);
        const reference = result.nextCall.input;
        expect(repositoryProductionPrepareInputSchema.parse(reference)).toEqual(
          result.approvalReference,
        );
        expect(Object.hasOwn(reference, "intent")).toBe(false);
        expect(Object.hasOwn(reference, "manifestSha256")).toBe(false);
        expect(reference.review.creatorRoles).toEqual([]);
        expect(reference.review.storageKind).toBe(storage);
        expect(h.effects).toEqual([]);
        await expect(h.client.prepare(reference)).rejects.toThrow();
        expect(h.effects).toEqual([]);
        h.approve(reference);
        await expect(h.client.prepare(reference)).resolves.toMatchObject({
          appId: scope.appId,
          setup: { state: "ready", operationRef: reference.operationRef },
        });
        expect(h.effects).toEqual([intent]);
        expect(
          h.requests
            .filter((request) => request.action === "prepare")
            .every((request) => request.approvalReference?.planDigest === reference.planDigest),
        ).toBe(true);
        expect(managedProductionDeliveryRequirements.get()).toEqual([
          {
            appId: scope.appId,
            repositoryId: scope.repositoryId,
            repositoryFullName: scope.repositoryFullName,
            operationRef: reference.operationRef,
          },
        ]);
      });
    },
  );

  it("keeps the protected legacy plan response readable by an unchanged strict client", async () => {
    const h = fixture();
    const response = await h.handler(
      new Request("https://operator.example/v1/repository-production", {
        method: "POST",
        headers: {
          authorization: "Bearer controlled-workload",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          version: 1,
          action: "plan",
          appId: scope.appId,
          sessionId: ownerContext.sessionId,
          ownerContext,
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(
      z
        .strictObject({ version: z.literal(1), plan: repositoryProductionApprovalInputSchema })
        .parse(await response.json()).plan.intent.storage,
    ).toEqual(initialIntent.storage);
    expect(h.effects).toEqual([]);
  });

  it("rejects malformed legacy release checksums before dispatch without interpreting them as a reference", async () => {
    await inContext(async () => {
      const h = fixture();
      const full = repositoryProductionApprovalInput(scope, initialIntent);
      if (full.intent.storage.kind !== "postgres") {
        throw new Error("Expected test storage");
      }
      const malformed = {
        ...full,
        intent: {
          ...full.intent,
          storage: { ...full.intent.storage, manifestSha256: manifestSha256.slice(1) },
        },
      };
      // SAFETY: Deliberately malformed external tool input exercises the runtime schema boundary.
      await expect(h.client.prepare(malformed)).rejects.toThrow();
      expect(h.fetch).not.toHaveBeenCalled();
      expect(h.workloadToken).not.toHaveBeenCalled();
      expect(h.effects).toEqual([]);
      const planned = await h.client.plan(scope.appId);
      h.approve(planned.nextCall.input);
      await expect(h.client.prepare(planned.nextCall.input)).resolves.toMatchObject({
        setup: { state: "ready" },
      });
      expect(h.effects).toEqual([initialIntent]);
    });
  });

  it.each([
    "manifest",
    "release",
    "environment",
    "role",
    "access",
    "recipient",
    "repository",
    "organization",
    "tenant",
  ] as const)("rejects a stale %s reference before any setup effect", async (changed) => {
    await inContext(async () => {
      const h = fixture();
      const { approvalReference } = await h.client.plan(scope.appId);
      h.approve(approvalReference);
      const intent = structuredClone(initialIntent);
      const nextScope = structuredClone(scope);
      if (intent.storage.kind !== "postgres") {
        throw new Error("Expected test storage");
      }
      if (changed === "manifest") {
        intent.storage.manifestSha256 = "c".repeat(64);
      }
      if (changed === "release") {
        intent.storage.releaseId = "notes-v2";
      }
      if (changed === "environment") {
        intent.storage.databaseEnvironment = "OTHER_DATABASE_URL";
      }
      if (changed === "role") {
        intent.creatorRoles = ["administrator"];
      }
      if (changed === "access") {
        intent.access = { mode: "private" };
      }
      if (changed === "recipient") {
        intent.creatorEmail = "other@example.com";
      }
      if (changed === "repository") {
        nextScope.repositoryId = "other-repository";
      }
      if (changed === "organization") {
        nextScope.organizationId = "other-organization";
      }
      if (changed === "tenant") {
        nextScope.authority.workspaceId = "other-workspace";
      }
      h.revise(intent, nextScope);
      await expect(h.client.prepare(approvalReference)).rejects.toThrow();
      expect(h.effects).toEqual([]);
    });
  });

  it("preserves the same setup reference for a code-only revision while executing the current captured intent", async () => {
    await inContext(async () => {
      const h = fixture();
      const first = await h.client.plan(scope.appId);
      h.approve(first.approvalReference);
      const revised = { ...initialIntent, sourceSha: "d".repeat(40) };
      h.revise(revised);
      const second = await h.client.plan(scope.appId);
      expect(second.approvalReference).toEqual(first.approvalReference);
      await h.client.prepare(first.approvalReference);
      expect(h.effects).toEqual([revised]);
    });
  });

  it("denies revoked owner and cancelled calls before setup", async () => {
    await inContext(async () => {
      const h = fixture();
      const { approvalReference } = await h.client.plan(scope.appId);
      h.approve(approvalReference);
      h.revoke();
      await expect(h.client.prepare(approvalReference)).rejects.toThrow();
      expect(h.effects).toEqual([]);
      h.controller.abort();
      const dispatched = h.requests.length;
      await expect(h.client.prepare(approvalReference)).rejects.toThrow();
      expect(h.requests).toHaveLength(dispatched);
      expect(h.effects).toEqual([]);
    });
  });
});
