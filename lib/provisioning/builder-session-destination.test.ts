import { describe, expect, it, vi } from "vitest";
import {
  InMemoryHostedEveStore,
  toDurableHostedSessionRecord,
  attachBuilderDestinationRecord,
  inheritRecoveryBuildDecision,
} from "../eve/hosted-store";
import { createBuilderSessionDestinationService } from "./builder-session-destination";
import { builderProvisionRequestDigest, initialBuilderProvisionResponse } from "./contracts";
import { initialBuilderProvisionJournalRecord } from "./journal";
import type { BuilderProvisionJournalRow } from "./journal";
import { executeBuilderProvisioning } from "./service";
import type { BuilderProvisioningDependencies } from "./service";
import type { BuilderProvisionRequest, BuilderProvisionResponse } from "./contracts";

const principal = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
  scopes: ["autograph:session"],
};
const sessionId = "saved-session";
const request = {
  version: 1 as const,
  operation: "vercel" as const,
  appName: "saved-app",
  deploymentAccess: "public-app" as const,
  repository: { name: "saved-app", private: true },
  providers: { vercelInstallationId: "installation" },
  requestId: "be05a1b9-92d0-4a16-832b-3309a5594244",
};
const expected = {
  adapterGeneration: 1,
  adapterSessionId: "saved-adapter",
  cancellationRevision: 0,
};
const destination = {
  appId: "saved-app",
  requestId: request.requestId,
  requestDigest: builderProvisionRequestDigest(request),
};
const session = () => ({
  ...toDurableHostedSessionRecord({
    version: 1,
    adapterSessionId: expected.adapterSessionId,
    sessionId,
    principal,
    status: "waiting",
    createdAtEpochMs: 1,
    updatedAtEpochMs: 1,
  }),
  appId: "saved-app",
});

const readSession = async (store: InMemoryHostedEveStore) => {
  const value = await store.getSession(principal, sessionId);
  if (value === null) {
    throw new Error("Expected saved session fixture");
  }
  return toDurableHostedSessionRecord(value);
};

const fixture = async () => {
  const sessions = new InMemoryHostedEveStore();
  const start = {
    version: 1 as const,
    clientRequestId: "start",
    operationId: "start-operation",
    kind: "start" as const,
    principal,
    requestDigest: `sha256:${"a".repeat(64)}`,
    state: "reserved" as const,
    createdAtEpochMs: 1,
    updatedAtEpochMs: 1,
  };
  await sessions.reserveOperation(principal, start);
  await sessions.settleSucceeded({
    principal,
    operationId: start.operationId,
    requestDigest: start.requestDigest,
    nowEpochMs: 1,
    session: session(),
    result: { sessionId, status: "waiting", events: [], cursor: 0 },
  });
  const rows = new Map<string, BuilderProvisionJournalRow>();
  const reserve = vi.fn(
    async (input: Parameters<BuilderProvisioningDependencies["journal"]["reserve"]>[0]) => {
      await Promise.resolve();
      const digest = builderProvisionRequestDigest(input.request);
      const prior = rows.get(input.request.requestId);
      if (prior !== undefined) {
        if (prior.requestDigest !== digest) {
          throw new Error("provision-request-id-reused");
        }
        return prior;
      }
      const row: BuilderProvisionJournalRow = {
        authority: input.authority,
        requestId: input.request.requestId,
        requestDigest: digest,
        record: initialBuilderProvisionJournalRecord(input.request, input.now),
        revision: 1,
        createdAt: input.now,
        updatedAt: input.now,
        state: "pending",
      };
      rows.set(row.requestId, row);
      return row;
    },
  );
  const journal: BuilderProvisioningDependencies["journal"] = {
    compareAndSet: async (input) => {
      const row = rows.get(input.requestId);
      if (row === undefined || row.revision !== input.expectedRevision) {
        await Promise.resolve();
        // oxlint-disable-next-line unicorn/no-useless-undefined -- A lost CAS returns the store's explicit absent result.
        return undefined;
      }
      const next = {
        ...row,
        revision: row.revision + 1,
        record: structuredClone(input.record),
        state: input.record.response.status,
        updatedAt: input.now,
      };
      rows.set(input.requestId, next);
      return await Promise.resolve(next);
    },
    read: async (input) => await Promise.resolve(rows.get(input.requestId)),
    reserve,
  };
  // The selected service delegates provider work unchanged; this fixture observes dispatch.
  const provisioning = { journal };
  const execute = vi.fn<
    (input: { request: BuilderProvisionRequest }) => Promise<BuilderProvisionResponse>
  >(async () => {
    const saved = await readSession(sessions);
    expect(saved.builderDestination).toEqual(destination);
    return initialBuilderProvisionResponse(request);
  });
  const assertMember = vi.fn(async () => {
    await Promise.resolve();
  });
  const readNativeTarget = vi.fn<
    Parameters<typeof createBuilderSessionDestinationService>[0]["readNativeTarget"]
  >(
    // oxlint-disable-next-line unicorn/no-useless-undefined -- This lookup intentionally has no native onboarding journal.
    () => Promise.resolve(undefined),
  );
  const service = createBuilderSessionDestinationService({
    assertMember,
    execute,
    provisioning,
    readNativeTarget,
    sessions,
  });
  return { assertMember, execute, journal, readNativeTarget, reserve, service, sessions, start };
};

