/* oxlint-disable eslint/require-await -- In-memory ports implement asynchronous durable I/O. */
import { describe, expect, it, vi } from "vitest";
import { realmIdentityNonceSha256 } from "./hosted-operator-auth-identity";
import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import {
  observeRealmContinuationRecord,
  realmContinuationDispatchId,
} from "./hosted-operator-realm-continuation";
import type { RealmContinuationObservation } from "./hosted-operator-realm-continuation";
import { createHostedOperatorRealmIdentityWait } from "./hosted-operator-realm-identity-wait";
import type { HostedRuntimeIdentityWaitRegistration } from "./hosted-operator-realm-identity-wait";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import type {
  HostedRuntimeJournalRow,
  HostedRuntimeJournalRecord,
  HostedRuntimeJournalStore,
} from "./hosted-runtime-journal";
import type { HostedOperatorContext } from "./hosted-operator-service";

interface OptionalJournalRow {
  row?: HostedRuntimeJournalRow;
}

const requireFixture = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("Expected fixture value is missing.");
  }
  return value;
};
const nonce = "e".repeat(64);
const token = "private-workflow-hook-capability";
const key = Buffer.alloc(32, 13);
const authority = {
  issuer: "https://builder.test/api/auth",
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
const initialObservation: RealmContinuationObservation = {
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
  publicGateway: { branch: "preview", origin: "https://auth.test", projectId: "gateway-project" },
  gatewayBindings: {
    authBrowserOrigin: "https://auth.test",
    builderCallbackOrigin: "https://builder.test",
    catalogAppIds: ["app"],
    operatorOrigin: "https://operator.test",
    sourceWorkload: {
      audience: "https://vercel.test",
      environment: "preview",
      issuer: "https://oidc.vercel.com/team",
      ownerId: "team",
      projectId: "operator-project",
      subject: "operator-workload",
    },
  },
  deploymentBoundary: {
    authority,
    teamId: "team",
    app: { branch: "preview", environment: "preview", projectId: "project" },
    gateway: { branch: "preview", environment: "preview", projectId: "gateway-project" },
    operator: {
      deploymentId: "operator-deployment",
      environment: "preview",
      projectId: "operator-project",
    },
    verification: {
      gatewayOrigin: "https://gateway.test",
      jwksUrl: "https://gateway.test/_platform/jwks.json",
      publicOrigin: "https://auth.test",
    },
  },
  cost: { class: "independent-service", description: "fixture", owner: "fixture" },
  effects: [
    { description: "resource", id: "resource", kind: "resources" },
    { description: "install", id: "install", kind: "install" },
    { description: "access", id: "access", kind: "access" },
    { description: "bindings", id: "bindings", kind: "bindings" },
    { description: "gateway bindings", id: "gateway-bindings", kind: "gateway-bindings" },
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
    operationRef: initialObservation.operationRef,
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
      nonceSha256: realmIdentityNonceSha256(nonce),
      expiresAt: "2026-10-16T00:00:00.000Z",
    },
  },
});

