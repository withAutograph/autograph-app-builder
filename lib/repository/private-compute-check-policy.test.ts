import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyPrivateComputeCheckPolicy } from "./private-compute-check-policy";
import {
  LEGACY_PRIVATE_COMPUTE_CHECK_TASK,
  PRIVATE_COMPUTE_CHECK_TASK,
  privateComputeProfileSchema,
} from "../sandbox/private-compute-profile";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const profile = () =>
  privateComputeProfileSchema.parse({
    version: 1,
    id: "private-checks-16gib-v1",
    vcpus: 8,
    memoryMiB: 16384,
    lintWorkers: 1,
    target: { sandboxId: "same", workspaceDrive: "same-drive" },
    checkPolicy: {
      path: "apps/example/.config/mise/tasks/check",
      beforeSha256: hash(LEGACY_PRIVATE_COMPUTE_CHECK_TASK),
      afterSha256: hash(PRIVATE_COMPUTE_CHECK_TASK),
    },
    limits: {
      version: 1,
      teamId: "team_owned",
      projectId: "prj_owned",
      plan: "pro",
      maxVcpus: 8,
      limited: false,
      observedAt: "2026-11-03T12:00:00.000Z",
    },
  });
describe("reviewed private check task", () => {
  it("changes only the exact frozen preimage and is replay safe", async () => {
    let content = LEGACY_PRIVATE_COMPUTE_CHECK_TASK;
    const writes: string[] = [];
    const sandbox = {
      readTextFile: () => Promise.resolve(content),
      writeTextFile: (input: { path: string; content: string }) => {
        writes.push(input.path);
        content = input.content;
        return Promise.resolve();
      },
    };
    const input = { sandbox, applyRoot: "/workspace/repository", profile: profile() };
    await applyPrivateComputeCheckPolicy(input);
    await applyPrivateComputeCheckPolicy(input);
    expect(writes).toEqual(["repository/apps/example/.config/mise/tasks/check"]);
    expect(content).toBe(PRIVATE_COMPUTE_CHECK_TASK);
  });
  it("preserves a custom or concurrently changed task", async () => {
    const original = "#!/bin/sh\nmise run app:security-check\nexec vp check --no-fmt\n";
    let writes = 0;
    await expect(
      applyPrivateComputeCheckPolicy({
        sandbox: {
          readTextFile: () => Promise.resolve(original),
          writeTextFile: () => {
            writes++;
            return Promise.resolve();
          },
        },
        applyRoot: "/workspace/repository",
        profile: profile(),
      }),
    ).rejects.toThrow("changed after planning");
    expect(writes).toBe(0);
  });
  it("denies unsupported provider capacity and modified fixed footprint", () => {
    const selected = profile();
    expect(privateComputeProfileSchema.safeParse({ ...selected, memoryMiB: 32768 }).success).toBe(
      false,
    );
    expect(
      privateComputeProfileSchema.safeParse({
        ...selected,
        limits: { ...selected.limits, plan: "hobby", maxVcpus: 4 },
      }).success,
    ).toBe(false);
  });
});
