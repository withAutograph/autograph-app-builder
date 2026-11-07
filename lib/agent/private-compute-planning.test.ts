import { describe, expect, it } from "vitest";
import { samePrivateComputeIntent } from "./private-compute-planning";
import {
  privateComputeProfileSchema,
  readPrivateComputeLimits,
} from "../sandbox/private-compute-profile";

const profile = () =>
  privateComputeProfileSchema.parse({
    checkPolicy: {
      afterSha256: "b".repeat(64),
      beforeSha256: "a".repeat(64),
      path: "apps/example/.config/mise/tasks/check",
    },
    id: "private-checks-16gib-v1",
    limits: {
      limited: false,
      maxVcpus: 8,
      observedAt: "2026-11-03T12:00:00.000Z",
      plan: "pro",
      projectId: "prj_owned",
      teamId: "team_owned",
      version: 1,
    },
    lintWorkers: 1,
    memoryMiB: 16_384,
    target: { sandboxId: "same", workspaceDrive: "same-drive" },
    vcpus: 8,
    version: 1,
  });
describe("private compute planning identity", () => {
  it("requires new planning for a first selection or changed physical target", () => {
    const next = profile();
    expect(samePrivateComputeIntent(undefined, next)).toBe(false);
    expect(
      samePrivateComputeIntent(next, { ...next, target: { ...next.target, sandboxId: "other" } }),
    ).toBe(false);
    expect(
      samePrivateComputeIntent(next, {
        ...next,
        target: { ...next.target, workspaceDrive: "other" },
      }),
    ).toBe(false);
    expect(
      samePrivateComputeIntent(next, {
        ...next,
        limits: { ...next.limits, projectId: "prj_other" },
      }),
    ).toBe(false);
    expect(
      samePrivateComputeIntent(next, {
        ...next,
        checkPolicy: { ...next.checkPolicy, afterSha256: "c".repeat(64) },
      }),
    ).toBe(false);
  });
  it("retains a completed intent across timestamp refresh and installed preimage", () => {
    const next = profile();
    expect(
      samePrivateComputeIntent(next, {
        ...next,
        checkPolicy: { ...next.checkPolicy, beforeSha256: next.checkPolicy.afterSha256 },
        limits: { ...next.limits, observedAt: "2026-11-04T12:00:00.000Z" },
      }),
    ).toBe(true);
  });
  it("requires the observed linked team and project rather than model-authored capacity", () => {
    const next = profile();
    expect(() => readPrivateComputeLimits({})).toThrow("team-plan observation");
    expect(() =>
      readPrivateComputeLimits({
        APP_BUILDER_PRIVATE_COMPUTE_LIMITS: JSON.stringify(next.limits),
        VERCEL_PROJECT_ID: next.limits.projectId,
        VERCEL_TEAM_ID: "team_other",
      }),
    ).toThrow("does not match");
    expect(
      readPrivateComputeLimits({
        APP_BUILDER_PRIVATE_COMPUTE_LIMITS: JSON.stringify(next.limits),
        VERCEL_PROJECT_ID: next.limits.projectId,
        VERCEL_TEAM_ID: next.limits.teamId,
      }),
    ).toEqual(next.limits);
  });
});