const fixture = () => {
  let row: HostedRuntimeJournalRow = { revision: 1, record: initialRecord() };
  let clock = Date.parse("2026-10-15T00:00:00.000Z");
  const read = vi.fn<HostedRuntimeJournalStore["read"]>(async () => structuredClone(row));
  const compareAndSet = vi.fn<HostedRuntimeJournalStore["compareAndSet"]>(async (input) => {
    if (input.expectedRevision !== row.revision) {
      const missing: OptionalJournalRow = {};
      return missing.row;
    }
    row = {
      revision: row.revision + 1,
      record: hostedRuntimeJournalRecordSchema.parse(structuredClone(input.record)),
    };
    return structuredClone(row);
  });
  const store: HostedRuntimeJournalStore = {
    read,
    compareAndSet,
    reserveFenceGeneration: vi.fn<HostedRuntimeJournalStore["reserveFenceGeneration"]>(async () => {
      throw new Error("Identity wait cannot allocate another approval fence.");
    }),
    reserve: vi.fn<HostedRuntimeJournalStore["reserve"]>(async () => {
      throw new Error("Registration cannot reserve new operator work.");
    }),
  };
  const assertAuthorized = vi.fn(async (candidate: HostedOperatorContext) => {
    if (
      JSON.stringify(candidate.authority) !== JSON.stringify(context.authority) ||
      candidate.ownerContext?.principal.ownerUserId !== authority.ownerUserId ||
      candidate.ownerContext?.sessionId !== context.target.sessionId ||
      candidate.target.sessionId !== context.target.sessionId
    ) {
      throw new Error("Owner authorization denied.");
    }
  });
  const observe = vi.fn(async (candidate: HostedOperatorContext) =>
    observeRealmContinuationRecord({
      context: candidate,
      record: structuredClone(row.record),
      initiator: initialObservation.initiator,
      now: clock,
    }),
  );
  const run = createHostedOperatorRealmIdentityWait({
    store,
    config: { tokenKey: key, tokenKeyVersion: "wait-v1" },
    assertAuthorized,
    observe,
    now: () => clock,
  });
  const link = requireFixture(row.record.operator?.identityLink);
  const url = new URL("/api/auth/platform/operator-link", link.browserOrigin);
  for (const [name, value] of Object.entries({
    nonce,
    ownerSessionId: link.ownerSessionId,
    bootstrapPlanDigest: link.bootstrapPlanDigest,
    authResourceId: link.authResourceId,
  })) {
    url.searchParams.set(name, value);
  }
  const registration: HostedRuntimeIdentityWaitRegistration = {
    adapterSessionId: "native-session",
    callId: "approved-workflow-call",
    token,
    identityInput: { browserUrl: url.href, expiresAt: link.expiresAt },
    input: {
      ...plan.selection,
      operationRef: initialObservation.operationRef,
      planDigest: operatorPlanDigest(plan),
      plan,
    },
  };
  const mutate = (change: (record: HostedRuntimeJournalRecord) => void) => {
    change(row.record);
    row.revision += 1;
  };
  const consume = () => {
    mutate((record) => {
      Object.assign(requireFixture(record.operator?.identityLink), {
        consumedAt: "2026-10-15T00:01:00.000Z",
        proofRef: "private-canonical-proof",
        proofSha256: "c".repeat(64),
      });
    });
  };
  return {
    run,
    registration,
    read,
    compareAndSet,
    assertAuthorized,
    observe,
    store,
    mutate,
    consume,
    row: () => structuredClone(row),
    setTime: (time: string) => {
      clock = Date.parse(time);
    },
  };
};

