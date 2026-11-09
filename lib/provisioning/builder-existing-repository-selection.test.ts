import { recordRepositoryAccessReceipt } from "../agent/repository-access-state";
import { describe, expect, it, vi } from "vitest";
import { createExistingRepositoryDestinationSelector } from "./builder-existing-repository-selection";
import {
  InMemoryHostedEveStore,
  attachBuilderDestinationRecord,
  inheritRecoveryBuildDecision,
  toDurableHostedSessionRecord,
} from "../eve/hosted-store";
import type { ReadyRepositoryAccess } from "../integrations/repository-access";
import { resolveExistingBuilderDestinationReference } from "./builder-existing-destination";

const principal = {
  issuer: "https://builder.example/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace",
  ownerUserId: "creator",
  scopes: ["autograph:session"],
};
const expected = { adapterSessionId: "adapter", adapterGeneration: 1, cancellationRevision: 0 };
const session = () => ({
  ...toDurableHostedSessionRecord({
    version: 1,
    principal,
    sessionId: "saved",
    adapterSessionId: "adapter",
    status: "waiting",
    createdAtEpochMs: 1,
    updatedAtEpochMs: 1,
  }),
  appId: "notes",
});
const destination = {
  kind: "existing-repository" as const,
  version: 1 as const,
  appId: "notes",
  repository: { repositoryId: "123", owner: "team", name: "apps", defaultBranch: "main" },
  installationId: "456",
  confirmedByCallId: "verified",
};
const access: ReadyRepositoryAccess = {
  status: "ready",
  accessDigest: "a".repeat(64),
  repository: {
    ...destination.repository,
    archived: false,
    visibility: "private",
    headSha: "b".repeat(40),
    headTree: "c".repeat(40),
    repositoryVariableNames: [],
  },
  scope: { accountLogin: "team", accountType: "Organization", installationId: "456" },
};
const fixture = async (status: "waiting" | "working" = "waiting") => {
  const sessions = new InMemoryHostedEveStore();
  const operation = {
    version: 1 as const,
    clientRequestId: "start",
    operationId: "start",
    kind: "start" as const,
    principal,
    requestDigest: `sha256:${"d".repeat(64)}`,
    state: "reserved" as const,
    createdAtEpochMs: 1,
    updatedAtEpochMs: 1,
  };
  await sessions.reserveOperation(principal, operation);
  await sessions.settleSucceeded({
    principal,
    operationId: "start",
    requestDigest: operation.requestDigest,
    nowEpochMs: 1,
    session: { ...session(), status },
    result: { sessionId: "saved", status, events: [], cursor: 0 },
  });
  const classify = vi.fn().mockResolvedValue(access);
  const assertMember = vi.fn(async () => {
    await Promise.resolve();
  });
  return {
    sessions,
    classify,
    select: createExistingRepositoryDestinationSelector({ sessions, classify, assertMember }),
  };
};
const readSaved = async (sessions: InMemoryHostedEveStore) => {
  const saved = await sessions.getSession(principal, "saved");
  if (saved === null) {
    throw new Error("Expected saved session");
  }
  return toDurableHostedSessionRecord(saved);
};
const request = {
  principal,
  sessionId: "saved",
  expected,
  repository: "https://github.com/team/apps",
};

