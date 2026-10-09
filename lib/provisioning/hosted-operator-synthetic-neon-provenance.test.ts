/* oxlint-disable eslint/require-await -- provider-reader fixtures intentionally exercise Promise-based APIs. */
import { describe, expect, it, vi } from "vitest";
import {
  readNativePreviewNeonProvenance,
  snapshotSyntheticNeonEnrollment,
  syntheticNeonEnrollmentSchema,
} from "./hosted-operator-synthetic-neon-provenance";
import type { SyntheticNeonEnrollment } from "./hosted-operator-synthetic-neon-provenance";

interface BranchFixtureOverrides {
  default?: boolean;
  last_reset_at?: null;
  parent_id?: string;
  parent_lsn?: string;
  parent_timestamp?: string;
  pending_state?: string;
  restored_as?: null;
  restored_from?: null;
  restore_status?: null;
}

const enrollment = (): SyntheticNeonEnrollment => ({
  authority: "synthetic-only",
  branches: [
    {
      branchId: "br-child",
      createdAt: "2026-10-08T10:00:00Z",
      initSource: "parent-data",
      parentId: "br-parent",
      parentLsn: "0/16B6C50",
    },
    {
      branchId: "br-parent",
      createdAt: "2026-10-08T09:00:00Z",
      initSource: "parent-schema",
      parentId: "br-root",
      parentTimestamp: "2026-10-08T08:59:00Z",
    },
  ],
  creationApprovalReference: "approval-123",
  project: {
    createdAt: "2026-10-08T08:00:00Z",
    id: "project-123",
    ownerId: "org-123",
  },
  root: {
    branchId: "br-root",
    createdAt: "2026-10-08T08:01:00Z",
    initSource: "parent-data",
  },
  sourceBaselineReference: "baseline-456",
});

const project = () => ({
  project: {
    created_at: "2026-10-08T08:00:00Z",
    id: "project-123",
    owner_id: "org-123",
  },
});

const branch = (
  id: string,
  createdAt: string,
  initSource: string,
  values: BranchFixtureOverrides = {},
) => ({
  branch: {
    created_at: createdAt,
    current_state: "ready",
    default: id === "br-root",
    id,
    init_source: initSource,
    project_id: "project-123",
    ...values,
  },
});

const branchReads = (
  overrides: Map<string, ReturnType<typeof branch>> = new Map<string, ReturnType<typeof branch>>(),
) =>
  vi.fn(async (branchId: string) => {
    const fixtures = new Map([
      [
        "br-child",
        branch("br-child", "2026-10-08T10:00:00Z", "parent-data", {
          parent_id: "br-parent",
          parent_lsn: "0/16B6C50",
        }),
      ],
      [
        "br-parent",
        branch("br-parent", "2026-10-08T09:00:00Z", "parent-schema", {
          parent_id: "br-root",
          parent_timestamp: "2026-10-08T08:59:00Z",
        }),
      ],
      ["br-root", branch("br-root", "2026-10-08T08:01:00Z", "parent-data")],
      ...overrides,
    ]);
    return fixtures.get(branchId);
  });

