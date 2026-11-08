import { capturedGenericWorkerFixture } from "./operator-worker-source-capture.test-fixture";
import { describe, expect, it } from "vitest";
import {
  assertNoConfiguredNativeTarget,
  createNativeTargetApprovalCheckpoint,
  createNativeTargetApprovalHistoryTransport,
  nativeTargetApprovalCheckpointId,
  nativeTargetDatabaseNames,
  selectNativeTargetInstaller,
} from "./native-target-onboarding-deployment";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};

const generic = {
  executablePath: "/trusted/generic-installer",
  id: "generic-generated-installer",
  operationScope: "generated-app-release-install-v1" as const,
  sha256: "a".repeat(64),
  subcommand: "protected-generated-app-install" as const,
};
const access = {
  executablePath: "/trusted/access-worker",
  id: "access-worker",
  operationScope: "generated-app-access-v1" as const,
  sha256: "b".repeat(64),
  subcommand: "protected-generated-app-access" as const,
};

describe("native target deployment-owned resource selection", () => {
  it("derives distinct bounded SQL names from the validated app identity", () => {
    const names = nativeTargetDatabaseNames("spend-review-requests");
    expect(new Set(Object.values(names)).size).toBe(3);
    expect(Object.values(names).every((value) => /^[a-z][a-z0-9_]{0,62}$/u.test(value))).toBe(true);
    expect(nativeTargetDatabaseNames("spend-review-requests")).toEqual(names);
    expect(nativeTargetDatabaseNames("spend-review-requestx")).not.toEqual(names);
    const long = nativeTargetDatabaseNames(`a${"a".repeat(91)}`);
    expect(Object.values(long).every((value) => value.length <= 63)).toBe(true);
    expect(() => nativeTargetDatabaseNames("../different-app")).toThrow();
  });

  it("requires an explicit captured generic for fresh apps instead of inferring it from per-app aliases", () => {
    const workers = { alias: generic, existing: generic };
    expect(() => selectNativeTargetInstaller(workers, "fresh-app")).toThrow(
      "generic_installer_configuration_required",
    );
    expect(selectNativeTargetInstaller(workers, "fresh-app", capturedGenericWorkerFixture)).toEqual(
      capturedGenericWorkerFixture,
    );
    expect(
      selectNativeTargetInstaller(
        { ...workers, "fresh-app": generic },
        "fresh-app",
        capturedGenericWorkerFixture,
      ),
    ).toEqual(generic);
    expect(() =>
      selectNativeTargetInstaller(
        { "fresh-app": access },
        "fresh-app",
        capturedGenericWorkerFixture,
      ),
    ).toThrow();
  });

  it("blocks a second dedicated project for an app with an existing configured physical target", () => {
    const applications = {
      "requests-app": {
        accessRoles: ["viewer"],
        appDatabase: {
          database: "existing_database",
          migratorRole: "existing_migrator",
          resourceId: "existing-resource",
          runtimeRole: "existing_runtime",
        },
        branch: "main",
        projectId: "existing-project",
      },
    };
    expect(() => {
      assertNoConfiguredNativeTarget(applications, "requests-app");
    }).toThrow("native_target_existing_configured_target");
    expect(() => {
      assertNoConfiguredNativeTarget(applications, "other-app");
    }).not.toThrow();
  });

  it("persists an incomplete approval observation using the journal's UUID, digest, and state constraints", async () => {
    const digest = "a".repeat(64);
    const otherDigest = "b".repeat(64);
    const id = nativeTargetApprovalCheckpointId(authority, "requests-app", digest);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(nativeTargetApprovalCheckpointId(authority, "requests-app", digest)).toBe(id);
    expect(nativeTargetApprovalCheckpointId(authority, "requests-app", otherDigest)).not.toBe(id);

    interface Row {
      requestId: string;
      requestDigest: string;
      state: string;
      record: unknown;
      revision: number;
    }
    let row: Row | undefined;
    const fakeDatabase = {
      select: () => ({
        from: () => ({
          // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
          where: () => ({ limit: () => Promise.resolve(row === undefined ? [] : [row]) }),
        }),
      }),
      insert: () => ({
        values: (value: Row) => ({
          // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
          onConflictDoNothing: () => {
            // These are the actual builder_provisioning_journal CHECK constraints.
            expect(value.requestId).toMatch(
              /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
            );
            expect(value.requestDigest).toMatch(/^[0-9a-f]{64}$/u);
            expect(["pending", "settled"]).toContain(value.state);
            expect(value.record).toBeTypeOf("object");
            row ??= value;
            return Promise.resolve();
          },
        }),
      }),
      update: () => ({
        set: (value: Partial<Row>) => ({
          where: () => ({
            // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
            returning: () => {
              if (row === undefined) {
                throw new Error("Approval checkpoint update requires a prior insert.");
              }
              row = { ...row, ...value };
              return Promise.resolve([{ revision: row.revision }]);
            },
          }),
        }),
      }),
    };
    // SAFETY: The checkpoint only calls these three modeled Drizzle chains; this fixture checks their persisted values.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- This narrow in-memory Drizzle stand-in deliberately models only the exercised methods.
    const database = fakeDatabase as unknown as Parameters<
      typeof createNativeTargetApprovalCheckpoint
    >[0];
    const checkpoint = createNativeTargetApprovalCheckpoint(
      database,
      authority,
      "requests-app",
      digest,
    );
    const observation = {
      version: 1 as const,
      native: {
        adapterSessionId: "adapter-one",
        adapterGeneration: 1,
        nextNativeIndex: 1,
        capture: {
          request: {
            action: "native-target" as const,
            planRef: "plan-one",
            planDigest: digest,
            idempotencyKey: "requests-app",
          },
          ownerUserId: authority.ownerUserId,
          entries: [],
        },
      },
      terminals: [],
    };
    expect(await checkpoint.read()).toBeUndefined();
    await checkpoint.save(observation);
    expect(row?.state).toBe("pending");
    expect(row?.requestId).toBe(id);
    expect(await checkpoint.read()).toEqual(observation);
    await checkpoint.save({
      ...observation,
      native: { ...observation.native, nextNativeIndex: 2 },
    });
    expect(row?.revision).toBe(2);
    const saved = await checkpoint.read();
    expect(saved?.native.nextNativeIndex).toBe(2);
  });
});

