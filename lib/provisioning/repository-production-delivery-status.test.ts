/* oxlint-disable eslint/require-await -- Controlled asynchronous readers preserve production rejection semantics. */
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { HostedOperatorError } from "./hosted-operator-contract";
import { repositoryProductionApprovalDigest } from "./repository-production-approval";
import {
  initialRepositoryProductionRecord,
  repositoryProductionOperationRef,
} from "./repository-production-contract";
import type {
  RepositoryProductionIntent,
  RepositoryProductionRow,
  RepositoryProductionScope,
} from "./repository-production-contract";
import { createRepositoryProductionDeliveryStatus } from "./repository-production-delivery-status";
import { repositoryProductionDeliveryStatusSchema } from "./repository-production-delivery";
import { resolveRepositoryProductionDestination } from "./repository-production-destination";
import type { RepositoryProductionRequestOwner } from "./repository-production-dispatcher";

const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  ownerUserId: "creator",
  workspaceId: "workspace",
};
const owner: RepositoryProductionRequestOwner = {
  appId: "notes",
  sessionId: "session",
  ownerContext: {
    kind: "direct",
    authority,
    principal: { ...authority, scopes: ["autograph:send"] },
    sessionId: "session",
    adapterSessionId: "adapter",
    adapterGeneration: 1,
  },
};
const target = { repositoryId: "123", repositoryFullName: "team/apps" };
const profile = {
  ...target,
  workspaceId: authority.workspaceId,
  projectId: "project",
  publicOrigin: "https://apps.example",
  organization: { id: "organization", name: "Dev" },
};
const scope: RepositoryProductionScope = {
  ...target,
  authority,
  appId: owner.appId,
  environment: "production",
  organizationId: profile.organization.id,
  projectId: profile.projectId,
  publicOrigin: profile.publicOrigin,
};
const intent: RepositoryProductionIntent = {
  sessionId: owner.sessionId,
  sourceSha: "a".repeat(40),
  creatorRoles: ["member"],
  storage: {
    kind: "postgres",
    artifactRef: "artifact",
    releaseId: "notes-v1",
    manifestSha256: "b".repeat(64),
    databaseEnvironment: "NOTES_DATABASE_URL",
  },
};
interface DeliveryFixtureState {
  row?: RepositoryProductionRow;
}

const fixture = (currentOwner = owner) => {
  const current = {
    scope: structuredClone(scope),
    intent: { ...structuredClone(intent), sessionId: currentOwner.sessionId },
    publishedDescription: true,
  };
  const record = initialRepositoryProductionRecord(scope, intent);
  record.ownerContext = structuredClone(owner.ownerContext);
  record.approval = {
    approvalId: "approval",
    approvedByCallId: "call",
    planDigest: repositoryProductionApprovalDigest(scope, intent),
  };
  for (const effect of [
    "allocate-storage",
    "install-schema",
    "creator-access",
    "bind-runtime",
  ] as const) {
    record.effects[effect] = { state: "applied" };
  }
  const saved: DeliveryFixtureState = {
    row: { operationRef: repositoryProductionOperationRef(scope), revision: 1, record },
  };
  const deps = {
    repositories: [profile],
    readSession: vi.fn(async (requested: RepositoryProductionRequestOwner) => {
      if (
        requested.appId !== currentOwner.appId ||
        requested.sessionId !== currentOwner.sessionId ||
        !isDeepStrictEqual(requested.ownerContext, currentOwner.ownerContext)
      ) {
        throw new HostedOperatorError("authorization_required");
      }
    }),
    resolveCurrent: vi.fn(async () => structuredClone(current)),
    store: { read: vi.fn(async () => structuredClone(saved.row)) },
    isRuntimeBindingReady: vi.fn(() => true),
  };
  return {
    current,
    deps,
    record,
    saved,
    read: createRepositoryProductionDeliveryStatus(deps),
  };
};