describe("approved Realm identity wait registration", () => {
  it("encrypts the hook under the existing approved operation without returning a public capability", async () => {
    const f = fixture();
    const before = f.row().record;
    const state = await f.run.register(context, f.registration);
    expect(state).toMatchObject({ status: "waiting" });
    expect(JSON.stringify(state)).not.toContain(token);
    const after = f.row().record;
    const wait = after.realmIdentityWait;
    expect(wait).toMatchObject({
      adapterSessionId: f.registration.adapterSessionId,
      approvedPlanDigest: f.registration.input.planDigest,
      callId: f.registration.callId,
      nonceSha256: realmIdentityNonceSha256(nonce),
      operationRef: f.registration.input.operationRef,
      hook: { keyVersion: "wait-v1" },
    });
    expect(wait?.hook.encryptedToken).not.toBe(token);
    expect(JSON.stringify(after)).not.toContain(token);
    const rest = structuredClone(after);
    delete rest.realmIdentityWait;
    expect(rest).toEqual(before);
    expect(f.store.reserve).not.toHaveBeenCalled();
    expect(f.assertAuthorized).toHaveBeenCalledWith(context);
    expect(f.observe).toHaveBeenCalled();
  });

  it("uses the protected server clock for the next check instead of the browser link expiry", async () => {
    const f = fixture();
    const state = await f.run.register(context, f.registration);
    expect(state).toEqual({ status: "waiting", checkAfter: "2026-10-15T00:00:05.000Z" });
    f.setTime("2026-10-15T00:02:00.000Z");
    const replayed = await f.run.register(context, f.registration);
    expect(replayed).toEqual({ status: "waiting", checkAfter: "2026-10-15T00:02:05.000Z" });
    expect(f.row().record.operator?.identityLink?.expiresAt).toBe(
      f.registration.identityInput.expiresAt,
    );
    expect(f.compareAndSet).toHaveBeenCalledOnce();
  });

  it("replays the same hook without replacing encrypted state or writing another registration", async () => {
    const f = fixture();
    await f.run.register(context, f.registration);
    const registered = f.row();
    f.setTime("2026-10-15T00:02:00.000Z");
    expect(await f.run.register(context, f.registration)).toMatchObject({ status: "waiting" });
    expect(f.row()).toEqual(registered);
    expect(f.compareAndSet).toHaveBeenCalledOnce();
  });

  it.each(["token", "callId"] as const)(
    "denies a second %s for the already registered nonce",
    async (field) => {
      const f = fixture();
      await f.run.register(context, f.registration);
      const before = f.row();
      await expect(
        f.run.register(context, { ...f.registration, [field]: "foreign" }),
      ).rejects.toThrow("authorization");
      expect(f.row()).toEqual(before);
      expect(f.compareAndSet).toHaveBeenCalledOnce();
    },
  );

  it.each(["operation", "digest", "plan", "app", "branch", "project", "adapter", "call"])(
    "denies changed %s invocation coordinates before storing a hook",
    async (variant) => {
      const f = fixture();
      const changed = structuredClone(f.registration);
      if (variant === "operation") {
        changed.input.operationRef = "22222222-2222-4222-8222-222222222222";
      }
      if (variant === "digest") {
        changed.input.planDigest = "d".repeat(64);
      }
      if (variant === "plan") {
        changed.input.plan = { ...changed.input.plan, contextId: "foreign-context" };
      }
      if (variant === "app") {
        changed.input.appId = "foreign-app";
      }
      if (variant === "branch") {
        changed.input.branch = "foreign-branch";
      }
      if (variant === "project") {
        changed.input.projectId = "foreign-project";
      }
      if (variant === "adapter") {
        changed.adapterSessionId = "foreign-native-session";
      }
      if (variant === "call") {
        changed.callId = "";
      }
      await expect(f.run.register(context, changed)).rejects.toThrow("authorization");
      expect(f.compareAndSet).not.toHaveBeenCalled();
    },
  );

  it.each([
    "origin",
    "path",
    "nonce",
    "ownerSessionId",
    "bootstrapPlanDigest",
    "authResourceId",
    "organizationId",
    "expiry",
  ])("denies a registration with a foreign %s challenge", async (variant) => {
    const f = fixture();
    const changed = structuredClone(f.registration);
    const url = new URL(changed.identityInput.browserUrl);
    if (variant === "origin") {
      url.hostname = "foreign.test";
    } else if (variant === "path") {
      url.pathname = "/other";
    } else if (variant === "expiry") {
      changed.identityInput.expiresAt = "2027-01-01T00:00:00.000Z";
    } else {
      url.searchParams.set(variant, variant === "nonce" ? "f".repeat(64) : "foreign");
    }
    changed.identityInput.browserUrl = url.href;
    await expect(f.run.register(context, changed)).rejects.toThrow("authorization");
    expect(f.compareAndSet).not.toHaveBeenCalled();
  });

  it("checks current owner authorization before observing or storing another owner's hook", async () => {
    const f = fixture();
    const foreign = { ...context, authority: { ...authority, ownerUserId: "another-owner" } };
    await expect(f.run.register(foreign, f.registration)).rejects.toThrow("authorization");
    expect(f.observe).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.compareAndSet).not.toHaveBeenCalled();
  });

  it("reports a real concurrent registration failure without overwriting the winning record", async () => {
    const f = fixture();
    const missing: OptionalJournalRow = {};
    f.compareAndSet.mockResolvedValueOnce(missing.row);
    await expect(f.run.register(context, f.registration)).rejects.toThrow("operation");
    expect(f.row().record.realmIdentityWait).toBeUndefined();
  });
});

