/* oxlint-disable typescript/promise-function-async -- Fake ports return their existing promises without changing their scheduling. */
/* oxlint-disable eslint/require-await -- Async fake workers model durable checkpoints and lost responses. */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AppAccessEffectContext } from "../app-access/management";
import {
  initialRepositoryProductionRecord,
  repositoryProductionOperationRef,
} from "./repository-production-contract";
import type { RepositoryProductionScope } from "./repository-production-contract";
import {
  repositoryProductionSignupOperationRef,
  repositoryProductionSignupRecordSchema,
} from "./repository-production-signup";
import type {
  RepositoryProductionSignupClaim,
  RepositoryProductionSignupRow,
  RepositoryProductionSignupStore,
} from "./repository-production-signup";
import { createRepositoryProductionSignupCancellation } from "./repository-production-signup-cancellation";

const scope: RepositoryProductionScope = {
  authority: {
    issuer: "https://builder.test/api/auth",
    audience: "https://builder.test/mcp",
    ownerUserId: "owner",
    workspaceId: "workspace",
  },
  appId: "requests",
  repositoryId: "repository",
  repositoryFullName: "example/apps",
  projectId: "project",
  organizationId: "org",
  publicOrigin: "https://apps.test",
  environment: "production",
};
type Ports = Parameters<typeof createRepositoryProductionSignupCancellation>[0];
type Workers = ReturnType<Ports["workers"]>;
const claimId = "11111111-1111-4111-a111-111111111111";
const peopleOperationRef = "22222222-2222-4222-a222-222222222222";
const policyId = repositoryProductionOperationRef(scope);
const fixture = (storage: "postgres" | "none" = "postgres", roles = ["member"]) => {
  const setup = initialRepositoryProductionRecord(scope, {
    sessionId: "original-session",
    sourceSha: "a".repeat(40),
    creatorRoles: ["member"],
    storage:
      storage === "none"
        ? { kind: "none" }
        : {
            kind: "postgres",
            releaseId: "release",
            artifactRef: "artifact",
            manifestSha256: "b".repeat(64),
            databaseEnvironment: "REQUESTS_DATABASE_URL",
          },
  });
  if (storage === "postgres") {
    setup.resource = {
      resourceId: "app-resource",
      database: "app_database",
      runtimeRole: "app_runtime",
      migratorRole: "app_migrator",
    };
  }
  const lease = { leaseId: peopleOperationRef, fenceGeneration: 5 };
  setup.lease = lease;
  const policy = {
    version: 1,
    policyId,
    policyDigest: "c".repeat(64),
    workspaceId: scope.authority.workspaceId,
    resourceDigest: "d".repeat(64),
    appId: scope.appId,
    organizationId: scope.organizationId,
    origin: scope.publicOrigin,
    appPath: "/requests",
    eligibility: "public",
    appRoles: roles,
    storage,
    enabled: true,
    operationRef: policyId,
    planDigest: "e".repeat(64),
    fenceGeneration: 1,
  };
  setup.effects["signup-policy"] = { state: "applied", receipt: policy };
  const claim: RepositoryProductionSignupClaim = {
    id: claimId,
    policyId,
    policyDigest: policy.policyDigest,
    scopeDigest: "f".repeat(64),
    workspaceId: scope.authority.workspaceId,
    resourceDigest: policy.resourceDigest,
    appId: scope.appId,
    organizationId: scope.organizationId,
    actorId: "signup-actor",
    appRoles: [...roles],
    returnUrl: "https://apps.test/requests",
    status: "verified",
    sessionId: "auth-session",
    expiresAt: "2020-01-01T00:00:00.000Z",
    accessState: "active",
    memberPrepared: false,
    grantReserved: true,
  };
  let row: RepositoryProductionSignupRow | undefined = {
    operationRef: repositoryProductionSignupOperationRef(policyId, claimId),
    revision: 1,
    record: repositoryProductionSignupRecordSchema.parse({
      version: 1,
      kind: "repository-production-signup-v1",
      scope,
      claim,
      stage: "grant-pending",
      workerCheckpoints: [{ originalGrant: true }],
    }),
  };
  type Json = z.infer<ReturnType<typeof z.json>>;
  const frames: Json[] = [];
  let admissionActive = true;
  let assignmentsActive = true;
  let kernelActive = true;
  let closedFence = 0;
  // oxlint-disable-next-line sonarjs/max-union-size -- The fake models each closed worker result plus no forced override.
  let forceState: "unknown" | "not-applied" | "applied" | null = null;
  let loseResponse: "before" | "after" | null = null;
  let failCapture = false;
  let failSettle = false;
  let held = true;
  let suppressProof = false;
  const assertCurrent = vi.fn(async () => {
    if (!held) {
      throw new Error("fence lost");
    }
  });
  const effect: AppAccessEffectContext = {
    operationRef: peopleOperationRef,
    createdAt: "2026-11-09T12:00:00.000Z",
    assertCurrent,
    checkpoint: vi.fn<AppAccessEffectContext["checkpoint"]>(async (frame) => {
      frames.push(structuredClone(frame));
    }),
    readCheckpoints: () => frames,
  };
  const journal: RepositoryProductionSignupStore = {
    read: vi.fn<RepositoryProductionSignupStore["read"]>(async () => row),
    pending: vi.fn<RepositoryProductionSignupStore["pending"]>(async () =>
      row && row.record.stage !== "applied" && row.record.stage !== "rejected" ? [row] : [],
    ),
    reserve: vi.fn<RepositoryProductionSignupStore["reserve"]>(async () => {
      throw new Error("cancellation must not reserve a signup");
    }),
    renew: vi.fn<RepositoryProductionSignupStore["renew"]>(async () => {
      throw new Error("cancellation must never renew a signup");
    }),
    compareAndSet: vi.fn<RepositoryProductionSignupStore["compareAndSet"]>(async (before, next) => {
      if (
        (next.stage === "cancel-pending" && failCapture) ||
        (next.stage === "rejected" && failSettle)
      ) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- A failed CAS returns no replacement row.
        return undefined;
      }
      expect(before.revision).toBe(row?.revision);
      row = { ...before, revision: before.revision + 1, record: structuredClone(next) };
      return row;
    }),
  };
  const assertCaptured = () => {
    expect(frames).toContainEqual(
      expect.objectContaining({ claimId, roles, operationRef: peopleOperationRef }),
    );
    expect(row?.record.stage).toBe("cancel-pending");
    expect(row?.record.cancellation).toEqual({
      operationRef: peopleOperationRef,
      actorId: claim.actorId,
      scopeDigest: claim.scopeDigest,
      roles,
    });
  };
  const close = () => {
    admissionActive = false;
    assignmentsActive = false;
    closedFence = lease.fenceGeneration;
  };
  const readback = {
    version: 1 as const,
    operation_id: peopleOperationRef,
    context_digest: "a".repeat(64),
    fence_generation: lease.fenceGeneration,
    status: "applied" as const,
    readback_sha256: "b".repeat(64),
  };
  const workers = {
    mutateAppAccess: vi.fn<Workers["mutateAppAccess"]>(async (_context, access) => {
      assertCaptured();
      expect(access).toEqual({ actorId: claim.actorId, roles, active: false });
      if (loseResponse === "before") {
        loseResponse = null;
        throw new Error("lost before effect");
      }
      close();
      kernelActive = false;
      if (loseResponse === "after") {
        loseResponse = null;
        throw new Error("lost after effect");
      }
    }),
    inspectAppAccess: vi.fn<Workers["inspectAppAccess"]>(async () => {
      const state = forceState ?? (kernelActive ? "not-applied" : "applied");
      return state === "applied" ? ({ state, receipt: {} } as const) : { state };
    }),
    invokeAuthManagement: vi.fn<Workers["invokeAuthManagement"]>(
      async (_context, operation, readOnly) => {
        const { request } = z
          .object({ request: z.looseObject({ action: z.string() }) })
          .parse(operation);
        if (request.action === "read-signup") {
          expect(readOnly).toBe(true);
          const result = { ...claim };
          if (claim.accessState !== "changed") {
            result.accessState = !admissionActive || !assignmentsActive ? "revoked" : "active";
          }
          if (!admissionActive && !assignmentsActive && !suppressProof) {
            result.accessRevocation = { fenceGeneration: closedFence };
          }
          return { ...readback, result };
        }
        expect(request).toEqual({
          action: "set-access",
          actorId: claim.actorId,
          roles,
          active: false,
        });
        expect(readOnly).toBe(false);
        assertCaptured();
        close();
        return { ...readback, result: null };
      },
    ),
  };
  const service = createRepositoryProductionSignupCancellation({
    journal,
    readSetup: async () => ({ operationRef: policyId, revision: 1, record: setup }),
    workers: () => workers,
    realm: () => ({}),
    builderOrigin: "https://builder.test",
  });
  return {
    cancel: (mode: "execute" | "reconcile" = "execute", actorId = claim.actorId) =>
      service.cancel({ scope, actorId, effect, mode }),
    service,
    journal,
    setup,
    policy,
    claim,
    workers,
    frames,
    effect,
    row: () => row,
    setRow: (value: RepositoryProductionSignupRow | undefined) => {
      row = value;
    },
    lose: (when: "before" | "after") => {
      loseResponse = when;
    },
    inspect: (state: typeof forceState) => {
      forceState = state;
    },
    failCapture: () => {
      failCapture = true;
    },
    failSettle: () => {
      failSettle = true;
    },
    loseAuthority: () => {
      held = false;
    },
    suppressProof: (value: boolean) => {
      suppressProof = value;
    },
    partialClosure: () => {
      assignmentsActive = false;
      kernelActive = false;
    },
    closed: (fence: number) => {
      close();
      kernelActive = false;
      closedFence = fence;
    },
    state: () => ({ admissionActive, assignmentsActive, kernelActive }),
  };
};

