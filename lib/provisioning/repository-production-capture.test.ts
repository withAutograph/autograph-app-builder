import { describe, expect, it, vi } from "vitest";
import { createRepositoryProductionCaptureReader } from "./repository-production-capture";
import { GENERATED_RELEASE_MEMBERS } from "./hosted-operator-sandbox-launcher";
import type { GeneratedAppReleaseFiles } from "./hosted-operator-sandbox-launcher";
import type { RepositoryProductionCapture } from "./repository-production-management-subject";
import type { RepositoryProductionRequestOwner } from "./repository-production-dispatcher";

const authority = {
  issuer: "https://builder.test/api/auth",
  audience: "https://builder.test/mcp",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const owner: RepositoryProductionRequestOwner = {
  appId: "requests",
  sessionId: "session",
  ownerContext: {
    kind: "direct",
    authority,
    principal: { ...authority, scopes: ["autograph:send"] },
    sessionId: "session",
    adapterSessionId: "physical",
    adapterGeneration: 2,
  },
};
const context = { authority, target: { appId: owner.appId, sessionId: owner.sessionId } };
const storage = {
  kind: "postgres" as const,
  artifactRef: `_protected-operator/artifacts/generated-release/requests/${"a".repeat(64)}`,
  releaseId: "requests-v1",
  manifestSha256: "b".repeat(64),
  databaseEnvironment: "REQUESTS_DATABASE_URL",
};
const selection = {
  artifactRef: storage.artifactRef,
  releaseId: storage.releaseId,
  manifestSha256: storage.manifestSha256,
  schemaSha256: "c".repeat(64),
};
const fixture = () => {
  // SAFETY: Each member in the closed release contract receives its own controlled Buffer.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Every closed release member is populated above the typed boundary.
  const files = Object.fromEntries(
    GENERATED_RELEASE_MEMBERS.map((name) => [name, Buffer.from(name)]),
  ) as GeneratedAppReleaseFiles;
  const capture: RepositoryProductionCapture = {
    artifactRef: storage.artifactRef,
    files,
    description: {
      version: 1,
      app: { id: owner.appId, routes: ["/requests"], workspacePath: "apps/requests" },
      backend: { kind: "static" },
      validation: { browser: null, check: { task: "check" }, test: null },
    },
  };
  const guard = vi.fn<() => Promise<void>>().mockResolvedValue();
  const readSelection = vi
    .fn<Parameters<typeof createRepositoryProductionCaptureReader>[0]["readSelection"]>()
    .mockResolvedValue(selection);
  const readRelease = vi
    .fn<Parameters<typeof createRepositoryProductionCaptureReader>[0]["readRelease"]>()
    .mockResolvedValue(capture);
  const ports = { readSelection, readRelease };
  const reader = createRepositoryProductionCaptureReader(ports);
  const read = async () => await reader(context, storage, guard, owner);
  return { capture, guard, ports, read, reader, readRelease, readSelection };
};

describe("request-owned immutable Production capture reads", () => {
  it("reads one capture for repeated fresh selection and owner checks", async () => {
    const f = fixture();
    await f.read();
    const guardCount = f.guard.mock.calls.length;
    await f.read();
    await f.read();
    expect(f.readRelease).toHaveBeenCalledTimes(1);
    expect(f.readSelection).toHaveBeenCalledTimes(3);
    expect(f.guard.mock.calls.length).toBeGreaterThan(guardCount);
  });
  it("coalesces concurrent identical capture reads", async () => {
    const f = fixture();
    const pending = Promise.withResolvers<RepositoryProductionCapture>();
    f.readRelease.mockReturnValue(pending.promise);
    const first = f.read();
    const second = f.read();
    await vi.waitFor(() => {
      expect(f.readRelease).toHaveBeenCalled();
    });
    pending.resolve(f.capture);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(f.readRelease).toHaveBeenCalledTimes(1);
  });
  it("evicts failed reads and preserves the original failure", async () => {
    const f = fixture();
    const failure = new Error("read failed");
    f.readRelease.mockRejectedValueOnce(failure);
    await expect(f.read()).rejects.toBe(failure);
    await expect(f.read()).resolves.toEqual(f.capture);
    expect(f.readRelease).toHaveBeenCalledTimes(2);
  });
  it("does not share content across request instances", async () => {
    const f = fixture();
    await f.read();
    await createRepositoryProductionCaptureReader(f.ports)(context, storage, f.guard, owner);
    expect(f.readRelease).toHaveBeenCalledTimes(2);
  });
  it.each(["authority", "app", "session", "physical", "generation"] as const)(
    "does not borrow another %s binding",
    async (change) => {
      const f = fixture();
      await f.read();
      const changedContext = structuredClone(context);
      const changedOwner = structuredClone(owner);
      if (change === "authority") {
        changedContext.authority.workspaceId = "other-workspace";
      }
      if (change === "app") {
        changedContext.target.appId = "other-app";
      }
      if (change === "session") {
        changedContext.target.sessionId = "other-session";
      }
      if (change === "physical") {
        changedOwner.ownerContext.adapterSessionId = "other-physical";
      }
      if (change === "generation") {
        changedOwner.ownerContext.adapterGeneration += 1;
      }
      await f.reader(changedContext, storage, f.guard, changedOwner);
      expect(f.readRelease).toHaveBeenCalledTimes(2);
    },
  );
  it("revalidates selection before reuse and does not hide a changed schema expectation", async () => {
    const f = fixture();
    await f.read();
    const failure = new Error("schema expectation failed");
    f.readSelection.mockResolvedValue({ ...selection, schemaSha256: "d".repeat(64) });
    f.readRelease.mockRejectedValueOnce(failure);
    await expect(f.read()).rejects.toBe(failure);
    expect(f.readRelease).toHaveBeenCalledTimes(2);
  });
  it.each([
    undefined,
    { ...selection, releaseId: "other-release" },
    { ...selection, manifestSha256: "d".repeat(64) },
  ])(
    "rejects unavailable or mismatched fresh selection after a prior successful read",
    async (changed) => {
      const f = fixture();
      await f.read();
      f.readSelection.mockResolvedValue(changed);
      await expect(f.read()).rejects.toThrow("repository_production_capture_unavailable");
      expect(f.readRelease).toHaveBeenCalledTimes(1);
    },
  );
  it("does not reuse authority after owner revocation", async () => {
    const f = fixture();
    await f.read();
    const failure = new Error("owner revoked");
    f.guard.mockRejectedValue(failure);
    await expect(f.read()).rejects.toBe(failure);
    expect(f.readRelease).toHaveBeenCalledTimes(1);
  });
  it("rechecks ownership after pending content completes and evicts rejected custody", async () => {
    const f = fixture();
    const pending = Promise.withResolvers<RepositoryProductionCapture>();
    f.readRelease.mockReturnValueOnce(pending.promise);
    const first = f.read();
    await vi.waitFor(() => {
      expect(f.readRelease).toHaveBeenCalled();
    });
    const failure = new Error("owner revoked during read");
    f.guard.mockRejectedValue(failure);
    pending.resolve(f.capture);
    await expect(first).rejects.toBe(failure);
    f.guard.mockResolvedValue();
    await f.read();
    expect(f.readRelease).toHaveBeenCalledTimes(2);
  });
  it("returns independent mutable Buffers and descriptions", async () => {
    const f = fixture();
    const first = await f.read();
    first.files[GENERATED_RELEASE_MEMBERS[0]].fill(0);
    first.description?.app.routes.push("/mutated");
    const second = await f.read();
    expect(second.files[GENERATED_RELEASE_MEMBERS[0]]).toEqual(
      Buffer.from(GENERATED_RELEASE_MEMBERS[0]),
    );
    expect(second.description?.app.routes).toEqual(["/requests"]);
    expect(Buffer.isBuffer(second.files[GENERATED_RELEASE_MEMBERS[0]])).toBe(true);
  });
});
