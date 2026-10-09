/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Neon responses enter as untrusted provider JSON and are schema parsed before use. */
import { z } from "zod";

const id = z.string().min(1);
const timestamp = z.iso.datetime({ offset: true });
const forkPosition = z.string().min(1);

const syntheticNeonBranchEnrollmentSchema = z
  .strictObject({
    branchId: id,
    createdAt: timestamp,
    initSource: z.enum(["parent-data", "parent-schema"]),
    parentId: id,
    parentLsn: forkPosition.optional(),
    parentTimestamp: timestamp.optional(),
  })
  .superRefine((branch, context) => {
    if (branch.parentLsn === undefined && branch.parentTimestamp === undefined) {
      context.addIssue({
        code: "custom",
        message: "An enrolled Neon child needs a parent fork position.",
      });
    }
  });

export const syntheticNeonEnrollmentSchema = z
  .strictObject({
    authority: z.literal("synthetic-only"),
    branches: z.array(syntheticNeonBranchEnrollmentSchema),
    creationApprovalReference: z.string().min(1),
    project: z.strictObject({
      createdAt: timestamp,
      id,
      ownerId: id,
    }),
    root: z.strictObject({
      branchId: id,
      createdAt: timestamp,
      initSource: z.enum(["parent-data", "schema-only"]),
    }),
    sourceBaselineReference: z.string().min(1),
  })
  .superRefine((enrollment, context) => {
    const branchIds = new Set<string>([enrollment.root.branchId]);
    for (const [index, child] of enrollment.branches.entries()) {
      if (branchIds.has(child.branchId)) {
        context.addIssue({
          code: "custom",
          message: "Synthetic Neon enrollment branch IDs must be unique and exclude the root.",
          path: ["branches", index, "branchId"],
        });
      }
      branchIds.add(child.branchId);
    }
  });

export type SyntheticNeonEnrollment = z.infer<typeof syntheticNeonEnrollmentSchema>;
export type NativePreviewNeonInitSource = "parent-data" | "parent-schema" | "schema-only";

const freezeEnrollment = (value: SyntheticNeonEnrollment): SyntheticNeonEnrollment => {
  for (const child of value.branches) {
    Object.freeze(child);
  }
  Object.freeze(value.branches);
  Object.freeze(value.project);
  Object.freeze(value.root);
  return Object.freeze(value);
};

/** Parse, clone, and freeze the deployment-owned enrollment before any asynchronous work. */
export const snapshotSyntheticNeonEnrollment = (
  input: SyntheticNeonEnrollment | undefined,
): SyntheticNeonEnrollment | undefined => {
  if (input === undefined) {
    return undefined;
  }
  return freezeEnrollment(syntheticNeonEnrollmentSchema.parse(input));
};

const unavailable = () => new Error("Protected Preview Neon provenance is unavailable.");

const jsonObjectSchema = z.record(z.string(), z.unknown());
type JsonObject = z.infer<typeof jsonObjectSchema>;

const record = (value: unknown): JsonObject => jsonObjectSchema.parse(value);

const unwrap = (value: unknown, key: "project" | "branch") => {
  const outer = record(value);
  return Object.hasOwn(outer, key) ? outer[key] : outer;
};

const providerProjectSchema = z.object({
  created_at: timestamp,
  id,
  owner_id: id,
});

const providerBranchSchema = z.object({
  created_at: timestamp,
  current_state: z.string().min(1),
  default: z.boolean(),
  id,
  init_source: z.string().min(1),
  parent_id: id.optional(),
  parent_lsn: forkPosition.optional(),
  parent_timestamp: timestamp.optional(),
  pending_state: z.string().min(1).optional(),
  project_id: id,
});

const rejectPrivateLineageChanges = (branch: JsonObject) => {
  for (const key of ["last_reset_at", "restore_status", "restored_from", "restored_as"]) {
    if (Object.hasOwn(branch, key)) {
      throw unavailable();
    }
  }
};

const verifyOperationalBranch = (
  raw: unknown,
  expected: {
    createdAt: string;
    default: boolean;
    id: string;
    initSource: string;
    parentId?: string;
    parentLsn?: string;
    parentTimestamp?: string;
    projectId: string;
  },
) => {
  const provider = record(unwrap(raw, "branch"));
  rejectPrivateLineageChanges(provider);
  const branch = providerBranchSchema.parse(provider);
  const mismatches = [
    branch.created_at !== expected.createdAt,
    branch.current_state !== "ready",
    branch.default !== expected.default,
    branch.id !== expected.id,
    branch.init_source !== expected.initSource,
    branch.parent_id !== expected.parentId,
    branch.parent_lsn !== expected.parentLsn,
    branch.parent_timestamp !== expected.parentTimestamp,
    branch.pending_state !== undefined && branch.pending_state !== "ready",
    branch.project_id !== expected.projectId,
  ];
  if (mismatches.some(Boolean)) {
    throw unavailable();
  }
};