describe("pending signup cancellation", () => {
  it("captures the original claim and roles before generic cleanup, then rejects only after both stores close", async () => {
    const f = fixture();
    f.policy.enabled = false;
    f.policy.policyDigest = "0".repeat(64);
    f.policy.appRoles = ["new-policy-role"];
    expect(await f.cancel()).toBe("applied");
    expect(f.state()).toEqual({
      admissionActive: false,
      assignmentsActive: false,
      kernelActive: false,
    });
    expect(f.row()?.record.stage).toBe("rejected");
    expect(f.row()?.record.claim.appRoles).toEqual(["member"]);
    expect(f.row()?.record.workerCheckpoints).toEqual([{ originalGrant: true }]);
    expect(f.workers.mutateAppAccess).toHaveBeenCalledTimes(1);
    expect(f.workers.invokeAuthManagement.mock.calls.every((call) => call[2])).toBe(true);
    expect(f.journal.renew).not.toHaveBeenCalled();
  });

  it.each(["none", "postgres"] as const)(
    "supports roleless %s cleanup without preparing or inventing a member",
    async (storage) => {
      const f = fixture(storage, []);
      expect(await f.cancel()).toBe("applied");
      if (storage === "none") {
        expect(f.workers.mutateAppAccess).not.toHaveBeenCalled();
        expect(f.workers.inspectAppAccess).not.toHaveBeenCalled();
      } else {
        expect(f.workers.mutateAppAccess.mock.calls[0]?.[1]).toEqual({
          actorId: f.claim.actorId,
          roles: [],
          active: false,
        });
      }
      expect(f.row()?.record.stage).toBe("rejected");
    },
  );

  it("does not capture or dispatch from first read-only reconciliation", async () => {
    const f = fixture();
    expect(await f.cancel("reconcile")).toBe("absent");
    expect(f.frames).toEqual([]);
    expect(f.journal.compareAndSet).not.toHaveBeenCalled();
    expect(f.workers.invokeAuthManagement).not.toHaveBeenCalled();
    expect(f.workers.mutateAppAccess).not.toHaveBeenCalled();
  });

  it("only yields to ordinary removal when this actor has no pending target or checkpoint", async () => {
    const f = fixture();
    expect(await f.cancel("execute", "other-actor")).toBeUndefined();
    f.setRow(undefined);
    expect(await f.cancel()).toBeUndefined();
    expect(f.workers.invokeAuthManagement).not.toHaveBeenCalled();
  });

  it("settles a lost response by readback, then restores the settled target from the People checkpoint", async () => {
    const f = fixture();
    f.lose("after");
    expect(await f.cancel()).toBe("unknown");
    expect(f.row()?.record.stage).toBe("cancel-pending");
    const audit = structuredClone(f.row()?.record.cancellation);
    expect(await f.cancel("reconcile")).toBe("applied");
    expect(await f.cancel("reconcile")).toBe("applied");
    expect(f.journal.read).toHaveBeenCalledWith(scope, claimId);
    expect(f.workers.mutateAppAccess).toHaveBeenCalledTimes(1);
    expect(f.row()?.record.cancellation).toEqual(audit);
    expect(f.frames).toHaveLength(1);
  });

  it("retains the captured target after a failed dispatch and executes its original frozen revoke on retry", async () => {
    const f = fixture();
    f.lose("before");
    expect(await f.cancel()).toBe("unknown");
    expect(await f.cancel("reconcile")).toBe("absent");
    expect(await f.cancel()).toBe("applied");
    expect(f.frames).toHaveLength(1);
    expect(f.workers.mutateAppAccess).toHaveBeenCalledTimes(2);
  });

  it("does not mistake inactive assignments for closed positive admission", async () => {
    const f = fixture();
    f.lose("before");
    await f.cancel();
    f.partialClosure();
    expect(await f.cancel("reconcile")).toBe("absent");
    expect(f.row()?.record.stage).toBe("cancel-pending");
    expect(await f.cancel()).toBe("applied");
    expect(f.state().admissionActive).toBe(false);
  });

  it("requires readable kernel closure as well as exact current-fence Auth closure", async () => {
    const f = fixture();
    f.lose("before");
    await f.cancel();
    f.closed(5);
    f.inspect("unknown");
    expect(await f.cancel("reconcile")).toBe("unknown");
    expect(await f.cancel()).toBe("unknown");
    expect(f.workers.mutateAppAccess).toHaveBeenCalledTimes(1);
    expect(f.row()?.record.stage).toBe("cancel-pending");
  });

  it("does not settle from an older worker without the exact negative witness", async () => {
    const f = fixture();
    f.suppressProof(true);
    expect(await f.cancel()).toBe("unknown");
    expect(f.row()?.record.stage).toBe("cancel-pending");
    expect(await f.cancel("reconcile")).toBe("absent");
    f.suppressProof(false);
    expect(await f.cancel("reconcile")).toBe("applied");
    expect(f.workers.mutateAppAccess).toHaveBeenCalledTimes(1);
  });

  it("keeps unreadable provider observations unknown and dispatches no revoke", async () => {
    const f = fixture();
    f.workers.invokeAuthManagement.mockRejectedValueOnce(new Error("read response lost"));
    expect(await f.cancel()).toBe("unknown");
    expect(f.workers.mutateAppAccess).not.toHaveBeenCalled();
    f.workers.inspectAppAccess.mockRejectedValueOnce(new Error("readback failed"));
    expect(await f.cancel("reconcile")).toBe("unknown");
    expect(f.row()?.record.stage).toBe("cancel-pending");
  });

  it("refreshes an older complete tombstone under the newly held lease without reusing grant authority", async () => {
    const f = fixture();
    f.lose("before");
    await f.cancel();
    f.closed(4);
    expect(await f.cancel("reconcile")).toBe("absent");
    expect(await f.cancel()).toBe("applied");
    expect(f.workers.mutateAppAccess.mock.calls.at(-1)?.[0].row.record.lease?.fenceGeneration).toBe(
      5,
    );
    expect(f.workers.mutateAppAccess.mock.calls.at(-1)?.[0].row.operationRef).not.toBe(
      f.row()?.operationRef,
    );
  });

  it("leaves a future fence or changed access unknown without dispatching", async () => {
    const f = fixture();
    f.closed(6);
    expect(await f.cancel()).toBe("unknown");
    f.claim.accessState = "changed";
    expect(await f.cancel()).toBe("unknown");
    expect(f.workers.mutateAppAccess).not.toHaveBeenCalled();
  });

  it.each(["actorId", "resourceDigest", "scopeDigest", "sessionId"] as const)(
    "denies a changed live immutable %s without revoking another claim",
    async (key) => {
      const f = fixture();
      f.claim[key] = key.endsWith("Digest") ? "0".repeat(64) : "foreign";
      await expect(f.cancel("execute", "signup-actor")).rejects.toMatchObject({
        code: "app_access_denied",
      });
      expect(f.workers.mutateAppAccess).not.toHaveBeenCalled();
    },
  );

  it("denies foreign or malformed retained targets instead of falling through to normal removal", async () => {
    const f = fixture();
    f.lose("before");
    await f.cancel();
    const target = z.record(z.string(), z.json()).parse(structuredClone(f.frames[0]));
    f.frames[0] = { ...target, roles: ["admin"] };
    await expect(f.cancel("reconcile")).rejects.toMatchObject({ code: "app_access_denied" });
    f.frames[0] = { ...target, actorId: "foreign" };
    await expect(f.cancel()).rejects.toMatchObject({ code: "app_access_denied" });
    f.frames[0] = { kind: target.kind };
    await expect(f.cancel()).rejects.toMatchObject({ code: "app_access_denied" });
    expect(f.workers.mutateAppAccess).toHaveBeenCalledTimes(1);
  });

  it("denies a retained target from another owner and a foreign current Auth resource", async () => {
    const f = fixture();
    f.lose("before");
    await f.cancel();
    await expect(
      f.service.cancel({
        scope: { ...scope, authority: { ...scope.authority, ownerUserId: "foreign-owner" } },
        actorId: f.claim.actorId,
        effect: f.effect,
        mode: "execute",
      }),
    ).rejects.toMatchObject({ code: "app_access_denied" });
    expect(f.workers.mutateAppAccess).toHaveBeenCalledTimes(1);
    const g = fixture();
    g.policy.resourceDigest = "0".repeat(64);
    await expect(g.cancel()).rejects.toMatchObject({ code: "app_access_denied" });
    expect(g.workers.mutateAppAccess).not.toHaveBeenCalled();
  });

  it("does not dispatch when the durable target checkpoint or cancellation CAS fails", async () => {
    const f = fixture();
    f.effect.checkpoint = async () => {
      throw new Error("checkpoint failed");
    };
    await expect(f.cancel()).rejects.toThrow("checkpoint failed");
    expect(f.journal.compareAndSet).not.toHaveBeenCalled();
    expect(f.workers.mutateAppAccess).not.toHaveBeenCalled();
    const g = fixture();
    g.failCapture();
    expect(await g.cancel()).toBe("unknown");
    expect(g.workers.mutateAppAccess).not.toHaveBeenCalled();
  });

  it("keeps cancellation pending when final acknowledgement loses its CAS", async () => {
    const f = fixture();
    f.failSettle();
    expect(await f.cancel()).toBe("unknown");
    expect(f.row()?.record.stage).toBe("cancel-pending");
    expect(f.state().kernelActive).toBe(false);
  });

  it("never uses a retained target under lost app authority", async () => {
    const f = fixture();
    f.loseAuthority();
    await expect(f.cancel()).rejects.toThrow("fence lost");
    expect(f.frames).toEqual([]);
    expect(f.workers.mutateAppAccess).not.toHaveBeenCalled();
  });
});
