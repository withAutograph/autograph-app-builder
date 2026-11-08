/* oxlint-disable eslint/require-await -- In-memory ports preserve asynchronous ownership and artifact-read rejection semantics. */
import { describe, expect, it, vi } from "vitest";
import type { AppDescription } from "../repository/app-description";
import type { RepositoryProductionRequestOwner } from "./repository-production-dispatcher";
import {
  initialRepositoryProductionRecord,
  repositoryProductionOperationRef,
} from "./repository-production-contract";
import type {
  RepositoryProductionIntent,
  RepositoryProductionRow,
  RepositoryProductionScope,
} from "./repository-production-contract";
import { repositoryProductionApprovalDigest } from "./repository-production-approval";
import {
  RepositoryProductionDestinationRequiredError,
  resolveRepositoryProductionDestination,
} from "./repository-production-destination";
import { GENERATED_RELEASE_MEMBERS } from "./hosted-operator-sandbox-launcher";
import type { GeneratedAppReleaseFiles } from "./hosted-operator-sandbox-launcher";
import { createRepositoryProductionManagementResolver } from "./repository-production-management-subject";
import type {
  ManagementProfile,
  ManagementResolverDependencies,
  RepositoryProductionCapture,
  RepositoryProductionManagementSubject,
} from "./repository-production-management-subject";

const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  ownerUserId: "creator",
  workspaceId: "workspace",
};
const owner: RepositoryProductionRequestOwner = {
  appId: "requests",
  sessionId: "original-session",
  ownerContext: {
    kind: "direct",
    authority,
    principal: { ...authority, scopes: ["autograph:send"] },
    sessionId: "original-session",
    adapterSessionId: "current-continuation",
    adapterGeneration: 2,
  },
};
const profile: ManagementProfile = {
  workspaceId: authority.workspaceId,
  repositoryId: "repository",
  repositoryFullName: "team/apps",
  projectId: "apps-project",
  organization: { id: "organization", name: "Dev" },
  publicOrigin: "https://apps.example",
};
const scope: RepositoryProductionScope = {
  authority,
  appId: owner.appId,
  repositoryId: profile.repositoryId,
  repositoryFullName: profile.repositoryFullName,
  projectId: profile.projectId,
  organizationId: profile.organization.id,
  publicOrigin: profile.publicOrigin,
  environment: "production",
};
const savedIntent: RepositoryProductionIntent = {
  sessionId: owner.sessionId,
  sourceSha: "a".repeat(40),
  creatorEmail: "creator@example.com",
  creatorRoles: ["reader"],
  storage: {
    kind: "postgres",
    artifactRef: `_protected-operator/artifacts/generated-release/requests/${"b".repeat(64)}`,
    releaseId: "requests-v1",
    manifestSha256: "c".repeat(64),
    databaseEnvironment: "REQUESTS_DATABASE_URL",
  },
};
const description = (persistent: boolean): AppDescription => ({
  version: 1,
  app: { id: owner.appId, routes: ["/requests"], workspacePath: "apps/requests" },
  backend: persistent
    ? {
        kind: "generated-postgres",
        authorization: "declared-policy",
        release: {
          id: "requests-v1",
          artifactHash: `sha256:${"d".repeat(64)}`,
          directory: "release",
        },
        roles: ["reader"],
        runtime: { databaseEnvironment: "REQUESTS_DATABASE_URL" },
        schemaReceipt: null,
      }
    : { kind: "static" },
  validation: { browser: null, check: { task: "check" }, test: null },
});
const approvedRow = (
  selectedScope = scope,
  intent: RepositoryProductionIntent = savedIntent,
): RepositoryProductionRow => {
  const record = initialRepositoryProductionRecord(selectedScope, structuredClone(intent));
  record.ownerContext = {
    ...owner.ownerContext,
    adapterSessionId: "prior-continuation",
    adapterGeneration: 1,
  };
  record.approval = {
    planDigest: repositoryProductionApprovalDigest(selectedScope, intent),
    approvedByCallId: "setup-call",
    approvalId: "setup-approval",
  };
  return { operationRef: repositoryProductionOperationRef(selectedScope), revision: 1, record };
};
const currentDestination = () =>
  resolveRepositoryProductionDestination({
    workspaceId: authority.workspaceId,
    appId: owner.appId,
    appSpecDigest: "e".repeat(64),
    repositories: [profile],
    // A newly accepted private build has no publication destination or acquired source.
  });