export interface ReadNativePreviewNeonProvenanceInput {
  scope: { projectId: string; branchId: string };
  enrollment?: SyntheticNeonEnrollment;
  readProject: () => Promise<unknown>;
  readBranch: (branchId: string) => Promise<unknown>;
}

const readLegacySource = async (
  scope: { projectId: string; branchId: string },
  readBranch: ReadNativePreviewNeonProvenanceInput["readBranch"],
): Promise<NativePreviewNeonInitSource> => {
  const raw = record(unwrap(await readBranch(scope.branchId), "branch"));
  const branch = z
    .object({
      default: z.literal(false),
      id,
      init_source: z.enum(["parent-schema", "schema-only"]),
      project_id: id,
    })
    .parse(raw);
  if (branch.id !== scope.branchId || branch.project_id !== scope.projectId) {
    throw unavailable();
  }
  return branch.init_source;
};

const readEnrolledSource = async (
  scope: { projectId: string; branchId: string },
  enrollment: SyntheticNeonEnrollment,
  readProject: ReadNativePreviewNeonProvenanceInput["readProject"],
  readBranch: ReadNativePreviewNeonProvenanceInput["readBranch"],
): Promise<NativePreviewNeonInitSource> => {
  if (scope.projectId !== enrollment.project.id) {
    throw unavailable();
  }

  const enrolledById = new Map<string, SyntheticNeonEnrollment["branches"][number]>();
  for (const child of enrollment.branches) {
    if (child.branchId === enrollment.root.branchId || enrolledById.has(child.branchId)) {
      throw unavailable();
    }
    enrolledById.set(child.branchId, child);
  }

  const { root } = enrollment;
  const visited = new Set<string>();
  const lineage: SyntheticNeonEnrollment["branches"] = [];
  let currentId = scope.branchId;
  let selectedSource: NativePreviewNeonInitSource | undefined;
  while (currentId !== root.branchId) {
    if (visited.has(currentId)) {
      throw unavailable();
    }
    visited.add(currentId);

    const enrolledBranch = enrolledById.get(currentId);
    if (enrolledBranch === undefined) {
      throw unavailable();
    }
    lineage.push(enrolledBranch);
    if (currentId === scope.branchId) {
      selectedSource = enrolledBranch.initSource;
    }
    currentId = enrolledBranch.parentId;
  }

  const project = providerProjectSchema.parse(unwrap(await readProject(), "project"));
  const projectMismatch = [
    project.id !== enrollment.project.id,
    project.owner_id !== enrollment.project.ownerId,
    project.created_at !== enrollment.project.createdAt,
  ];
  if (projectMismatch.some(Boolean)) {
    throw unavailable();
  }

  for (const enrolledBranch of lineage) {
    // Each read refreshes owner credentials; keep at most one provider request outstanding.
    // oxlint-disable-next-line react-doctor/async-await-in-loop, eslint/no-await-in-loop -- sequential reads are intentional credential-refresh backpressure.
    const raw = await readBranch(enrolledBranch.branchId);
    verifyOperationalBranch(raw, {
      createdAt: enrolledBranch.createdAt,
      default: false,
      id: enrolledBranch.branchId,
      initSource: enrolledBranch.initSource,
      parentId: enrolledBranch.parentId,
      parentLsn: enrolledBranch.parentLsn,
      parentTimestamp: enrolledBranch.parentTimestamp,
      projectId: enrollment.project.id,
    });
  }
  const rawRoot = await readBranch(root.branchId);
  verifyOperationalBranch(rawRoot, {
    createdAt: root.createdAt,
    default: true,
    id: root.branchId,
    initSource: root.initSource,
    projectId: enrollment.project.id,
  });
  return selectedSource ?? root.initSource;
};

/** Verify the configured synthetic branch lineage using provider metadata only. */
export const readNativePreviewNeonProvenance = async ({
  scope: scopeInput,
  enrollment: enrollmentInput,
  readProject,
  readBranch,
}: ReadNativePreviewNeonProvenanceInput): Promise<NativePreviewNeonInitSource> => {
  try {
    const scope = z.strictObject({ branchId: id, projectId: id }).parse(scopeInput);
    const enrollment = snapshotSyntheticNeonEnrollment(enrollmentInput);
    return enrollment === undefined
      ? await readLegacySource(scope, readBranch)
      : await readEnrolledSource(scope, enrollment, readProject, readBranch);
  } catch {
    throw unavailable();
  }
};