describe("native target approval history carrier", () => {
  it("uses the verified Builder carrier only after owner and session scope checks", async () => {
    const principal = { ...authority, scopes: ["autograph:session"] };
    const historyOwner = {
      adapterGeneration: 1,
      adapterSessionId: "wrun_fixture",
      authority,
      kind: "direct" as const,
      principal,
      sessionId: "public-session",
    };
    const owner = {
      adapterGeneration: 1,
      adapterSessionId: historyOwner.adapterSessionId,
      authority,
      historyOwner,
      publicSessionId: historyOwner.sessionId,
    };
    const calls: { resource: string; authorization: string | null }[] = [];
    const controller = new AbortController();
    const transport = createNativeTargetApprovalHistoryTransport({
      builderOrigin: "https://builder.example",
      appId: "requests-app",
      owner,
      workload: { authorization: "Bearer verified-builder-token", signal: controller.signal },
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
      assertCanonicalAppOwner: () => Promise.resolve(),
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
      fetch: (resource, init) => {
        const requested = resource instanceof Request ? resource.url : resource;
        const url = requested instanceof URL ? requested.href : requested;
        calls.push({
          resource: url,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return Promise.resolve(new Response("", { status: 401 }));
      },
    });
    const read = transport.observePrivateHistory;
    expect(read).toBeDefined();
    await expect(
      read?.({
        adapterSessionId: "wrong",
        onEvent: () => {},
        principal,
        sessionId: "public-session",
        startIndex: 0,
      }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
    await expect(
      read?.({
        adapterSessionId: "wrun_fixture",
        onEvent: () => {},
        principal,
        sessionId: "public-session",
        startIndex: 0,
      }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.resource).toContain("/eve/v1/session/wrun_fixture/stream");
    expect(calls[0]?.authorization).toBe("Bearer verified-builder-token");
    expect(() =>
      createNativeTargetApprovalHistoryTransport({
        builderOrigin: "https://builder.example",
        appId: "requests-app",
        owner,
        workload: { authorization: null, signal: controller.signal },
        // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
        assertCanonicalAppOwner: () => Promise.resolve(),
      }),
    ).toThrow();
  });
});
