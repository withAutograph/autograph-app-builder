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
  scopes: ["autograph:session"],
  workspaceId: "workspace",
};
const sessionId = "saved-session";
const request = {
  appName: "saved-app",
  deploymentAccess: "public-app" as const,
  operation: "vercel" as const,
  providers: { vercelInstallationId: "installation" },
  repository: { name: "saved-app", private: true },
  requestId: "be05a1b9-92d0-4a16-832b-3309a5594244",
  version: 1 as const,
};
const expected = {
  adapterGeneration: 1,
  adapterSessionId: "saved-adapter",
  cancellationRevision: 0,
};
const destination = {
  appId: "saved-app",
  requestDigest: builderProvisionRequestDigest(request),
  requestId: request.requestId,
};
const session = () => ({
  ...toDurableHostedSessionRecord({
    adapterSessionId: expected.adapterSessionId,
    createdAtEpochMs: 1,
    principal,
    sessionId,
    status: "waiting",
    updatedAtEpochMs: 1,
    version: 1,
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
    clientRequestId: "start",
    createdAtEpochMs: 1,
    kind: "start" as const,
    operationId: "start-operation",
    principal,
    requestDigest: `sha256:${"a".repeat(64)}`,
    state: "reserved" as const,
    updatedAtEpochMs: 1,
    version: 1 as const,
  };
  await sessions.reserveOperation(principal, start);
  await sessions.settleSucceeded({
    nowEpochMs: 1,
    operationId: start.operationId,
    principal,
    requestDigest: start.requestDigest,
    result: { cursor: 0, events: [], sessionId, status: "waiting" },
    session: session(),
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
        createdAt: input.now,
        record: initialBuilderProvisionJournalRecord(input.request, input.now),
        requestDigest: digest,
        requestId: input.request.requestId,
        revision: 1,
        state: "pending",
        updatedAt: input.now,
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
        record: structuredClone(input.record),
        revision: row.revision + 1,
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
    async () => undefined,
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
        expected,
        principal,
        request: { ...request, requestId: "be05a1b9-92d0-4a16-832b-3309a5594245" },
        sessionId,
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
        await f.sessions.recordCancellationIntent({ nowEpochMs: 2, principal, sessionId });
      }
      await expect(
        f.service.select({
          expected: epoch,
          principal: who,
          request: kind === "app" ? { ...request, appName: "foreign-app" } : request,
          sessionId,
        }),
      ).rejects.toThrow();
      expect(f.execute).not.toHaveBeenCalled();
    },
  );

  it("preserves an uncertain native response and refuses provisioning", async () => {
    const f = await fixture();
    const response = {
      ...f.start,
      clientRequestId: "do-not-resend",
      kind: "respond" as const,
      operationId: "uncertain-response",
      sessionId,
    };
    await f.sessions.reserveOperation(principal, response);
    await f.sessions.settleUnsuccessful({
      nowEpochMs: 2,
      operationId: response.operationId,
      principal,
      requestDigest: response.requestDigest,
      safeErrorCode: "submission_unknown",
      state: "submission_unknown",
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
      destination,
      expected,
      nowEpochMs: 2,
    });
    const child = {
      ...session(),
      adapterGeneration: 2,
      adapterSessionId: "new-adapter",
      sessionId: "recovered-child",
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
    await f.sessions.recordCancellationIntent({ nowEpochMs: Date.now(), principal, sessionId });
    return {
      binding: {
        active: true,
        displayName: "Team",
        installationId: "installation",
        plan: "pro",
        scopeId: "team",
        scopeType: "team" as const,
        slug: "team",
        updatedAt: new Date(),
      },
      token: "synthetic-test-token",
    };
  });
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => await Promise.resolve(Response.json({}, { status: 404 })),
  );
  const dependencies: BuilderProvisioningDependencies = {
    deactivateVercelInstallation: never,
    fetch,
    githubConfig: {
      appId: "1",
      clientId: "unused",
      clientSecret: "unused-synthetic-secret",
      privateKey: "unused",
    },
    githubCredentials: { bind: never, deactivate: never, read: never, rotate: never },
    githubInstallations: { bind: never, read: never },
    journal: f.journal,
    readVercelCredential: credential,
    vercelConfig: {
      clientId: "unused",
      clientSecret: "unused",
      issuer: "https://builder.example/auth",
      resource: "https://builder.example/mcp",
      slug: "test",
      tokenKey: Buffer.alloc(32),
      tokenKeyVersion: "test",
    },
  };
  const service = createBuilderSessionDestinationService({
    sessions: f.sessions,
    provisioning: dependencies,
    execute: executeBuilderProvisioning,
    assertMember: f.assertMember,
    // oxlint-disable-next-line unicorn/no-useless-undefined -- No legacy onboarding is present in this cancellation fixture.
    readNativeTarget: async () => undefined,
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
