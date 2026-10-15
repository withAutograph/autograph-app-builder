/* oxlint-disable eslint/require-await -- In-memory ports implement asynchronous durable I/O. */
import { realmIdentityNonceSha256 } from "./hosted-operator-auth-identity";
import { describe, expect, it, vi } from "vitest";
import {
  createHostedOperatorRealmContinuation,
  observeRealmContinuationRecord,
  realmContinuationDispatchId,
  isRealmContinuationTechnicalWait,
} from "./hosted-operator-realm-continuation";
import type {
  RealmContinuationObservation,
  RealmContinuationPorts,
} from "./hosted-operator-realm-continuation";
import type { HostedRuntimeJournalRow, HostedRuntimeJournalRecord } from "./hosted-runtime-journal";
import type { HostedOperatorContext } from "./hosted-operator-service";
import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";

const authority = {
  issuer: "https://builder.test",
  audience: "https://builder.test/mcp",
  workspaceId: "workspace",
  ownerUserId: "owner",
};
const principal = { ...authority, scopes: ["autograph:start", "autograph:get"] };
const context: HostedOperatorContext = {
  authority,
  target: {
    appId: "app",
    sessionId: "public-session",
    branch: "preview",
    environment: "preview",
    installationId: "installation",
    projectId: "project",
    scopeId: "team",
    scopeType: "team",
  },
  ownerContext: {
    kind: "direct",
    authority,
    principal,
    adapterGeneration: 1,
    adapterSessionId: "native-session",
    sessionId: "public-session",
  },
};
const observed: RealmContinuationObservation = {
  authority,
  appId: "app",
  ownerSessionId: "public-session",
  adapterSessionId: "native-session",
  operationRef: "11111111-1111-4111-8111-111111111111",
  approvedPlanDigest: "a".repeat(64),
  nonceSha256: "b".repeat(64),
  reason: { kind: "consumed-proof", proofRef: "private-proof", proofSha256: "c".repeat(64) },
  initiator: {
    authenticator: "mcp-oauth-jwks",
    issuer: authority.issuer,
    principalId: "owner",
    principalType: "user",
    subject: "owner",
    attributes: {
      "mcp:audience": authority.audience,
      "mcp:workspace-id": "workspace",
      "mcp:scopes": principal.scopes,
    },
  },
};
const plan = hostedOperatorPlanSchema.parse({
  access: [],
  action: "prepare",
  appDatabase: {
    database: "app_db",
    migratorRole: "app_migrator",
    resourceId: "app-resource",
    runtimeRole: "app_runtime",
  },
  authDatabase: {
    database: "auth_db",
    migratorRole: "auth_migrator",
    resourceId: "auth-resource",
    runtimeRole: "auth_runtime",
  },
  authSchema: {
    artifactRef: "auth-frame",
    installer: { reference: "auth-installer", sha256: "f".repeat(64) },
    planDigest: "a".repeat(64),
    targetDigest: "b".repeat(64),
  },
  contextId: "fixture-context",
  cost: { class: "independent-service", description: "fixture", owner: "fixture" },
  effects: [
    { description: "resource", id: "resource", kind: "resources" },
    { description: "install", id: "install", kind: "install" },
    { description: "access", id: "access", kind: "access" },
    { description: "bindings", id: "bindings", kind: "bindings" },
  ],
  installer: { reference: "app-installer", sha256: "e".repeat(64) },
  neon: {
    branchId: "branch",
    connectionRef: "private",
    endpoint: "ep-fixture.neon.tech",
    projectId: "project",
    source: "synthetic-only",
  },
  release: { artifactRef: "release", id: "v19", sha256: "d".repeat(64) },
  retention: { expiresAt: "2027-01-01T00:00:00Z", policy: "fixture" },
  selection: {
    appId: "app",
    branch: "preview",
    environment: "preview",
    projectId: "project",
    sessionId: "public-session",
  },
  version: 1,
});

const initialRecord = (): HostedRuntimeJournalRecord => ({
  kind: "app-runtime",
  version: 1,
  approvedByCallId: "approval-call",
  status: "pending",
  step: "reserved",
  request: context.target,
  operator: {
    mode: "protected-operator-v1",
    plan,
    planDigest: operatorPlanDigest(plan),
    operationRef: observed.operationRef,
    receipts: [],
    identityLink: {
      audience: "https://builder.test",
      authResourceId: "auth-resource",
      bootstrapPlanDigest: operatorPlanDigest(plan),
      browserOrigin: "https://auth.test",
      endpointOrigin: "https://gateway.test",
      issuer: "https://auth.test",
      organizationId: null,
      ownerSessionId: "public-session",
      nonceSha256: observed.nonceSha256,
      expiresAt: "2026-10-14T00:00:00.000Z",
    },
  },
});

