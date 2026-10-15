import { z } from "zod";

const nativeProject = z.object({
  link: z
    .object({ productionBranch: z.string().min(1).nullable().optional() })
    .nullable()
    .optional(),
});

/** Logical Git identity stays fixed; the production branch uses generic physical Preview env scope. */
export const resolveNativePreviewEnvironmentGitBranch = (
  logicalBranch: string,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Parse actual provider project metadata here; absent metadata preserves the logical selector.
  project: unknown,
): string | null => {
  const parsed = nativeProject.safeParse(project);
  return parsed.success && parsed.data.link?.productionBranch === logicalBranch
    ? null
    : logicalBranch;
};

/** Missing physical metadata is the historical branch-specific selector, never generic Preview. */
export const savedPreviewEnvironmentGitBranch = (row: {
  branch: string;
  gitBranch?: string | null;
}): string | null => (row.gitBranch === undefined ? row.branch : row.gitBranch);

export const matchesPreviewEnvironmentGitBranch = (
  observed: string | null | undefined,
  expected: string | null,
): boolean => (observed ?? null) === expected;
