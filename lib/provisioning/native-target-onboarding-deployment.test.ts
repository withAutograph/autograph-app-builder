import { describe, expect, it } from "vitest";
import {
  assertNoConfiguredNativeTarget,
  createNativeTargetApprovalCheckpoint,
  nativeTargetApprovalCheckpointId,
  nativeTargetDatabaseNames,
  selectNativeTargetInstaller,
} from "./native-target-onboarding-deployment";

const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace",
  ownerUserId: "owner",
};

const generic = {
  id: "generic-generated-installer",
  executablePath: "/trusted/generic-installer",
  sha256: "a".repeat(64),
  operationScope: "generated-app-release-install-v1" as const,
  subcommand: "protected-generated-app-install" as const,
};
const access = {
  id: "access-worker",
  executablePath: "/trusted/access-worker",
  sha256: "b".repeat(64),
  operationScope: "generated-app-access-v1" as const,
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

  it("reuses a configured generic installer, prefers an app-specific configured capability, and rejects absence", () => {
    const workers = { platform: access, existing: generic };
    expect(selectNativeTargetInstaller(workers, "fresh-app")).toEqual(generic);
    const selected = { ...generic, id: "app-specific" };
    expect(selectNativeTargetInstaller({ ...workers, "fresh-app": selected }, "fresh-app")).toEqual(
      selected,
    );
    expect(() => selectNativeTargetInstaller({ platform: access }, "fresh-app")).toThrow();
  });

  it("blocks a second dedicated project for an app with an existing configured physical target", () => {
    const applications = {
      "requests-app": {
        accessRoles: ["viewer"],
        appDatabase: {
          resourceId: "existing-resource",
          database: "existing_database",
          migratorRole: "existing_migrator",
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
    let insertCount = 0;
    let updateCount = 0;
    const fakeDatabase = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve(row === undefined ? [] : [row]) }),
        }),
      }),
      insert: () => ({
        values: (value: Row) => ({
          onConflictDoNothing: () => {
            // These are the actual builder_provisioning_journal CHECK constraints.
            expect(value.requestId).toMatch(
              /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
            );
            expect(value.requestDigest).toMatch(/^[0-9a-f]{64}$/u);
            expect(["pending", "settled"]).toContain(value.state);
            expect(value.record).toBeTypeOf("object");
            insertCount += 1;
            row ??= value;
            return Promise.resolve();
          },
        }),
      }),
      update: () => ({
        set: (value: Partial<Row>) => ({
          where: () => ({
            returning: () => {
              if (row === undefined) {
                throw new Error("Approval checkpoint update requires a prior insert.");
              }
              row = { ...row, ...value };
              updateCount += 1;
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
    expect(updateCount).toBe(1);
    expect(insertCount).toBe(2);
    const saved = await checkpoint.read();
    expect(saved?.native.nextNativeIndex).toBe(2);
  });
});