const fixture = (persistent = true) => {
  const intent: RepositoryProductionIntent = persistent
    ? structuredClone(savedIntent)
    : { ...savedIntent, creatorRoles: [], storage: { kind: "none" } };
  let row: RepositoryProductionRow | undefined = approvedRow(scope, intent);
  let ownerRevoked = false;
  const readSession = vi.fn(async (requested: RepositoryProductionRequestOwner) => {
    expect(requested).toEqual(owner);
    if (ownerRevoked) {
      throw new Error("live owner revoked");
    }
  });
  const resolveCurrent = vi.fn(
    async (): Promise<RepositoryProductionManagementSubject<ManagementProfile>> => {
      currentDestination();
      throw new Error("unreachable fixture destination");
    },
  );
  // SAFETY: This test enumerates the closed release member list. The injected readCapture
  // port represents the exact immutable artifact reader; it never compiles or copies an app.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Every required member is supplied once.
  const files = Object.fromEntries(
    GENERATED_RELEASE_MEMBERS.map((member) => [member, Buffer.from(`saved:${member}`)]),
  ) as GeneratedAppReleaseFiles;
  const capture: RepositoryProductionCapture = {
    artifactRef: savedIntent.storage.kind === "postgres" ? savedIntent.storage.artifactRef : "",
    description: description(true),
    files,
  };
  const readCapture = vi.fn<ManagementResolverDependencies<ManagementProfile>["readCapture"]>(
    async (_context, _storage, assertCurrentOwner) => {
      await assertCurrentOwner();
      return capture;
    },
  );
  const read = vi.fn<ManagementResolverDependencies<ManagementProfile>["store"]["read"]>(async () =>
    structuredClone(row),
  );
  const deps: ManagementResolverDependencies<ManagementProfile> = {
    repositories: [profile],
    readSession,
    store: { read },
    resolveCurrent,
    readCapture,
  };
  const currentSubject = (): RepositoryProductionManagementSubject<ManagementProfile> => ({
    owner,
    assertCurrentOwner: async () => {
      await readSession(owner);
    },
    scope,
    profile,
    intent: { ...intent, sourceSha: "f".repeat(40), creatorRoles: ["new-private-role"] },
    description: description(persistent),
    publishedDescription: true,
  });
  return {
    deps,
    capture,
    intent,
    readCapture,
    readSession,
    resolveCurrent,
    read,
    currentSubject,
    resolve: () => createRepositoryProductionManagementResolver(deps)(owner),
    getRow: () => {
      if (row === undefined) {
        throw new Error("fixture row missing");
      }
      return row;
    },
    setRow: (next: RepositoryProductionRow | undefined) => {
      row = next;
    },
    revokeOwner: () => {
      ownerRevoked = true;
    },
  };
};