const revision = () => {
  const currentOwner = {
    ...owner,
    sessionId: "revision",
    ownerContext: { ...owner.ownerContext, sessionId: "revision", adapterSessionId: "revision" },
  };
  const f = fixture(currentOwner);
  const reviewedHeadSha = "e".repeat(40);
  f.current.intent.sourceSha = reviewedHeadSha;
  if (f.current.intent.storage.kind === "postgres") {
    f.current.intent.storage.artifactRef = "revision-artifact";
  }
  return { ...f, currentOwner, target: { ...target, reviewedHeadSha } };
};

describe("read-only managed Production delivery status", () => {
  it("reuses completed setup for an equivalent published app revision in a new session", async () => {
    const f = revision();
    const before = structuredClone(f.saved.row);
    expect(await f.read(f.currentOwner, f.target)).toMatchObject({
      ...target,
      appId: owner.appId,
      applicable: true,
      preparationRequired: false,
      state: "ready",
      operationRef: before?.operationRef,
    });
    expect(f.saved.row).toEqual(before);
    expect(f.deps.readSession).toHaveBeenCalledTimes(2);
  });

  it("requires the exact published GitHub head before a revision can reuse setup", async () => {
    const f = revision();
    await expect(f.read(f.currentOwner, target)).rejects.toMatchObject({
      code: "authorization_required",
    });
    await expect(
      f.read(f.currentOwner, { ...f.target, reviewedHeadSha: "f".repeat(40) }),
    ).rejects.toMatchObject({ code: "authorization_required" });
    f.current.publishedDescription = false;
    await expect(f.read(f.currentOwner, f.target)).rejects.toMatchObject({
      code: "authorization_required",
    });
    expect(f.deps.isRuntimeBindingReady).not.toHaveBeenCalled();
  });

  it.each(
    Object.entries({
      approval(f) {
        delete f.record.approval;
      },
      owner(f) {
        f.record.ownerContext = {
          ...owner.ownerContext,
          authority: { ...authority, ownerUserId: "other-owner" },
        };
      },
      session(f) {
        f.record.ownerContext = { ...owner.ownerContext, sessionId: "different-setup-session" };
      },
      schema(f) {
        if (f.current.intent.storage.kind === "postgres") {
          f.current.intent.storage.manifestSha256 = "f".repeat(64);
        }
      },
      role(f) {
        f.current.intent.creatorRoles = ["editor"];
      },
      account(f) {
        f.current.intent.creatorEmail = "different@example.com";
      },
      access(f) {
        f.current.intent.access = {
          mode: "self-signup",
          eligibility: "public",
          appRoles: ["member"],
        };
      },
      organization(f) {
        f.current.scope.organizationId = "other-organization";
      },
      pending(f) {
        f.record.effects["install-schema"] = { state: "pending", attemptId: "attempt" };
      },
      "runtime binding"(f) {
        f.deps.isRuntimeBindingReady.mockReturnValue(false);
      },
    } satisfies Record<string, (fixture: ReturnType<typeof revision>) => void>),
  )("does not reuse cross-session setup with changed %s", async (_kind, change) => {
    const f = revision();
    change(f);
    await expect(f.read(f.currentOwner, f.target)).rejects.toThrow();
  });

  it("reports the same ready setup across a code-only source revision", async () => {
    const f = fixture();
    f.current.intent.sourceSha = "c".repeat(40);
    const before = structuredClone(f.saved.row);
    expect(await f.read(owner, target)).toMatchObject({
      ...target,
      appId: owner.appId,
      applicable: true,
      preparationRequired: false,
      state: "ready",
    });
    expect(f.saved.row).toEqual(before);
    expect(f.deps.isRuntimeBindingReady).toHaveBeenCalledOnce();
  });

  it("recognizes fresh-template publication into a managed existing repository", async () => {
    const f = fixture();
    delete f.saved.row;
    f.current.intent.storage = { kind: "none" };
    f.current.intent.creatorRoles = [];
    f.deps.resolveCurrent.mockImplementation(async () => {
      const destination = resolveRepositoryProductionDestination({
        appId: owner.appId,
        appSpecDigest: "a".repeat(64),
        workspaceId: authority.workspaceId,
        repositories: [profile],
        destination: {
          version: 1,
          appId: owner.appId,
          appSpecDigest: "a".repeat(64),
          publishedSource: {
            repositoryId: target.repositoryId,
            branch: "builder/notes",
            changeSetDigest: "b".repeat(64),
            reviewDigest: "c".repeat(64),
            gitSha: "d".repeat(40),
            gitTree: "e".repeat(40),
          },
        },
      });
      return { ...f.current, intent: { ...f.current.intent, sourceSha: destination.sourceSha } };
    });
    expect(await f.read(owner, target)).toMatchObject({
      applicable: true,
      preparationRequired: true,
      state: "checking-access",
    });
    expect(f.deps.isRuntimeBindingReady).not.toHaveBeenCalled();
  });

  it("returns unmanaged only after successful canonical-owner/configured-destination lookup", async () => {
    const f = fixture();
    const other = { repositoryId: "456", repositoryFullName: "team/generic" };
    expect(await f.read(owner, other)).toEqual({
      version: 1,
      appId: owner.appId,
      ...other,
      applicable: false,
    });
    expect(f.deps.readSession).toHaveBeenCalledTimes(2);
    expect(f.deps.resolveCurrent).not.toHaveBeenCalled();
    expect(f.deps.store.read).not.toHaveBeenCalled();
  });

  it.each(["app", "owner", "session"] as const)(
    "rejects the wrong %s before configuration disclosure",
    async (kind) => {
      const f = fixture();
      const changed = structuredClone(owner);
      if (kind === "app") {
        changed.appId = "other-app";
      } else if (kind === "session") {
        changed.sessionId = "other-session";
      } else {
        changed.ownerContext.authority.ownerUserId = "other-owner";
      }
      await expect(f.read(changed, target)).rejects.toMatchObject({
        code: "authorization_required",
      });
      expect(f.deps.resolveCurrent).not.toHaveBeenCalled();
      expect(f.deps.store.read).not.toHaveBeenCalled();
    },
  );

  it.each(["scope", "session", "saved-scope", "saved-owner"] as const)(
    "rejects mismatched current or saved %s",
    async (kind) => {
      const f = fixture();
      if (kind === "scope") {
        f.current.scope.repositoryFullName = "other/apps";
      } else if (kind === "session") {
        f.current.intent.sessionId = "other-session";
      } else if (kind === "saved-scope") {
        f.record.scope.repositoryId = "789";
      } else {
        f.record.ownerContext = { ...owner.ownerContext, sessionId: "other-session" };
      }
      await expect(f.read(owner, target)).rejects.toThrow();
      expect(f.deps.isRuntimeBindingReady).not.toHaveBeenCalled();
    },
  );

  it.each(["source", "journal", "owner-recheck"] as const)(
    "does not classify an unavailable %s as unmanaged",
    async (kind) => {
      const f = fixture();
      const failure = new Error("controlled unavailable");
      if (kind === "source") {
        f.deps.resolveCurrent.mockRejectedValue(failure);
      } else if (kind === "journal") {
        f.deps.store.read.mockRejectedValue(failure);
      } else {
        f.deps.readSession.mockRejectedValue(failure).mockImplementationOnce(async () => {});
      }
      await expect(f.read(owner, target)).rejects.toBe(failure);
    },
  );

  it.each(["none", "postgres"] as const)(
    "requests initial setup without reserving a journal for %s storage",
    async (kind) => {
      const f = fixture();
      delete f.saved.row;
      if (kind === "none") {
        f.current.intent.storage = { kind: "none" };
      }
      expect(await f.read(owner, target)).toMatchObject({
        applicable: true,
        preparationRequired: true,
        state: kind === "none" ? "checking-access" : "setting-up-data",
      });
      expect(f.saved.row).toBeUndefined();
      expect(f.deps.isRuntimeBindingReady).not.toHaveBeenCalled();
    },
  );

  it.each([
    "allocate-storage",
    "install-schema",
    "creator-access",
    "bind-runtime",
    "signup-policy",
  ] as const)("reports an in-flight %s without restarting setup", async (effect) => {
    const f = fixture();
    f.record.effects[effect] = { state: "pending", attemptId: "attempt" };
    expect(await f.read(owner, target)).toMatchObject({
      applicable: true,
      preparationRequired: false,
      state: "reconciling",
    });
    expect(f.deps.isRuntimeBindingReady).not.toHaveBeenCalled();
  });

  it("keeps incomplete creator access pending without launching Auth to infer an identity state", async () => {
    const f = fixture();
    f.record.effects["creator-access"] = { state: "idle" };
    expect(await f.read(owner, target)).toMatchObject({
      applicable: true,
      preparationRequired: false,
      state: "checking-access",
    });
    expect(f.deps.isRuntimeBindingReady).not.toHaveBeenCalled();
  });

  it.each(["appAccessUpgrade", "creatorRoleUpdate"] as const)(
    "keeps pending %s reconciliation on its original setup",
    async (update) => {
      const f = fixture();
      if (update === "appAccessUpgrade") {
        f.record.appAccessUpgrade = { commandId: "upgrade", state: "pending" };
      } else {
        f.record.creatorRoleUpdate = { commandId: "roles", roles: ["editor"], state: "pending" };
      }
      expect(await f.read(owner, target)).toMatchObject({
        applicable: true,
        preparationRequired: false,
        state: "reconciling",
      });
      expect(f.deps.isRuntimeBindingReady).not.toHaveBeenCalled();
    },
  );

  it.each(["schema", "roles", "access"] as const)(
    "requires normal setup for changed %s effects instead of trusting an old ready journal",
    async (kind) => {
      const f = fixture();
      if (kind === "schema" && f.current.intent.storage.kind === "postgres") {
        f.current.intent.storage.manifestSha256 = "f".repeat(64);
      } else if (kind === "roles") {
        f.current.intent.creatorRoles = ["editor"];
      } else {
        f.current.intent.access = {
          mode: "self-signup",
          eligibility: "public",
          appRoles: ["member"],
        };
        f.current.intent.entryPath = "/notes";
      }
      expect(await f.read(owner, target)).toMatchObject({
        applicable: true,
        preparationRequired: true,
        state: "reconciling",
      });
      expect(f.deps.isRuntimeBindingReady).not.toHaveBeenCalled();
    },
  );

  it("requests the existing runtime-boundary repair when complete legacy metadata is absent", async () => {
    const f = fixture();
    f.deps.isRuntimeBindingReady.mockReturnValue(false);
    expect(await f.read(owner, target)).toMatchObject({
      applicable: true,
      preparationRequired: true,
      state: "checking-access",
    });
  });

  it("does not require a database receipt for a completed frontend-only app", async () => {
    const f = fixture();
    f.current.intent.storage = { kind: "none" };
    f.record.intent.storage = { kind: "none" };
    f.record.approval = {
      approvalId: "frontend-approval",
      approvedByCallId: "frontend-call",
      planDigest: repositoryProductionApprovalDigest(scope, f.record.intent),
    };
    expect(await f.read(owner, target)).toMatchObject({
      applicable: true,
      preparationRequired: false,
      state: "ready",
    });
    expect(f.deps.isRuntimeBindingReady).not.toHaveBeenCalled();
  });

  it("rejects unexpected status fields and nonnumeric repository identities", () => {
    expect(
      repositoryProductionDeliveryStatusSchema.safeParse({
        version: 1,
        appId: owner.appId,
        ...target,
        applicable: false,
        databaseUrl: "private",
      }).success,
    ).toBe(false);
    expect(
      repositoryProductionDeliveryStatusSchema.safeParse({
        version: 1,
        appId: owner.appId,
        ...target,
        repositoryId: "repo",
        applicable: false,
      }).success,
    ).toBe(false);
  });
});