describe("saved-session destination selection", () => {
  it("attaches the normal journal reference before provider work and reuses it after unknown outcome", async () => {
    const f = await fixture();
    f.execute.mockRejectedValueOnce(new Error("provider transport interrupted"));
    await expect(f.service.select({ expected, principal, request, sessionId })).rejects.toThrow(
      "interrupted",
    );
    const saved = await readSession(f.sessions);
    expect(saved.builderDestination).toEqual(destination);
    expect(saved.sourceHandoffId).toBeUndefined();
    expect(saved.adapterSessionId).toBe(expected.adapterSessionId);
    await f.service.select({ expected, principal, request, sessionId });
    expect(f.reserve).toHaveBeenCalledTimes(2);
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(f.execute.mock.calls[0]?.[0]?.request).toEqual(f.execute.mock.calls[1]?.[0]?.request);
  });

  it("refuses a different destination after reservation instead of creating another project", async () => {
    const f = await fixture();
    await f.service.select({ expected, principal, request, sessionId });
    await expect(
      f.service.select({
        principal,
        sessionId,
        expected,
        request: { ...request, requestId: "be05a1b9-92d0-4a16-832b-3309a5594245" },
      }),
    ).rejects.toThrow("already selected");
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it.each(["owner", "epoch", "cancel", "app"])(
    "denies stale or foreign %s before provider effects",
    async (kind) => {
      const f = await fixture();
      const who = kind === "owner" ? { ...principal, ownerUserId: "foreign" } : principal;
      const epoch = kind === "epoch" ? { ...expected, adapterGeneration: 2 } : expected;
      if (kind === "cancel") {
        await f.sessions.recordCancellationIntent({ principal, sessionId, nowEpochMs: 2 });
      }
      await expect(
        f.service.select({
          principal: who,
          sessionId,
          expected: epoch,
          request: kind === "app" ? { ...request, appName: "foreign-app" } : request,
        }),
      ).rejects.toThrow();
      expect(f.execute).not.toHaveBeenCalled();
    },
  );

  it("preserves an uncertain native response and refuses provisioning", async () => {
    const f = await fixture();
    const response = {
      ...f.start,
      kind: "respond" as const,
      sessionId,
      operationId: "uncertain-response",
      clientRequestId: "do-not-resend",
    };
    await f.sessions.reserveOperation(principal, response);
    await f.sessions.settleUnsuccessful({
      principal,
      operationId: response.operationId,
      requestDigest: response.requestDigest,
      state: "submission_unknown",
      safeErrorCode: "submission_unknown",
      nowEpochMs: 2,
    });
    await expect(f.service.select({ expected, principal, request, sessionId })).rejects.toThrow(
      "settled session operations",
    );
    const unknown = await f.sessions.getPrivateOperation(principal, response.operationId);
    expect(unknown?.state).toBe("submission_unknown");
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("inherits the selected reference through recovery without changing creation authority", () => {
    const source = attachBuilderDestinationRecord(session(), {
      expected,
      destination,
      nowEpochMs: 2,
    });
    const child = {
      ...session(),
      sessionId: "recovered-child",
      adapterSessionId: "new-adapter",
      adapterGeneration: 2,
    };
    const inherited = toDurableHostedSessionRecord(
      inheritRecoveryBuildDecision(source, session(), child),
    );
    expect(inherited.builderDestination).toEqual(destination);
    expect(inherited.sourceHandoffId).toBeUndefined();
    expect(inherited.sessionId).toBe("recovered-child");
  });
});

it("rechecks the saved epoch after real credential I/O before the Vercel POST", async () => {
  const f = await fixture();
  const never = async (): Promise<never> => {
    await Promise.resolve();
    throw new Error("Unexpected unused GitHub adapter");
  };
  const credential = vi.fn(async () => {
    await f.sessions.recordCancellationIntent({ principal, sessionId, nowEpochMs: Date.now() });
    return {
      binding: {
        active: true,
        installationId: "installation",
        scopeType: "team" as const,
        scopeId: "team",
        slug: "team",
        displayName: "Team",
        plan: "pro",
        updatedAt: new Date(),
      },
      token: "synthetic-test-token",
    };
  });
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => await Promise.resolve(Response.json({}, { status: 404 })),
  );
  const dependencies: BuilderProvisioningDependencies = {
    journal: f.journal,
    githubInstallations: { bind: never, read: never },
    githubCredentials: { bind: never, deactivate: never, read: never, rotate: never },
    githubConfig: {
      appId: "1",
      clientId: "unused",
      clientSecret: "unused-synthetic-secret",
      privateKey: "unused",
    },
    vercelConfig: {
      clientId: "unused",
      clientSecret: "unused",
      issuer: "https://builder.example/auth",
      resource: "https://builder.example/mcp",
      slug: "test",
      tokenKey: Buffer.alloc(32),
      tokenKeyVersion: "test",
    },
    readVercelCredential: credential,
    deactivateVercelInstallation: never,
    fetch,
  };
  const service = createBuilderSessionDestinationService({
    sessions: f.sessions,
    provisioning: dependencies,
    execute: executeBuilderProvisioning,
    assertMember: f.assertMember,
    // oxlint-disable-next-line unicorn/no-useless-undefined -- No legacy onboarding is present in this cancellation fixture.
    readNativeTarget: () => Promise.resolve(undefined),
  });
  const result = await service.select({ expected, principal, request, sessionId });
  expect(credential).toHaveBeenCalledOnce();
  expect(result.provisioning.vercel.status).toBe("failed");
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  const saved = await readSession(f.sessions);
  expect(saved.builderDestination).toEqual(destination);
  expect(saved.cancellationRevision).toBe(1);
});

it.each(["creating", "unknown", "ready"] as const)(
  "preserves a legacy %s operation without reserving or dispatching a second destination",
  async (stage) => {
    const f = await fixture();
    f.readNativeTarget.mockResolvedValue({ record: { stage } });
    await expect(f.service.select({ expected, principal, request, sessionId })).rejects.toThrow(
      "Reconcile",
    );
    expect(f.reserve).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    const saved = await readSession(f.sessions);
    expect(saved.builderDestination).toBeUndefined();
  },
);

it.each(["creating", "unknown", "ready"] as const)(
  "blocks provider dispatch if a legacy %s attempt starts after the initial read",
  async (stage) => {
    const f = await fixture();
    f.readNativeTarget
      // oxlint-disable-next-line unicorn/no-useless-undefined -- The first lookup deliberately observes an absent native journal.
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ record: { stage } });
    await expect(f.service.select({ expected, principal, request, sessionId })).rejects.toThrow(
      "Reconcile",
    );
    expect(f.execute).not.toHaveBeenCalled();
    const saved = await readSession(f.sessions);
    expect(saved.builderDestination).toEqual(destination);
  },
);