const fixture = () => {
  // The dispatcher only changes its private sibling; full plan parsing belongs to the canonical observer.
  let row: HostedRuntimeJournalRow = {
    revision: 1,
    record: initialRecord(),
  };
  const dispatch = vi.fn<RealmContinuationPorts["dispatch"]>(async (request) => ({
    version: 1,
    dispatchId: request.dispatchId,
    adapterSessionId: "native-session",
    status: "accepted",
  }));
  const reconcile = vi.fn<RealmContinuationPorts["reconcile"]>(async (request) => ({
    version: 1,
    dispatchId: request.dispatchId,
    adapterSessionId: "native-session",
    status: "unknown",
  }));
  const observe = vi.fn<RealmContinuationPorts["observe"]>(async () => structuredClone(observed));
  const ports: RealmContinuationPorts = {
    now: () => 1_800_000_000_000,
    observe,
    dispatch,
    reconcile,
    seal: () => "private-encrypted-authority",
    store: {
      read: async () => structuredClone(row),
      // oxlint-disable-next-line unicorn/no-useless-undefined -- CAS misses intentionally return undefined as the store interface specifies.
      compareAndSet: async (input): Promise<HostedRuntimeJournalRow | undefined> => {
        if (input.expectedRevision !== row.revision) {
          return undefined;
        }
        row = { record: structuredClone(input.record), revision: row.revision + 1 };
        return structuredClone(row);
      },
    },
  };
  return {
    ports,
    dispatch,
    reconcile,
    observe,
    row: () => row,
    run: createHostedOperatorRealmContinuation(ports),
  };
};