describe("synthetic Neon provenance helper", () => {
  it("validates both allowed fork-position fields and requires at least one", () => {
    const valid = enrollment();
    valid.branches[0] = {
      ...valid.branches[0],
      parentTimestamp: "2026-10-08T09:59:00Z",
    };
    expect(syntheticNeonEnrollmentSchema.parse(valid).branches[0]).toMatchObject({
      parentLsn: "0/16B6C50",
      parentTimestamp: "2026-10-08T09:59:00Z",
    });

    expect(
      syntheticNeonEnrollmentSchema.safeParse({
        ...enrollment(),
        branches: [
          {
            branchId: "br-child",
            createdAt: "2026-10-08T10:00:00Z",
            initSource: "parent-data",
            parentId: "br-parent",
          },
          enrollment().branches[1],
        ],
      }).success,
    ).toBe(false);
  });

  it("clones and deeply freezes the complete enrollment snapshot", () => {
    const source = enrollment();
    const snapshot = snapshotSyntheticNeonEnrollment(source);
    expect(snapshot).not.toBe(source);
    expect(snapshot?.branches).not.toBe(source.branches);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.project)).toBe(true);
    expect(Object.isFrozen(snapshot?.root)).toBe(true);
    expect(Object.isFrozen(snapshot?.branches)).toBe(true);
    expect(Object.isFrozen(snapshot?.branches[0])).toBe(true);
    const firstSourceBranch = source.branches.at(0);
    if (firstSourceBranch === undefined) {
      throw new Error("Expected an enrolled child fixture.");
    }
    firstSourceBranch.parentId = "br-other";
    expect(snapshot?.branches[0]?.parentId).toBe("br-parent");
  });

  it("verifies the selected child and every enrolled ancestor before returning its source", async () => {
    const readBranch = branchReads();
    const result = await readNativePreviewNeonProvenance({
      enrollment: enrollment(),
      readBranch,
      readProject: async () => project(),
      scope: { branchId: "br-child", projectId: "project-123" },
    });
    expect(result).toBe("parent-data");
    expect(readBranch.mock.calls.map(([branchId]) => branchId)).toEqual([
      "br-child",
      "br-parent",
      "br-root",
    ]);
  });

  it("compares every enrolled fork-position field when both are returned", async () => {
    const bothPositions = enrollment();
    const firstChild = bothPositions.branches.at(0);
    if (firstChild === undefined) {
      throw new Error("Expected an enrolled child fixture.");
    }
    firstChild.parentTimestamp = "2026-10-08T09:59:00Z";
    const matchingBranch = branch("br-child", "2026-10-08T10:00:00Z", "parent-data", {
      parent_id: "br-parent",
      parent_lsn: "0/16B6C50",
      parent_timestamp: "2026-10-08T09:59:00Z",
    });
    await expect(
      readNativePreviewNeonProvenance({
        enrollment: bothPositions,
        readBranch: branchReads(new Map([["br-child", matchingBranch]])),
        readProject: async () => project(),
        scope: { branchId: "br-child", projectId: "project-123" },
      }),
    ).resolves.toBe("parent-data");

    const missingPosition = branch("br-child", "2026-10-08T10:00:00Z", "parent-data", {
      parent_id: "br-parent",
      parent_lsn: "0/16B6C50",
    });
    await expect(
      readNativePreviewNeonProvenance({
        enrollment: bothPositions,
        readBranch: branchReads(new Map([["br-child", missingPosition]])),
        readProject: async () => project(),
        scope: { branchId: "br-child", projectId: "project-123" },
      }),
    ).rejects.toThrow("Protected Preview Neon provenance is unavailable.");
  });

  it("supports an enrolled schema-only root as the selected branch", async () => {
    const selected = enrollment();
    selected.root.initSource = "schema-only";
    const readBranch = branchReads(
      new Map([["br-root", branch("br-root", "2026-10-08T08:01:00Z", "schema-only")]]),
    );
    await expect(
      readNativePreviewNeonProvenance({
        enrollment: selected,
        readBranch,
        readProject: async () => project(),
        scope: { branchId: "br-root", projectId: "project-123" },
      }),
    ).resolves.toBe("schema-only");
    expect(readBranch).toHaveBeenCalledTimes(1);
  });

  it("walks a long enrolled ancestry without a depth limit", async () => {
    const longEnrollment = enrollment();
    const branchCount = 130;
    longEnrollment.branches = Array.from({ length: branchCount }, (_, index) => ({
      branchId: `br-chain-${index}`,
      createdAt: "2026-10-08T10:00:00Z",
      initSource: "parent-schema",
      parentId: index === branchCount - 1 ? "br-root" : `br-chain-${index + 1}`,
      parentLsn: `0/${index + 1}`,
    }));
    const providerBranches = new Map(
      longEnrollment.branches.map((child) => [
        child.branchId,
        branch(child.branchId, child.createdAt, child.initSource, {
          parent_id: child.parentId,
          parent_lsn: child.parentLsn,
        }),
      ]),
    );
    providerBranches.set("br-root", branch("br-root", "2026-10-08T08:01:00Z", "parent-data"));
    let outstandingReads = 0;
    let maximumOutstandingReads = 0;
    const readBranch = vi.fn(async (branchId: string) => {
      outstandingReads += 1;
      maximumOutstandingReads = Math.max(maximumOutstandingReads, outstandingReads);
      try {
        return providerBranches.get(branchId);
      } finally {
        outstandingReads -= 1;
      }
    });

    await expect(
      readNativePreviewNeonProvenance({
        enrollment: longEnrollment,
        readBranch,
        readProject: async () => project(),
        scope: { branchId: "br-chain-0", projectId: "project-123" },
      }),
    ).resolves.toBe("parent-schema");
    expect(readBranch).toHaveBeenCalledTimes(branchCount + 1);
    expect(maximumOutstandingReads).toBe(1);
  });

  it("keeps legacy validation branch-only and allows only its established sources", async () => {
    const readProject = vi.fn(async () => project());
    const readBranch = vi.fn(async () =>
      branch("br-legacy", "2026-10-08T10:00:00Z", "parent-schema", {
        default: false,
      }),
    );
    await expect(
      readNativePreviewNeonProvenance({
        readBranch,
        readProject,
        scope: { branchId: "br-legacy", projectId: "project-123" },
      }),
    ).resolves.toBe("parent-schema");
    expect(readProject).not.toHaveBeenCalled();
    expect(readBranch).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "changed project owner",
      readProject: { project: { ...project().project, owner_id: "org-other" } },
    },
    {
      label: "changed project creation time",
      readProject: { project: { ...project().project, created_at: "2026-10-08T08:00:01Z" } },
    },
  ])("denies enrollment with $label", async ({ readProject }) => {
    await expect(
      readNativePreviewNeonProvenance({
        enrollment: enrollment(),
        readBranch: branchReads(),
        readProject: async () => readProject,
        scope: { branchId: "br-child", projectId: "project-123" },
      }),
    ).rejects.toThrow("Protected Preview Neon provenance is unavailable.");
  });

  it.each([
    {
      branchId: "br-unlisted",
      label: "an unlisted selected branch",
      overrides: new Map<string, ReturnType<typeof branch>>(),
    },
    {
      branchId: "br-child",
      label: "a mismatched child fork position",
      overrides: new Map([
        [
          "br-child",
          branch("br-child", "2026-10-08T10:00:00Z", "parent-data", {
            parent_id: "br-parent",
            parent_lsn: "0/16B6C51",
          }),
        ],
      ]),
    },
    {
      branchId: "br-child",
      label: "a selected default child",
      overrides: new Map([
        [
          "br-child",
          branch("br-child", "2026-10-08T10:00:00Z", "parent-data", {
            default: true,
            parent_id: "br-parent",
            parent_lsn: "0/16B6C50",
          }),
        ],
      ]),
    },
    {
      branchId: "br-child",
      label: "an imported child",
      overrides: new Map([
        [
          "br-child",
          branch("br-child", "2026-10-08T10:00:00Z", "import", {
            parent_id: "br-parent",
            parent_lsn: "0/16B6C50",
          }),
        ],
      ]),
    },
    {
      branchId: "br-child",
      label: "a child with reset metadata",
      overrides: new Map([
        [
          "br-child",
          branch("br-child", "2026-10-08T10:00:00Z", "parent-data", {
            last_reset_at: null,
            parent_id: "br-parent",
            parent_lsn: "0/16B6C50",
          }),
        ],
      ]),
    },
    {
      branchId: "br-child",
      label: "a child with restore metadata",
      overrides: new Map([
        [
          "br-child",
          branch("br-child", "2026-10-08T10:00:00Z", "parent-data", {
            parent_id: "br-parent",
            parent_lsn: "0/16B6C50",
            restore_status: null,
          }),
        ],
      ]),
    },
    {
      branchId: "br-child",
      label: "a child with restored-from metadata",
      overrides: new Map([
        [
          "br-child",
          branch("br-child", "2026-10-08T10:00:00Z", "parent-data", {
            parent_id: "br-parent",
            parent_lsn: "0/16B6C50",
            restored_from: null,
          }),
        ],
      ]),
    },
    {
      branchId: "br-child",
      label: "a child with restored-as metadata",
      overrides: new Map([
        [
          "br-child",
          branch("br-child", "2026-10-08T10:00:00Z", "parent-data", {
            parent_id: "br-parent",
            parent_lsn: "0/16B6C50",
            restored_as: null,
          }),
        ],
      ]),
    },
    {
      branchId: "br-child",
      label: "a child with a non-ready pending state",
      overrides: new Map([
        [
          "br-child",
          branch("br-child", "2026-10-08T10:00:00Z", "parent-data", {
            parent_id: "br-parent",
            parent_lsn: "0/16B6C50",
            pending_state: "suspending",
          }),
        ],
      ]),
    },
  ])("denies $label", async ({ branchId, overrides }) => {
    await expect(
      readNativePreviewNeonProvenance({
        enrollment: enrollment(),
        readBranch: branchReads(overrides),
        readProject: async () => project(),
        scope: { branchId, projectId: "project-123" },
      }),
    ).rejects.toThrow("Protected Preview Neon provenance is unavailable.");
  });

  it("denies root metadata that records a parent or fork position", async () => {
    await expect(
      readNativePreviewNeonProvenance({
        enrollment: enrollment(),
        readBranch: branchReads(
          new Map([
            [
              "br-root",
              branch("br-root", "2026-10-08T08:01:00Z", "parent-data", {
                parent_id: "br-unexpected",
              }),
            ],
          ]),
        ),
        readProject: async () => project(),
        scope: { branchId: "br-child", projectId: "project-123" },
      }),
    ).rejects.toThrow("Protected Preview Neon provenance is unavailable.");
  });

  it("rejects cycles, duplicated enrollment IDs, and provider read failures opaquely", async () => {
    const cyclic = enrollment();
    const cyclicParent = cyclic.branches.at(1);
    if (cyclicParent === undefined) {
      throw new Error("Expected an enrolled parent fixture.");
    }
    cyclic.branches[1] = { ...cyclicParent, parentId: "br-child" };
    await expect(
      readNativePreviewNeonProvenance({
        enrollment: cyclic,
        readBranch: branchReads(),
        readProject: async () => project(),
        scope: { branchId: "br-child", projectId: "project-123" },
      }),
    ).rejects.toThrow("Protected Preview Neon provenance is unavailable.");

    const duplicate = enrollment();
    const duplicateParent = duplicate.branches.at(1);
    if (duplicateParent === undefined) {
      throw new Error("Expected an enrolled parent fixture.");
    }
    duplicate.branches[1] = { ...duplicateParent, branchId: "br-child" };
    const readProject = vi.fn(async () => project());
    await expect(
      readNativePreviewNeonProvenance({
        enrollment: duplicate,
        readBranch: branchReads(),
        readProject,
        scope: { branchId: "br-child", projectId: "project-123" },
      }),
    ).rejects.toThrow("Protected Preview Neon provenance is unavailable.");
    expect(readProject).not.toHaveBeenCalled();

    await expect(
      readNativePreviewNeonProvenance({
        enrollment: enrollment(),
        readBranch: async () => {
          throw new Error("provider details");
        },
        readProject: async () => project(),
        scope: { branchId: "br-child", projectId: "project-123" },
      }),
    ).rejects.toThrow("Protected Preview Neon provenance is unavailable.");
  });

  it("snapshots enrollment before invoking its first asynchronous provider read", async () => {
    const source = enrollment();
    const verification = readNativePreviewNeonProvenance({
      enrollment: source,
      readBranch: branchReads(),
      readProject: async () => {
        const firstBranch = source.branches.at(0);
        if (firstBranch === undefined) {
          throw new Error("Expected an enrolled child fixture.");
        }
        firstBranch.parentId = "br-attacker";
        return project();
      },
      scope: { branchId: "br-child", projectId: "project-123" },
    });
    await expect(verification).resolves.toBe("parent-data");
  });
});