describe("canonical identity event delivery and acknowledgment", () => {
  it("classifies actual consumed proof and acknowledges only its canonical event", async () => {
    const f = fixture();
    await f.run.register(context, f.registration);
    expect(await f.run.delivery(context)).toBeUndefined();
    f.consume();
    const observation = await f.observe(context);
    const eventId = realmContinuationDispatchId(requireFixture(observation));
    expect(await f.run.delivery(context)).toEqual({ token, eventId, observed: false });
    const result = await f.run.acknowledge(context, { ...f.registration, eventId });
    expect(result).toEqual({ status: "consumed", eventId });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain("private-canonical-proof");
    expect(f.row().record.realmIdentityWait?.eventId).toBe(eventId);
    expect(f.row().record.realmIdentityWait?.observedAt).toBeDefined();
    expect(await f.run.delivery(context)).toEqual({ token, eventId, observed: true });
    const acknowledged = f.row().record.realmIdentityWait?.observedAt;
    f.setTime("2026-10-15T01:00:00.000Z");
    await f.run.acknowledge(context, { ...f.registration, eventId });
    expect(f.row().record.realmIdentityWait?.observedAt).toBe(acknowledged);
  });

  it("reports actual expiry without claiming proof exists", async () => {
    const f = fixture();
    await f.run.register(context, f.registration);
    f.setTime("2026-10-17T00:00:00.000Z");
    const delivery = await f.run.delivery(context);
    expect(delivery).toMatchObject({ token, observed: false });
    const result = await f.run.acknowledge(context, {
      ...f.registration,
      eventId: requireFixture(delivery).eventId,
    });
    expect(result).toEqual({ status: "expired", eventId: delivery?.eventId });
    expect(f.row().record.operator?.identityLink?.proofRef).toBeUndefined();
    expect(f.row().record.operator?.identityLink?.consumedAt).toBeUndefined();
  });

  it("retains consumed proof classification after its original link expires", async () => {
    const f = fixture();
    f.consume();
    f.setTime("2026-10-17T00:00:00.000Z");
    const state = await f.run.register(context, f.registration);
    expect(state.status).toBe("consumed");
  });

  it("does not treat incomplete proof metadata as consumed identity", async () => {
    const f = fixture();
    f.mutate((record) => {
      Object.assign(requireFixture(record.operator?.identityLink), {
        consumedAt: "2026-10-15T00:01:00.000Z",
        proofRef: "incomplete-proof",
      });
    });
    await expect(f.run.register(context, f.registration)).rejects.toThrow("atomic");
    expect(f.row().record.realmIdentityWait).toBeUndefined();
  });

  it("rejects a forged event without changing canonical authority or approval", async () => {
    const f = fixture();
    await f.run.register(context, f.registration);
    f.consume();
    const before = f.row();
    await expect(
      f.run.acknowledge(context, { ...f.registration, eventId: "0".repeat(64) }),
    ).rejects.toThrow("authorization");
    expect(f.row()).toEqual(before);
  });

  it("rereads proof before acknowledging an earlier consumed notification", async () => {
    const f = fixture();
    await f.run.register(context, f.registration);
    f.consume();
    const delivery = await f.run.delivery(context);
    f.mutate((record) => {
      const link = requireFixture(record.operator?.identityLink);
      delete link.consumedAt;
      delete link.proofRef;
      delete link.proofSha256;
    });
    await expect(
      f.run.acknowledge(context, { ...f.registration, eventId: requireFixture(delivery).eventId }),
    ).rejects.toThrow("authorization");
    expect(f.row().record.realmIdentityWait?.observedAt).toBeUndefined();
  });

  it("rereads expiry before acknowledging an earlier expired notification", async () => {
    const f = fixture();
    await f.run.register(context, f.registration);
    f.setTime("2026-10-17T00:00:00.000Z");
    const delivery = await f.run.delivery(context);
    f.setTime("2026-10-15T00:00:00.000Z");
    await expect(
      f.run.acknowledge(context, { ...f.registration, eventId: requireFixture(delivery).eventId }),
    ).rejects.toThrow("authorization");
    expect(f.row().record.realmIdentityWait?.observedAt).toBeUndefined();
  });

  it("denies a foreign invocation and leaves the registered wait untouched", async () => {
    const f = fixture();
    await f.run.register(context, f.registration);
    f.consume();
    const delivery = await f.run.delivery(context);
    const before = f.row();
    await expect(
      f.run.acknowledge(context, {
        ...f.registration,
        callId: "another-call",
        eventId: requireFixture(delivery).eventId,
      }),
    ).rejects.toThrow("authorization");
    expect(f.row()).toEqual(before);
  });

  it("rechecks current owner authorization before releasing or acknowledging a registered hook", async () => {
    const f = fixture();
    await f.run.register(context, f.registration);
    f.consume();
    const delivery = await f.run.delivery(context);
    const before = f.row();
    f.assertAuthorized.mockRejectedValue(new Error("Owner authorization revoked."));
    await expect(f.run.delivery(context)).rejects.toThrow("authorization");
    await expect(
      f.run.acknowledge(context, { ...f.registration, eventId: requireFixture(delivery).eventId }),
    ).rejects.toThrow("authorization");
    expect(f.row()).toEqual(before);
  });

  it("does not create an acknowledgment for an invocation that never registered a wait", async () => {
    const f = fixture();
    f.consume();
    const observation = await f.observe(context);
    await expect(
      f.run.acknowledge(context, {
        ...f.registration,
        eventId: realmContinuationDispatchId(requireFixture(observation)),
      }),
    ).rejects.toThrow("authorization");
    expect(f.row().record.realmIdentityWait).toBeUndefined();
    expect(f.compareAndSet).not.toHaveBeenCalled();
  });

  it("binds the encrypted capability to its stored invocation coordinates", async () => {
    const f = fixture();
    await f.run.register(context, f.registration);
    f.consume();
    f.mutate((record) => {
      requireFixture(record.realmIdentityWait).callId = "altered-after-encryption";
    });
    await expect(f.run.delivery(context)).rejects.toThrow();
  });

  it("does not release a hook registered for a different adapter session", async () => {
    const f = fixture();
    await f.run.register(context, f.registration);
    f.consume();
    f.mutate((record) => {
      requireFixture(record.realmIdentityWait).adapterSessionId = "foreign-native-session";
    });
    expect(await f.run.delivery(context)).toBeUndefined();
  });

  it.each(["operation", "proof"])(
    "rechecks canonical %s after a journal change during acknowledgment",
    async (variant) => {
      const f = fixture();
      await f.run.register(context, f.registration);
      f.consume();
      const delivery = await f.run.delivery(context);
      f.read
        .mockImplementationOnce(async () => f.row())
        .mockImplementationOnce(async () => {
          f.mutate((record) => {
            if (variant === "operation") {
              requireFixture(record.operator).operationRef = "22222222-2222-4222-8222-222222222222";
            } else {
              const link = requireFixture(record.operator?.identityLink);
              delete link.consumedAt;
              delete link.proofRef;
              delete link.proofSha256;
            }
          });
          return f.row();
        });
      await expect(
        f.run.acknowledge(context, {
          ...f.registration,
          eventId: requireFixture(delivery).eventId,
        }),
      ).rejects.toThrow("authorization");
      expect(f.row().record.realmIdentityWait?.observedAt).toBeUndefined();
    },
  );
});