describe("existing repository destination", () => {
  it("persists only server-resolved identity without a provisioning journal and survives recovery", async () => {
    const f = await fixture();
    await expect(f.select(request)).resolves.toMatchObject({ status: "ready" });
    const saved = await readSaved(f.sessions);
    expect(saved.builderDestination).toMatchObject({
      ...destination,
      confirmedByCallId: "destination:saved",
    });
    await f.select(request);
    const child = inheritRecoveryBuildDecision(saved, saved, {
      ...session(),
      sessionId: "child",
      adapterSessionId: "new-adapter",
      adapterGeneration: 2,
    });
    expect(toDurableHostedSessionRecord(child).builderDestination).toEqual(
      saved.builderDestination,
    );
    await expect(
      resolveExistingBuilderDestinationReference({
        session: saved,
        authority: principal,
        appId: "notes",
      }),
    ).resolves.toEqual(saved.builderDestination);
    f.classify.mockResolvedValue({
      ...access,
      repository: { ...access.repository, repositoryId: "999", name: "other" },
    });
    await expect(f.select({ ...request, repository: "team/other" })).rejects.toThrow(
      "already selected",
    );
  });
  it("leaves the saved build untouched when GitHub access is missing", async () => {
    const f = await fixture();
    f.classify.mockResolvedValue({
      status: "authorization-required",
      action: "update",
      repository: { owner: "team", name: "apps", fullName: "team/apps" },
      scopes: [],
    });
    const result = await f.select(request);
    expect(result.status).toBe("pending");
    expect("connectionUrl" in result && result.connectionUrl?.includes("returnTo=")).toBe(true);
    const unchanged = await readSaved(f.sessions);
    expect(unchanged.builderDestination).toBeUndefined();
  });
  it("does not attach a destination through another owner or stale epoch", async () => {
    const f = await fixture();
    await expect(
      f.select({ ...request, principal: { ...principal, ownerUserId: "foreign" } }),
    ).rejects.toThrow("unavailable");
    await expect(
      f.select({ ...request, expected: { ...expected, adapterGeneration: 2 } }),
    ).rejects.toThrow("stale");
  });
  it("recovers an authenticated acquired repository without requiring per-app resource creation", async () => {
    const source = recordRepositoryAccessReceipt({
      // oxlint-disable-next-line unicorn/no-useless-undefined, sonarjs/no-undefined-assignment -- The receipt constructor explicitly accepts an absent previous observation.
      current: undefined,
      sessionId: "adapter",
      confirmedByCallId: "source",
      access,
    });
    const saved = {
      ...session(),
      privateBuildDecision: {
        adapterSessionId: "adapter",
        existingRepositorySource: source,
        decision: "settled" as const,
        turnId: "turn",
        turnSequence: 1,
        version: 1 as const,
        workflowPhase: "reviewed",
      },
    };
    await expect(
      resolveExistingBuilderDestinationReference({
        session: saved,
        authority: principal,
        appId: "notes",
      }),
    ).resolves.toMatchObject({ ...destination, confirmedByCallId: "source" });
    await expect(
      resolveExistingBuilderDestinationReference({
        session: saved,
        authority: { ...principal, workspaceId: "foreign" },
        appId: "notes",
      }),
    ).rejects.toMatchObject({ code: "authorization_required" });
    await expect(
      resolveExistingBuilderDestinationReference({
        session: {
          ...saved,
          privateBuildDecision: {
            ...saved.privateBuildDecision,
            existingRepositorySource: { ...source, sessionId: "foreign" },
          },
        },
        authority: principal,
        appId: "notes",
      }),
    ).rejects.toMatchObject({ code: "builder_destination_configuration_required" });
  });
  it("rechecks cancellation after GitHub access completes before saving the selection", async () => {
    const f = await fixture();
    f.classify.mockImplementationOnce(async () => {
      await f.sessions.recordCancellationIntent({ principal, sessionId: "saved", nowEpochMs: 2 });
      return access;
    });
    await expect(f.select(request)).rejects.toThrow("stale");
    const unchanged = await readSaved(f.sessions);
    expect(unchanged.builderDestination).toBeUndefined();
  });
  it("atomically attaches active metadata and refuses cancellation or unsettled requests", async () => {
    const f = await fixture("working");
    await f.sessions.attachBuilderDestination({
      principal,
      sessionId: "saved",
      expected,
      destination,
      activeBuild: true,
      nowEpochMs: 2,
    });
    const attached = await readSaved(f.sessions);
    expect(attached.builderDestination).toEqual(destination);
    await f.sessions.recordCancellationIntent({ principal, sessionId: "saved", nowEpochMs: 3 });
    await expect(
      f.sessions.attachBuilderDestination({
        principal,
        sessionId: "saved",
        expected,
        destination,
        activeBuild: true,
        nowEpochMs: 4,
      }),
    ).rejects.toThrow("stale");
    const pending = await fixture("working");
    await pending.sessions.reserveOperation(principal, {
      version: 1,
      kind: "send",
      clientRequestId: "pending",
      operationId: "pending",
      principal,
      requestDigest: `sha256:${"f".repeat(64)}`,
      state: "reserved",
      sessionId: "saved",
      createdAtEpochMs: 2,
      updatedAtEpochMs: 2,
    });
    await expect(
      pending.sessions.attachBuilderDestination({
        principal,
        sessionId: "saved",
        expected,
        destination,
        activeBuild: true,
        nowEpochMs: 3,
      }),
    ).rejects.toThrow("settled");
    const unchanged = await readSaved(pending.sessions);
    expect(unchanged.builderDestination).toBeUndefined();
  });
  it("permits authenticated active-build metadata but rejects stale, stopped and legacy active attachment", () => {
    const active = { ...session(), status: "working" as const };
    expect(
      attachBuilderDestinationRecord(active, {
        expected,
        destination,
        activeBuild: true,
        nowEpochMs: 2,
      }).builderDestination,
    ).toEqual(destination);
    expect(() =>
      attachBuilderDestinationRecord(active, { expected, destination, nowEpochMs: 2 }),
    ).toThrow("stale");
    expect(() =>
      attachBuilderDestinationRecord(
        { ...active, status: "cancelled" },
        { expected, destination, activeBuild: true, nowEpochMs: 2 },
      ),
    ).toThrow("stale");
    expect(() =>
      attachBuilderDestinationRecord(active, {
        expected: { ...expected, adapterGeneration: 2 },
        destination,
        activeBuild: true,
        nowEpochMs: 2,
      }),
    ).toThrow("stale");
    expect(() =>
      attachBuilderDestinationRecord(active, {
        expected,
        destination: {
          appId: "notes",
          requestId: "11111111-1111-4111-a111-111111111111",
          requestDigest: "e".repeat(64),
        },
        activeBuild: true,
        nowEpochMs: 2,
      }),
    ).toThrow("stale");
  });
});
