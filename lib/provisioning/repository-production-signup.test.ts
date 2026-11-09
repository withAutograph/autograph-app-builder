/* oxlint-disable typescript/promise-function-async -- Test ports expose existing promises without adding async scheduling. */
/* oxlint-disable eslint/require-await -- Async fake workers model persistence and lost responses at the protected worker boundary. */
import { describe, expect, it, vi } from "vitest";
import {
  initialRepositoryProductionRecord,
  repositoryProductionOperationRef,
} from "./repository-production-contract";
import type { RepositoryProductionScope } from "./repository-production-contract";
import {
  createRepositoryProductionSignup,
  assertNoUnresolvedRepositoryProductionSignup,
  repositoryProductionSignupOperationRef,
  renewedRepositoryProductionSignupRecord,
} from "./repository-production-signup";
import type {
  RepositoryProductionSignupClaim,
  RepositoryProductionSignupPorts,
  RepositoryProductionSignupRow,
} from "./repository-production-signup";
import { z } from "zod";

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
const claimId = "11111111-1111-4111-a111-111111111111";
const policyId = repositoryProductionOperationRef(scope);
const fixture = (storage: "none" | "postgres" = "postgres") => {
  let row: RepositoryProductionSignupRow | undefined;
  let fence = 0;
  let allowed = true;
  let bindings = false;
  let bindingFence = 0;
  let renewAtRead = 0;
  let reads = 0;
  let loseGrantResponse = false;
  let interruptBeforeGrant = false;
  let conflictRenewal = false;
  let unknown = false;
  const record = initialRepositoryProductionRecord(scope, {
    sessionId: "original-session",
    sourceSha: "a".repeat(40),
    creatorRoles: ["member"],
    access: {
      mode: "self-signup",
      eligibility: "public",
      appRoles: storage === "none" ? [] : ["member"],
    },
    entryPath: "/requests",
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
  record.effects["signup-policy"] = {
    state: "applied",
    receipt: {
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
      appRoles: record.intent.access?.mode === "self-signup" ? record.intent.access.appRoles : [],
      storage,
      enabled: true,
      operationRef: policyId,
      planDigest: "e".repeat(64),
      fenceGeneration: 1,
    },
  };
  const claim: RepositoryProductionSignupClaim = {
    id: claimId,
    policyId,
    policyDigest: "c".repeat(64),
    scopeDigest: "f".repeat(64),
    workspaceId: scope.authority.workspaceId,
    resourceDigest: "d".repeat(64),
    appId: scope.appId,
    organizationId: scope.organizationId,
    actorId: "verified-new-actor",
    appRoles: storage === "none" ? [] : ["member"],
    returnUrl: "https://apps.test/requests",
    status: "verified",
    sessionId: "auth-session",
    expiresAt: "2099-01-01T00:00:00.000Z",
    accessState: "absent",
    memberPrepared: false,
    grantReserved: false,
  };
  const assertCurrent = async () => {
    if (!allowed) {
      throw new Error("fence lost");
    }
  };
  const mutate = vi.fn<ReturnType<RepositoryProductionSignupPorts["workers"]>["mutateAppAccess"]>(
    async (context, access) => {
      if (interruptBeforeGrant) {
        interruptBeforeGrant = false;
        throw new Error("interrupted before reservation");
      }
      expect(row?.record.stage).toBe("grant-pending");
      expect(access.signupClaim).toEqual({ policyId, claimId, scopeDigest: claim.scopeDigest });
      expect(context.row.operationRef).toBe(
        repositoryProductionSignupOperationRef(
          policyId,
          claimId,
          (row?.record.renewals?.length ?? 0) > 0 ? `grant:${claim.scopeDigest}` : "grant",
        ),
      );
      claim.grantReserved = true;
      claim.recordedGrant = {
        operationRef: context.row.operationRef,
        fenceGeneration: context.row.record.lease?.fenceGeneration ?? 0,
      };
      claim.accessState = "active";
      bindings = true;
      bindingFence = claim.recordedGrant.fenceGeneration;
      if (loseGrantResponse) {
        loseGrantResponse = false;
        throw new Error("lost worker response");
      }
    },
  );
  const readback = {
    version: 1 as const,
    operation_id: policyId,
    context_digest: "a".repeat(64),
    fence_generation: 1,
    status: "applied" as const,
    readback_sha256: "b".repeat(64),
  };
  const auth = vi.fn<
    ReturnType<RepositoryProductionSignupPorts["workers"]>["invokeAuthManagement"]
  >(async (context, operation) => {
    const { request } = z.object({ request: z.object({ action: z.string() }) }).parse(operation);
    if (request.action === "read-signup") {
      reads += 1;
      if (reads === renewAtRead) {
        claim.scopeDigest = "9".repeat(64);
        claim.sessionId = "renewed-verified-session";
        claim.memberPrepared = false;
      }
      return { ...readback, result: structuredClone(claim) };
    }
    if (request.action === "prepare-signup-member") {
      claim.memberPrepared = true;
    }
    if (request.action === "set-access") {
      claim.grantReserved = true;
      claim.recordedGrant = {
        operationRef: context.row.operationRef,
        fenceGeneration: context.row.record.lease?.fenceGeneration ?? 0,
      };
      claim.accessState = "active";
    }
    if (request.action === "complete-signup") {
      expect(row?.record.stage).toBe("granted");
      claim.status = "applied";
    }
    return { ...readback, result: null };
  });
  const inspect = vi.fn<ReturnType<RepositoryProductionSignupPorts["workers"]>["inspectAppAccess"]>(
    async (_context, access) => {
      if (unknown) {
        return { state: "unknown" };
      }
      if (
        access.signupGrantReadback?.fenceGeneration !== undefined &&
        access.signupGrantReadback.fenceGeneration !== bindingFence
      ) {
        return { state: "unknown" };
      }
      return bindings ? { state: "applied", receipt: {} } : { state: "not-applied" };
    },
  );
  const ports: RepositoryProductionSignupPorts = {
    journal: {
      read: async () => row,
      reserve: async (input) => {
        row ??= {
          operationRef: repositoryProductionSignupOperationRef(policyId, claimId),
          revision: 1,
          record: structuredClone(input),
        };
        return row;
      },
      compareAndSet: async (before, next) => {
        expect(before.revision).toBe(row?.revision);
        row = { ...before, revision: before.revision + 1, record: structuredClone(next) };
        return row;
      },
      renew: async (before, observed) => {
        expect(before.revision).toBe(row?.revision);
        if (conflictRenewal) {
          // oxlint-disable-next-line unicorn/no-useless-undefined -- CAS exposes an explicit missing row on conflict.
          return undefined;
        }
        row = {
          ...before,
          revision: before.revision + 1,
          record: renewedRepositoryProductionSignupRecord(before.record, observed),
        };
        return row;
      },
      pending: async () =>
        row && row.record.stage !== "applied" && row.record.stage !== "rejected" ? [row] : [],
    },
    withLease: async (_scope, run) => {
      fence += 1;
      record.lease = { leaseId: claimId, fenceGeneration: fence };
      return await run(assertCurrent);
    },
    readSetup: async () => ({ operationRef: policyId, revision: 1, record }),
    workers: () => ({
      invokeAuthManagement: auth,
      mutateAppAccess: mutate,
      inspectAppAccess: inspect,
    }),
    realm: () => ({}),
    builderOrigin: "https://builder.test",
    assertNoConflictingAccess: assertCurrent,
  };
  return {
    complete: () => createRepositoryProductionSignup(ports).complete(scope, claimId),
    claim,
    record,
    auth,
    mutate,
    inspect,
    row: () => row,
    loseGrant: () => {
      loseGrantResponse = true;
    },
    unknown: () => {
      unknown = true;
    },
    cancel: () => {
      allowed = false;
    },
    clearBindings: () => {
      bindings = false;
    },
    interruptBeforeGrant: () => {
      interruptBeforeGrant = true;
    },
    conflictRenewal: () => {
      conflictRenewal = true;
    },
    renewAtRead: (count: number) => {
      renewAtRead = count;
    },
  };
};

describe("Production verified signup completion", () => {
  it("establishes generated app bindings before completing the same verified identity", async () => {
    const test = fixture();
    await expect(test.complete()).resolves.toBe("ready");
    expect(test.mutate).toHaveBeenCalledTimes(1);
    expect(test.row()?.record.stage).toBe("applied");
    await expect(test.complete()).resolves.toBe("ready");
    expect(test.mutate).toHaveBeenCalledTimes(1);
  });
  it("reconciles a lost grant response without preparing membership or granting twice", async () => {
    const test = fixture();
    test.loseGrant();
    await expect(test.complete()).rejects.toThrow("lost worker response");
    expect(test.row()?.record.stage).toBe("grant-pending");
    await expect(test.complete()).resolves.toBe("ready");
    expect(test.mutate).toHaveBeenCalledTimes(1);
    expect(
      test.auth.mock.calls.filter(
        ([, operation]) =>
          z.object({ request: z.object({ action: z.string() }) }).parse(operation).request
            .action === "prepare-signup-member",
      ),
    ).toHaveLength(1);
  });
  it("retries unfinished app bindings with the same grant operation and a fresh held fence", async () => {
    const test = fixture();
    test.loseGrant();
    await expect(test.complete()).rejects.toThrow();
    test.clearBindings();
    await expect(test.complete()).resolves.toBe("ready");
    expect(test.mutate.mock.calls.map(([context]) => context.row.operationRef)).toEqual([
      repositoryProductionSignupOperationRef(policyId, claimId, "grant"),
      repositoryProductionSignupOperationRef(policyId, claimId, "grant"),
    ]);
    expect(
      test.mutate.mock.calls.map(([context]) => context.row.record.lease?.fenceGeneration),
    ).toEqual([1, 2]);
  });
  it("never restores revoked access on completed or interrupted claims", async () => {
    const test = fixture();
    await test.complete();
    test.claim.status = "rejected";
    test.claim.accessState = "revoked";
    await expect(test.complete()).rejects.toMatchObject({ code: "app_access_denied" });
    expect(test.mutate).toHaveBeenCalledTimes(1);
    expect(test.row()?.record.stage).toBe("rejected");
  });
  it("refuses another app, actor mutation, disabled policy and unowned existing access", async () => {
    const foreign = fixture();
    foreign.claim.appId = "unrelated";
    await expect(foreign.complete()).rejects.toMatchObject({ code: "app_access_denied" });
    expect(foreign.mutate).not.toHaveBeenCalled();
    const existing = fixture();
    existing.claim.accessState = "active";
    await expect(existing.complete()).rejects.toMatchObject({ code: "app_access_denied" });
    const changed = fixture();
    changed.loseGrant();
    await expect(changed.complete()).rejects.toThrow();
    changed.claim.actorId = "other";
    await expect(changed.complete()).rejects.toMatchObject({ code: "app_access_denied" });
    expect(changed.mutate).toHaveBeenCalledTimes(1);
    const disabled = fixture();
    disabled.record.effects["signup-policy"].receipt = {
      ...z.record(z.string(), z.json()).parse(disabled.record.effects["signup-policy"].receipt),
      enabled: false,
    };
    await expect(disabled.complete()).rejects.toMatchObject({ code: "app_access_denied" });
    expect(disabled.mutate).not.toHaveBeenCalled();
  });
  it("does not dispatch a grant on uncertain readback or a canceled fence", async () => {
    const test = fixture();
    test.unknown();
    await expect(test.complete()).resolves.toBe("pending");
    expect(test.mutate).not.toHaveBeenCalled();
    test.cancel();
    await expect(test.complete()).rejects.toThrow("fence lost");
    expect(test.mutate).not.toHaveBeenCalled();
  });
  it("keeps applied access after signup is disabled without granting again", async () => {
    const test = fixture();
    await test.complete();
    test.record.intent.access = { mode: "private" };
    test.record.effects["signup-policy"].receipt = {
      ...z.record(z.string(), z.json()).parse(test.record.effects["signup-policy"].receipt),
      enabled: false,
    };
    await expect(test.complete()).resolves.toBe("ready");
    expect(test.mutate).toHaveBeenCalledTimes(1);
  });
  it("blocks only unresolved grants, allowing expired or unstarted claims to yield to policy changes", async () => {
    const test = fixture();
    test.loseGrant();
    await expect(test.complete()).rejects.toThrow();
    const row = test.row();
    if (!row) {
      throw new Error("missing retained claim");
    }
    const read = vi.fn(async () => structuredClone(test.claim));
    await expect(assertNoUnresolvedRepositoryProductionSignup([row], read)).rejects.toThrow(
      "reconciliation_required",
    );
    test.claim.status = "rejected";
    await expect(assertNoUnresolvedRepositoryProductionSignup([row], read)).rejects.toThrow(
      "reconciliation_required",
    );
    test.claim.accessState = "absent";
    test.claim.grantReserved = false;
    await expect(
      assertNoUnresolvedRepositoryProductionSignup([row], read),
    ).resolves.toBeUndefined();
    read.mockClear();
    await expect(
      assertNoUnresolvedRepositoryProductionSignup(
        [{ ...row, record: { ...row.record, stage: "registered" } }],
        read,
      ),
    ).resolves.toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    await expect(test.complete()).rejects.toMatchObject({ code: "app_access_denied" });
    expect(test.row()?.record.stage).toBe("rejected");
    expect(test.mutate).toHaveBeenCalledTimes(1);
    const unstarted = fixture();
    unstarted.claim.status = "rejected";
    await expect(unstarted.complete()).rejects.toMatchObject({ code: "app_access_denied" });
    expect(unstarted.mutate).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "renews a never-granted identity in place after rejection=%s, retaining its old tuple and checkpoints",
    async (rejectBeforeRenewal) => {
      const test = fixture();
      test.interruptBeforeGrant();
      await expect(test.complete()).rejects.toThrow("interrupted before reservation");
      const before = test.row();
      if (!before) {
        throw new Error("missing journal");
      }
      before.record.workerCheckpoints.push({ oldMember: true });
      if (rejectBeforeRenewal) {
        test.claim.status = "rejected";
        await expect(test.complete()).rejects.toMatchObject({ code: "app_access_denied" });
      }
      const observed = test.row();
      if (!observed) {
        throw new Error("missing journal");
      }
      const old = structuredClone(observed.record);
      test.claim.scopeDigest = "9".repeat(64);
      test.claim.sessionId = "new-verified-session";
      test.claim.expiresAt = "2099-02-01T00:00:00.000Z";
      test.claim.status = "verified";
      test.claim.memberPrepared = false;
      await expect(test.complete()).resolves.toBe("ready");
      const renewed = test.row();
      expect(renewed?.operationRef).toBe(before.operationRef);
      expect(renewed?.record.claim.scopeDigest).toBe(test.claim.scopeDigest);
      expect(renewed?.record.renewals).toEqual([
        { claim: old.claim, stage: old.stage, workerCheckpoints: old.workerCheckpoints },
      ]);
      expect(renewed?.record.workerCheckpoints).toEqual([]);
      const lastGrant = test.mutate.mock.calls.at(-1);
      if (!lastGrant) {
        throw new Error("missing grant");
      }
      expect(lastGrant[0].row.operationRef).toBe(
        repositoryProductionSignupOperationRef(
          policyId,
          claimId,
          `grant:${test.claim.scopeDigest}`,
        ),
      );
      expect(lastGrant[1].signupClaim?.scopeDigest).toBe(test.claim.scopeDigest);
      await expect(test.complete()).resolves.toBe("ready");
      expect(test.mutate).toHaveBeenCalledTimes(2);
    },
  );
  it("refuses renewal without authoritative no-reservation and no-history proof or with another identity", async () => {
    await Promise.all(
      [
        (claim: RepositoryProductionSignupClaim) => {
          claim.grantReserved = true;
        },
        (claim: RepositoryProductionSignupClaim) => {
          delete claim.grantReserved;
        },
        (claim: RepositoryProductionSignupClaim) => {
          claim.accessState = "revoked";
        },
        (claim: RepositoryProductionSignupClaim) => {
          claim.accessState = "changed";
        },
        (claim: RepositoryProductionSignupClaim) => {
          claim.actorId = "other";
        },
        (claim: RepositoryProductionSignupClaim) => {
          claim.resourceDigest = "8".repeat(64);
        },
      ].map(async (change) => {
        const test = fixture();
        test.interruptBeforeGrant();
        await expect(test.complete()).rejects.toThrow("interrupted before reservation");
        const retained = structuredClone(test.row());
        test.claim.scopeDigest = "9".repeat(64);
        test.claim.sessionId = "new-session";
        change(test.claim);
        await expect(test.complete()).rejects.toMatchObject({ code: "app_access_denied" });
        expect(test.row()).toEqual(retained);
        expect(test.mutate).toHaveBeenCalledTimes(1);
      }),
    );
  });
  it("checks the current approved policy and CAS before rebinding any journal", async () => {
    await Promise.all(
      (["policy", "conflict"] as const).map(async (reason) => {
        const test = fixture();
        test.interruptBeforeGrant();
        await expect(test.complete()).rejects.toThrow("interrupted before reservation");
        const before = structuredClone(test.row());
        test.claim.scopeDigest = "9".repeat(64);
        test.claim.sessionId = "new-session";
        if (reason === "policy") {
          test.claim.policyDigest = "8".repeat(64);
          await expect(test.complete()).rejects.toMatchObject({ code: "app_access_denied" });
        } else {
          test.conflictRenewal();
          await expect(test.complete()).rejects.toThrow("signup_conflict");
        }
        expect(test.row()).toEqual(before);
        expect(test.mutate).toHaveBeenCalledTimes(1);
      }),
    );
  });
  it("ignores never-granted renewed tuples for pending-effect checks but retains uncertain reserved grants", async () => {
    const test = fixture();
    test.interruptBeforeGrant();
    await expect(test.complete()).rejects.toThrow("interrupted before reservation");
    const row = test.row();
    if (!row) {
      throw new Error("missing journal");
    }
    test.claim.scopeDigest = "9".repeat(64);
    test.claim.sessionId = "new-session";
    const read = async () => structuredClone(test.claim);
    await expect(
      assertNoUnresolvedRepositoryProductionSignup([row], read),
    ).resolves.toBeUndefined();
    test.claim.grantReserved = true;
    await expect(assertNoUnresolvedRepositoryProductionSignup([row], read)).rejects.toMatchObject({
      code: "app_access_denied",
    });
    test.claim.scopeDigest = row.record.claim.scopeDigest;
    test.claim.sessionId = row.record.claim.sessionId;
    test.claim.status = "rejected";
    await expect(assertNoUnresolvedRepositoryProductionSignup([row], read)).rejects.toThrow(
      "reconciliation_required",
    );
  });
  it.each([2, 3, 4])(
    "does not mix a newly renewed claim with an older callback proof at read %s",
    async (read) => {
      const test = fixture();
      test.renewAtRead(read);
      await expect(test.complete()).resolves.toBe("pending");
      expect(test.mutate).not.toHaveBeenCalled();
      expect(test.row()?.record.claim.scopeDigest).toBe("9".repeat(64));
      await expect(test.complete()).resolves.toBe("ready");
      expect(test.mutate).toHaveBeenCalledTimes(1);
      expect(test.row()?.record.renewals).toHaveLength(1);
    },
  );
  it.each(["none", "postgres"] as const)(
    "observes a completed %s grant at its recorded fence after lost response, expiry and policy disable without writes",
    async (storage) => {
      const test = fixture(storage);
      if (storage === "postgres") {
        test.loseGrant();
        await expect(test.complete()).rejects.toThrow("lost worker response");
      } else {
        await test.complete();
      }
      const grant = test.claim.recordedGrant;
      expect(grant?.fenceGeneration).toBe(1);
      test.claim.status = "rejected";
      test.claim.memberPrepared = false;
      test.record.effects["signup-policy"].receipt = {
        ...z.record(z.string(), z.json()).parse(test.record.effects["signup-policy"].receipt),
        enabled: false,
      };
      test.auth.mockClear();
      test.inspect.mockClear();
      const mutations = test.mutate.mock.calls.length;
      await expect(test.complete()).resolves.toBe("ready");
      expect(test.row()?.record.stage).toBe("applied");
      expect(
        test.auth.mock.calls.every(
          ([, operation]) =>
            z.object({ request: z.object({ action: z.string() }) }).parse(operation).request
              .action === "read-signup",
        ),
      ).toBe(true);
      expect(test.mutate).toHaveBeenCalledTimes(mutations);
      expect(test.row()?.record.workerCheckpoints).toContainEqual({
        kind: "signup-recorded-grant",
        ...grant,
        scopeDigest: test.claim.scopeDigest,
      });
      if (storage === "postgres") {
        const observation = test.inspect.mock.calls.at(-1);
        expect(observation?.[0].row.record.lease?.fenceGeneration).toBe(2);
        expect(observation?.[1].signupGrantReadback?.fenceGeneration).toBe(1);
      } else {
        expect(test.inspect).not.toHaveBeenCalled();
      }
    },
  );
  it("keeps incomplete or unowned recorded grants pending without grant or membership writes", async () => {
    const test = fixture();
    test.loseGrant();
    await expect(test.complete()).rejects.toThrow();
    test.claim.status = "rejected";
    test.clearBindings();
    test.auth.mockClear();
    await expect(test.complete()).resolves.toBe("pending");
    expect(test.row()?.record.stage).toBe("grant-pending");
    expect(test.mutate).toHaveBeenCalledTimes(1);
    expect(
      test.auth.mock.calls.every(
        ([, operation]) =>
          z.object({ request: z.object({ action: z.string() }) }).parse(operation).request
            .action === "read-signup",
      ),
    ).toBe(true);
    test.claim.recordedGrant = {
      operationRef: "22222222-2222-4222-a222-222222222222",
      fenceGeneration: 1,
    };
    await expect(test.complete()).rejects.toMatchObject({ code: "app_access_denied" });
    test.claim.accessState = "revoked";
    delete test.claim.recordedGrant;
    await expect(test.complete()).resolves.toBe("pending");
    expect(test.mutate).toHaveBeenCalledTimes(1);
  });
  it("cannot acknowledge or revive a grant once an owner cancellation has been captured", async () => {
    const test = fixture();
    test.loseGrant();
    await expect(test.complete()).rejects.toThrow();
    const row = test.row();
    if (!row) {
      throw new Error("missing journal");
    }
    row.record.stage = "cancel-pending";
    row.record.cancellation = {
      operationRef: "22222222-2222-4222-a222-222222222222",
      actorId: row.record.claim.actorId,
      scopeDigest: row.record.claim.scopeDigest,
      roles: row.record.claim.appRoles,
    };
    test.inspect.mockClear();
    test.auth.mockClear();
    await expect(test.complete()).rejects.toMatchObject({ code: "app_access_denied" });
    expect(test.mutate).toHaveBeenCalledTimes(1);
    expect(test.inspect).not.toHaveBeenCalled();
    expect(row.record.stage).toBe("cancel-pending");
    await expect(
      assertNoUnresolvedRepositoryProductionSignup([row], async () => structuredClone(test.claim)),
    ).rejects.toThrow("reconciliation_required");
  });
  it("waits for every readback before releasing a failed pending-effect inspection", async () => {
    const test = fixture();
    test.loseGrant();
    await expect(test.complete()).rejects.toThrow();
    const row = test.row();
    if (!row) {
      throw new Error("missing journal");
    }
    const release = Promise.withResolvers<RepositoryProductionSignupClaim>();
    const failed = new Error("readback unavailable");
    let complete = false;
    const inspection = assertNoUnresolvedRepositoryProductionSignup([row, row], async () => {
      if (!complete) {
        complete = true;
        throw failed;
      }
      return await release.promise;
    });
    let settled = false;
    const watch = async () => {
      try {
        await inspection;
      } catch {
        settled = true;
      }
    };
    const watched = watch();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve(structuredClone(test.claim));
    await expect(inspection).rejects.toBe(failed);
    await watched;
  });
  it("uses only positive Auth admission for a frontend app", async () => {
    const test = fixture("none");
    await expect(test.complete()).resolves.toBe("ready");
    expect(test.mutate).not.toHaveBeenCalled();
    expect(test.inspect).not.toHaveBeenCalled();
    expect(
      test.auth.mock.calls.some(
        ([, operation]) =>
          z.object({ request: z.object({ action: z.string() }) }).parse(operation).request
            .action === "set-access",
      ),
    ).toBe(true);
  });
});
