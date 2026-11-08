import { describe, expect, it } from "vitest";
import { activatePrivateComputeProfile } from "./private-compute-activation";
import type { PrivateComputeNative, PrivateComputeActivation } from "./private-compute-activation";
import { privateComputeProfileSchema } from "./private-compute-profile";

const profile = () =>
  privateComputeProfileSchema.parse({
    version: 1,
    id: "private-checks-16gib-v1",
    vcpus: 8,
    memoryMiB: 16_384,
    lintWorkers: 1,
    target: { sandboxId: "owned-sandbox", workspaceDrive: "owned-drive" },
    checkPolicy: {
      path: "apps/example/.config/mise/tasks/check",
      beforeSha256: "a".repeat(64),
      afterSha256: "b".repeat(64),
    },
    limits: {
      limited: false,
      maxVcpus: 8,
      observedAt: "2026-11-03T12:00:00.000Z",
      plan: "pro",
      projectId: "prj_private",
      teamId: "team_private",
      version: 1,
    },
  });
const fixture = () => {
  let status: PrivateComputeNative["status"] = "running";
  let vcpus = 2;
  let sessionVcpus = 2;
  let record: PrivateComputeActivation | undefined;
  const effects: string[] = [];
  let uncertainUpdate = false;
  const native: PrivateComputeNative = {
    name: "owned-sandbox",
    persistent: true,
    mounts: { "/workspace": { drive: "owned-drive", mode: "read-write" } },
    get status() {
      return status;
    },
    get vcpus() {
      return vcpus;
    },
    get memory() {
      return vcpus * 2048;
    },
    currentSession: () => ({ vcpus: sessionVcpus, memory: sessionVcpus * 2048 }),
    stop: () => {
      effects.push("stop");
      status = "stopped";
      return Promise.resolve(globalThis.undefined);
    },
    update: (input) => {
      effects.push("update");
      if (uncertainUpdate) {
        return Promise.reject(new Error("Lost provider reply"));
      }
      vcpus = input.resources?.vcpus ?? vcpus;
      return Promise.resolve();
    },
  };
  const ports = {
    read: () => Promise.resolve(native),
    resume: () => {
      effects.push("resume");
      status = "running";
      sessionVcpus = vcpus;
      return Promise.resolve(native);
    },
    readActivation: () => Promise.resolve(record),
    writeActivation: (value: PrivateComputeActivation) => {
      record = value;
      return Promise.resolve();
    },
    assertCurrent: () => {},
  };
  const input = {
    profile: profile(),
    proposalDigest: "1".repeat(64),
    callId: "approved-apply",
    appId: "example",
    sessionId: "actual-session",
  };
  return {
    input,
    ports,
    native,
    effects,
    get record() {
      return record;
    },
    observeStatus: (value: PrivateComputeNative["status"]) => {
      status = value;
    },
    uncertain: () => {
      uncertainUpdate = true;
    },
    observeConfigured: () => {
      vcpus = 8;
    },
  };
};
describe("approved private compute transition", () => {
  it("preserves the exact named target and Drive, checks active session resources, and reuses observed success", async () => {
    const f = fixture();
    await expect(activatePrivateComputeProfile(f.input, f.ports)).resolves.toBe(f.native);
    expect(f.effects).toEqual(["stop", "update", "resume"]);
    expect(f.native.currentSession()).toEqual({ memory: 16_384, vcpus: 8 });
    expect(f.record).toMatchObject({ phase: "ready", proposalDigest: f.input.proposalDigest });
    await activatePrivateComputeProfile({ ...f.input, proposalDigest: "2".repeat(64) }, f.ports);
    expect(f.effects).toEqual(["stop", "update", "resume"]);
    expect(f.record?.proposalDigest).toBe("2".repeat(64));
  });
  it("never sends a provider effect when current approval or cancellation authority fails", async () => {
    const f = fixture();
    await expect(
      activatePrivateComputeProfile(f.input, {
        ...f.ports,
        assertCurrent: () => {
          throw new Error("Approval revoked");
        },
      }),
    ).rejects.toThrow("Approval revoked");
    expect(f.effects).toEqual([]);
  });
  it("does not update a VM that is still stopping or snapshotting", async () => {
    const f = fixture();
    for (const status of ["stopping", "snapshotting"] as const) {
      f.observeStatus(status);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each independent observed native state must deny effects.
      await expect(activatePrivateComputeProfile(f.input, f.ports)).rejects.toThrow(
        "still transitioning",
      );
    }
    expect(f.effects).toEqual([]);
  });
  it("rejects a substituted Drive before any effect", async () => {
    const f = fixture();
    await expect(
      activatePrivateComputeProfile(
        {
          ...f.input,
          profile: {
            ...f.input.profile,
            target: { ...f.input.profile.target, workspaceDrive: "foreign" },
          },
        },
        f.ports,
      ),
    ).rejects.toThrow("exact persistent");
    expect(f.effects).toEqual([]);
  });
  it("does not resend an uncertain update under the same or a different proposal, and reconciles only actual readback", async () => {
    const f = fixture();
    f.uncertain();
    await expect(activatePrivateComputeProfile(f.input, f.ports)).rejects.toThrow(
      "Lost provider reply",
    );
    expect(f.record?.phase).toBe("configuring");
    await expect(
      activatePrivateComputeProfile({ ...f.input, proposalDigest: "3".repeat(64) }, f.ports),
    ).rejects.toThrow("uncertain provider outcome");
    expect(f.effects).toEqual(["stop", "update"]);
    f.observeConfigured();
    await activatePrivateComputeProfile(f.input, f.ports);
    expect(f.effects).toEqual(["stop", "update", "resume"]);
    expect(f.record?.phase).toBe("ready");
  });
});