describe("saved approved Production management subject", () => {
  it("reproduces the current private-build destination failure through the actual resolver", () => {
    expect(currentDestination).toThrow(RepositoryProductionDestinationRequiredError);
  });

  it("retains the exact approved artifact and roles while a newer private build has no destination", async () => {
    const f = fixture();
    const before = structuredClone(f.getRow());
    const subject = await f.resolve();
    expect(subject.scope).toEqual(scope);
    expect(subject.intent).toEqual(f.intent);
    expect(subject.profile).toEqual(profile);
    expect(subject.owner).toEqual(owner);
    expect(subject.capture).toEqual(f.capture);
    expect(subject.description).toEqual(f.capture.description);
    expect(f.readCapture).toHaveBeenCalledWith(
      { authority, target: { appId: owner.appId, sessionId: owner.sessionId } },
      f.intent.storage,
      expect.any(Function),
    );
    expect(f.resolveCurrent).not.toHaveBeenCalled();
    expect(f.getRow()).toEqual(before);
    await subject.assertCurrentOwner();
    f.revokeOwner();
    await expect(subject.assertCurrentOwner()).rejects.toThrow("live owner revoked");
  });

  it("does not turn diagnostic source revisions into a new management gate", async () => {
    const f = fixture();
    f.getRow().record.intent.sourceSha = "9".repeat(40);
    const subject = await f.resolve();
    expect(subject.intent.sourceSha).toBe("9".repeat(40));
    expect(subject.intent.creatorRoles).toEqual(["reader"]);
    expect(subject.capture?.artifactRef).toBe(f.capture.artifactRef);
  });

  it("supports persistent apps without business roles using their saved database", async () => {
    const f = fixture();
    f.setRow(approvedRow(scope, { ...savedIntent, creatorRoles: [] }));
    if (f.capture.description?.backend.kind === "generated-postgres") {
      f.capture.description.backend.roles = [];
    }
    const subject = await f.resolve();
    expect(subject.intent.creatorRoles).toEqual([]);
    expect(subject.intent.storage.kind).toBe("postgres");
    expect(subject.capture).toEqual(f.capture);
  });

  it("falls back to normal current planning only when no saved setup exists", async () => {
    const f = fixture();
    f.setRow(undefined);
    const current = f.currentSubject();
    f.resolveCurrent.mockResolvedValue(current);
    expect(await f.resolve()).toEqual(current);
    expect(f.readCapture).not.toHaveBeenCalled();
  });

  it("propagates the real destination failure when neither saved setup nor current publication exists", async () => {
    const f = fixture();
    f.setRow(undefined);
    await expect(f.resolve()).rejects.toBeInstanceOf(RepositoryProductionDestinationRequiredError);
    expect(f.readCapture).not.toHaveBeenCalled();
  });

  it("requires the current canonical owner before reading a saved artifact", async () => {
    const f = fixture();
    f.revokeOwner();
    await expect(f.resolve()).rejects.toThrow("live owner revoked");
    expect(f.readCapture).not.toHaveBeenCalled();
    expect(f.resolveCurrent).not.toHaveBeenCalled();
  });

  it("preserves cancellation or membership loss during the exact artifact read", async () => {
    const f = fixture();
    f.readCapture.mockImplementation(async (_context, _storage, assertCurrentOwner) => {
      f.revokeOwner();
      await assertCurrentOwner();
      return f.capture;
    });
    await expect(f.resolve()).rejects.toThrow("live owner revoked");
    expect(f.resolveCurrent).not.toHaveBeenCalled();
  });

  it.each([
    [
      "repository name",
      (row: RepositoryProductionRow) => {
        row.record.scope.repositoryFullName = "another/apps";
      },
    ],
    [
      "project",
      (row: RepositoryProductionRow) => {
        row.record.scope.projectId = "another-project";
      },
    ],
    [
      "organization",
      (row: RepositoryProductionRow) => {
        row.record.scope.organizationId = "another-org";
      },
    ],
    [
      "public origin",
      (row: RepositoryProductionRow) => {
        row.record.scope.publicOrigin = "https://another.example";
      },
    ],
    [
      "app",
      (row: RepositoryProductionRow) => {
        row.record.scope.appId = "other-app";
      },
    ],
    [
      "tenant",
      (row: RepositoryProductionRow) => {
        row.record.scope.authority.ownerUserId = "other-owner";
      },
    ],
    [
      "original session",
      (row: RepositoryProductionRow) => {
        row.record.intent.sessionId = "other-session";
      },
    ],
    [
      "saved owner session",
      (row: RepositoryProductionRow) => {
        if (row.record.ownerContext !== undefined) {
          row.record.ownerContext.sessionId = "other-session";
        }
      },
    ],
  ])(
    "refuses a saved setup for another %s even with a valid internal approval",
    async (_label, mutate) => {
      const f = fixture();
      const row = f.getRow();
      mutate(row);
      if (row.record.approval !== undefined) {
        row.record.approval.planDigest = repositoryProductionApprovalDigest(
          row.record.scope,
          row.record.intent,
        );
      }
      await expect(f.resolve()).rejects.toThrow();
      expect(f.readCapture).not.toHaveBeenCalled();
      expect(f.resolveCurrent).not.toHaveBeenCalled();
    },
  );

  it.each(["missing approval", "changed approved roles", "missing saved owner"])(
    "rejects %s without adopting the latest private intent",
    async (failure) => {
      const f = fixture();
      const row = f.getRow();
      if (failure === "missing approval") {
        delete row.record.approval;
      } else if (failure === "changed approved roles") {
        row.record.intent.creatorRoles = ["administrator"];
      } else {
        delete row.record.ownerContext;
      }
      await expect(f.resolve()).rejects.toThrow();
      expect(f.readCapture).not.toHaveBeenCalled();
      expect(f.resolveCurrent).not.toHaveBeenCalled();
    },
  );

  it("refuses two independently approved destinations instead of choosing the newest", async () => {
    const f = fixture();
    const second = { ...profile, repositoryId: "second", repositoryFullName: "team/second" };
    const secondScope = {
      ...scope,
      repositoryId: second.repositoryId,
      repositoryFullName: second.repositoryFullName,
    };
    f.deps.repositories = [profile, second];
    f.read.mockImplementation(async (requested) =>
      structuredClone(
        requested.repositoryId === second.repositoryId ? approvedRow(secondScope) : f.getRow(),
      ),
    );
    await expect(f.resolve()).rejects.toThrow();
    expect(f.readCapture).not.toHaveBeenCalled();
    expect(f.resolveCurrent).not.toHaveBeenCalled();
  });

  it("keeps frontend-only management available when the private draft has no published route", async () => {
    const f = fixture(false);
    const subject = await f.resolve();
    expect(subject.intent).toEqual(f.intent);
    expect(subject.intent.storage).toEqual({ kind: "none" });
    expect(subject).not.toHaveProperty("capture");
    expect(subject).not.toHaveProperty("description");
    expect(f.readCapture).not.toHaveBeenCalled();
    expect(f.getRow().record).not.toHaveProperty("resource");
  });

  it("retains a normal published frontend-only route without adopting its newer intent", async () => {
    const f = fixture(false);
    const current = f.currentSubject();
    f.resolveCurrent.mockResolvedValue(current);
    const subject = await f.resolve();
    expect(subject.description).toEqual(current.description);
    expect(subject.intent).toEqual(f.intent);
    expect(subject.intent.creatorRoles).toEqual([]);
    expect(subject).not.toHaveProperty("capture");
    expect(f.readCapture).not.toHaveBeenCalled();
  });

  it.each(["unpublished", "another app", "database-backed"])(
    "does not use the %s frontend routing hint",
    async (kind) => {
      const f = fixture(false);
      const hint = f.currentSubject();
      if (kind === "unpublished") {
        hint.publishedDescription = false;
      } else if (kind === "another app") {
        hint.scope = { ...scope, appId: "another-app" };
      } else {
        hint.intent = savedIntent;
        hint.description = description(true);
      }
      f.resolveCurrent.mockResolvedValue(hint);
      const subject = await f.resolve();
      expect(subject.intent).toEqual(f.intent);
      expect(subject).not.toHaveProperty("description");
      expect(f.readCapture).not.toHaveBeenCalled();
    },
  );

  it("does not hide authorization loss behind optional frontend routing", async () => {
    const f = fixture(false);
    f.resolveCurrent.mockRejectedValue(new Error("live owner revoked"));
    await expect(f.resolve()).rejects.toThrow("live owner revoked");
    expect(f.readCapture).not.toHaveBeenCalled();
  });
});