describe("Realm continuation durable dispatcher", () => {
  it("claims before delivery and persists acknowledgement without replay", async () => {
    const f = fixture();
    f.dispatch.mockImplementation(async (request) => {
      expect(f.row().record.realmContinuation?.status).toBe("claimed");
      return {
        version: 1,
        dispatchId: request.dispatchId,
        adapterSessionId: "native-session",
        status: "accepted",
      };
    });
    expect(await f.run(context)).toBe("accepted");
    expect(await f.run(context)).toBe("accepted");
    expect(f.row().record.realmContinuation?.acceptedAt).toBeDefined();
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it("reconciles unknown acknowledgement without submitting another message", async () => {
    const f = fixture();
    f.dispatch.mockRejectedValue(new Error("connection lost after native acceptance"));
    expect(await f.run(context)).toBe("unknown");
    f.reconcile.mockImplementation(async (request) => ({
      version: 1,
      dispatchId: request.dispatchId,
      adapterSessionId: "native-session",
      status: "accepted",
    }));
    expect(await f.run(context)).toBe("accepted");
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.reconcile).toHaveBeenCalledOnce();
  });
  it("retries the same logical identity only after definitive native non-submission", async () => {
    const f = fixture();
    f.dispatch.mockRejectedValueOnce(new Error("crash before native receiver"));
    await f.run(context);
    f.reconcile.mockImplementation(async (request) => ({
      version: 1,
      dispatchId: request.dispatchId,
      adapterSessionId: "native-session",
      status: "not-submitted",
    }));
    expect(await f.run(context)).toBe("accepted");
    expect(f.dispatch.mock.calls[0]?.[0].dispatchId).toBe(f.dispatch.mock.calls[1]?.[0].dispatchId);
  });
  it("keeps a receiver-claimed uncertain delivery unknown", async () => {
    const f = fixture();
    f.dispatch.mockRejectedValue(new Error("interrupted send"));
    await f.run(context);
    expect(await f.run(context)).toBe("unknown");
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it("allows only one first delivery under concurrent claims", async () => {
    const f = fixture();
    await Promise.all([f.run(context), f.run(context)]);
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it("rejects foreign native receipts and changed canonical authority", async () => {
    const f = fixture();
    f.dispatch.mockImplementation(async (request) => ({
      version: 1,
      dispatchId: request.dispatchId,
      adapterSessionId: "foreign-session",
      status: "accepted",
    }));
    await expect(f.run(context)).rejects.toThrow("authorization");
    f.observe.mockRejectedValue(new Error("owner revoked"));
    await expect(f.run(context)).rejects.toThrow("owner revoked");
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it("preserves receiver claim metadata when checkpointing an acknowledgement", async () => {
    const f = fixture();
    f.dispatch.mockImplementation(async (request) => {
      const row = f.row();
      if (row.record.realmContinuation) {
        row.record.realmContinuation.receiverClaimedAt = "2026-10-15T00:00:00.000Z";
      }
      return {
        version: 1,
        dispatchId: request.dispatchId,
        adapterSessionId: "native-session",
        status: "accepted",
      };
    });
    await f.run(context);
    expect(f.row().record.realmContinuation?.receiverClaimedAt).toBeDefined();
  });
});

describe("Realm continuation observation", () => {
  const record = () => initialRecord();
  it("reports expired links truthfully without inventing proof capture", () => {
    const result = observeRealmContinuationRecord({
      context,
      record: record(),
      initiator: observed.initiator,
      now: Date.parse("2026-10-15"),
    });
    expect(result?.reason).toEqual({
      kind: "expired-technical-wait",
      expiresAt: "2026-10-14T00:00:00.000Z",
    });
  });
  it("retains real consumed proof provenance even after the link expires", () => {
    const value = record();
    Object.assign(value.operator?.identityLink ?? {}, {
      consumedAt: "2026-10-13T00:00:00.000Z",
      proofRef: "private-proof",
      proofSha256: "c".repeat(64),
    });
    expect(
      observeRealmContinuationRecord({
        context,
        record: value,
        initiator: observed.initiator,
        now: Date.parse("2026-10-15"),
      })?.reason.kind,
    ).toBe("consumed-proof");
  });
  it("rejects a replaced owner, operation digest or session", () => {
    const value = record();
    if (value.operator) {
      value.operator.planDigest = "d".repeat(64);
    }
    expect(() =>
      observeRealmContinuationRecord({
        context,
        record: value,
        initiator: observed.initiator,
        now: Date.now(),
      }),
    ).toThrow("authorization");
    expect(realmContinuationDispatchId({ ...observed, nonceSha256: "d".repeat(64) })).not.toBe(
      realmContinuationDispatchId(observed),
    );
  });
});

describe("Exact obsolete technical question guard", () => {
  const setup = () => {
    const record = initialRecord();
    const nonce = "e".repeat(64);
    const link = record.operator?.identityLink;
    if (link === undefined) {
      throw new Error("fixture missing identity link");
    }
    link.nonceSha256 = realmIdentityNonceSha256(nonce);
    const url = new URL("/api/auth/platform/operator-link", link.browserOrigin);
    for (const [key, value] of Object.entries({
      nonce,
      ownerSessionId: link.ownerSessionId,
      bootstrapPlanDigest: link.bootstrapPlanDigest,
      authResourceId: link.authResourceId,
    })) {
      url.searchParams.set(key, value);
    }
    const action = {
      kind: "tool-call",
      toolName: "prepare-app-hosted-runtime",
      callId: record.approvedByCallId,
      input: {
        ...plan.selection,
        operationRef: observed.operationRef,
        planDigest: operatorPlanDigest(plan),
        plan,
      },
    };
    return {
      record,
      url,
      request: {
        kind: "question",
        requestId: "original-request",
        action,
        prompt: `Any localized wording [link](${url.href})`,
      },
    };
  };
  it("binds structured tool operation and frozen challenge independent of wording", () => {
    const f = setup();
    expect(isRealmContinuationTechnicalWait(f.record, f.request)).toBe(true);
    expect(isRealmContinuationTechnicalWait(f.record, { ...f.request, prompt: f.url.href })).toBe(
      true,
    );
    expect(
      isRealmContinuationTechnicalWait(f.record, {
        ...f.request,
        action: { ...f.request.action, toolName: "product-question" },
      }),
    ).toBe(false);
    expect(
      isRealmContinuationTechnicalWait(f.record, {
        ...f.request,
        action: {
          ...f.request.action,
          input: { ...f.request.action.input, operationRef: "foreign-operation" },
        },
      }),
    ).toBe(false);
  });
  it("uses exact retained call and challenge when legacy action input is absent", () => {
    const f = setup();
    const { input, ...action } = f.request.action;
    void input;
    expect(isRealmContinuationTechnicalWait(f.record, { ...f.request, action })).toBe(true);
    expect(
      isRealmContinuationTechnicalWait(f.record, {
        ...f.request,
        action: { ...action, callId: "foreign-call" },
      }),
    ).toBe(false);
  });
  it("rejects foreign sessions while allowing repeated copies of the same challenge", () => {
    const f = setup();
    f.url.searchParams.set("ownerSessionId", "other-owner-session");
    expect(isRealmContinuationTechnicalWait(f.record, { ...f.request, prompt: f.url.href })).toBe(
      false,
    );
    expect(
      isRealmContinuationTechnicalWait(f.record, {
        ...f.request,
        prompt: `${f.request.prompt} ${f.request.prompt}`,
      }),
    ).toBe(true);
  });
});
