import { APIError } from "@vercel/sandbox";
import type { Drive, Sandbox } from "@vercel/sandbox";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxProviderSessionContext } from "eve/sandbox/provider";
import { createBuilderVercelProvider, createProviderFetch } from "./vercel-backend";
import { getVercelPreviewProvider } from "./vercel-preview-provider";

const sdk = vi.hoisted(() => ({
  create:
    vi.fn<(options: Parameters<typeof Sandbox.create>[0]) => Promise<Pick<Sandbox, "name">>>(),
  get: vi.fn<(options: Parameters<typeof Sandbox.get>[0]) => Promise<Pick<Sandbox, "name">>>(),
}));
const drives = vi.hoisted(() => ({
  getOrCreate:
    vi.fn<
      (
        options: Parameters<typeof Drive.getOrCreate>[0],
      ) => Promise<Pick<Drive, "driveId" | "name" | "projectId" | "region">>
    >(),
  list: vi.fn(),
}));
const authority = vi.hoisted(() => vi.fn());
// oxlint-disable-next-line anti-slop/no-module-mocking -- Mock only the external SDK boundary so this test cannot create provider resources.
vi.mock("@vercel/sandbox", async () => ({
  ...(await vi.importActual<{ APIError: typeof APIError }>("@vercel/sandbox")),
  DEFAULT_SANDBOX_REGION: "iad1",
  Drive: drives,
  Sandbox: sdk,
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- The persistent authority store is a terminal provider boundary in these lifecycle tests.
vi.mock("./deployment-execution-lease", () => ({ assertHostedSandboxCommandAuthority: authority }));
const context = { session: { id: "provider-test" } } as SandboxProviderSessionContext;
const nativeFixture = () => ({
  delete: vi.fn().mockResolvedValue(null),
  fs: {
    lstat: vi.fn().mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOENT" })),
    mkdir: vi.fn().mockResolvedValue(null),
  },
  mounts: { "/workspace": { drive: "drive-owned", mode: "read-write" } },
  name: "owned-name",
  persistent: true,
  region: "iad1",
  readFileToBuffer: vi.fn().mockResolvedValue(null),
  runCommand: vi.fn().mockResolvedValue({
    exitCode: 0,
    kill: vi.fn(async () => {
      await Promise.resolve();
    }),
    stderr: () => Promise.resolve(""),
    stdout: () => Promise.resolve("/home/vercel\n"),
    wait: () => Promise.resolve({ exitCode: 0 }),
  }),
  status: "running",
  stop: vi.fn().mockResolvedValue(null),
  writeFiles: vi.fn().mockResolvedValue(null),
});

const startedSandboxName = `app-builder-${createHash("sha256").update(context.session.id).digest("hex").slice(0, 40)}`;
const startedDriveName = `${startedSandboxName}-workspace`;
const driveFixture = (name = "owned-drive") => ({
  delete: vi.fn().mockResolvedValue(null),
  driveId: "drive-owned",
  name,
  projectId: "project-owned",
  region: "iad1",
});
const listedDrives = (...entries: ReturnType<typeof driveFixture>[]) => ({
  async *[Symbol.asyncIterator]() {
    yield* entries;
  },
});
const seedStorage = (
  native: ReturnType<typeof nativeFixture>,
  initial: readonly (readonly [string, Buffer])[],
) => {
  const files = new Map(initial);
  native.fs.lstat.mockImplementation((destination: string) =>
    files.has(destination)
      ? Promise.resolve({})
      : Promise.reject(Object.assign(new Error("not found"), { code: "ENOENT" })),
  );
  native.writeFiles.mockImplementation(
    (values: readonly { path: string; content: Uint8Array }[]) => {
      for (const file of values) {
        files.set(file.path, Buffer.from(file.content));
      }
      return Promise.resolve(null);
    },
  );
  return files;
};

const driveState = {
  id: "drive-owned",
  name: "owned-drive",
  projectId: "project-owned",
  region: "iad1",
  sandboxName: "owned-name",
} as const;

describe("Builder Vercel provider", () => {
  beforeEach(() => {
    sdk.create.mockReset();
    sdk.get.mockReset();
    authority.mockReset();
    drives.getOrCreate
      .mockReset()
      .mockImplementation((options: { name: string }) =>
        Promise.resolve(driveFixture(options.name)),
      );
    drives.list.mockReset().mockResolvedValue(listedDrives(driveFixture()));
  });
  it("prepares public resource targets without contacting Vercel or capturing source bytes", async () => {
    const provider = createBuilderVercelProvider();
    const artifact = await provider.prepare({
      files: {
        list: () => Promise.resolve([]),
        read: () => Promise.resolve(Buffer.alloc(0)),
        readText: () => Promise.resolve(""),
      },
      host: {
        loadOptionalPackage: async () => {
          await Promise.resolve();
          throw new Error("Not used by preparation fixture");
        },
        resolveProjectPath: (path) => path,
      },
      resources: {
        skills: {
          files: [{ content: "guide", relativePath: "design/SKILL.md" }],
          key: "skills",
          mountPath: "/unused",
          targetPath: "$HOME/.agents/skills",
        },
        source: { kind: "none" },
        workspace: {
          files: [{ content: "seed", relativePath: "seed.txt" }],
          key: "workspace",
          mountPath: "/unused",
          targetPath: "/workspace",
        },
      },
      sourceRevision: "fixture",
      storagePath: "/fixture",
    });
    expect(artifact.files.map((file) => file.path)).toEqual([
      "/workspace/seed.txt",
      "$HOME/.agents/skills/design/SKILL.md",
    ]);
    expect(sdk.create).not.toHaveBeenCalled();
    expect(drives.getOrCreate).not.toHaveBeenCalled();
  });
  it("mounts its private Drive before initialization and retains only provider identity in state", async () => {
    const native = nativeFixture();
    const drive = driveFixture(startedDriveName);
    drives.getOrCreate.mockResolvedValue(drive);
    sdk.create.mockResolvedValue(native);
    const provider = createBuilderVercelProvider({
      sandboxEnvironment: { MISE_DATA_DIR: "/runtime" },
    });
    const result = await provider.start(context, undefined, {
      files: [
        { content: Buffer.from("guide").toString("base64"), path: "$HOME/.agents/skills/SKILL.md" },
      ],
    });
    expect(drives.getOrCreate).toHaveBeenCalledOnce();
    const driveOptions = drives.getOrCreate.mock.calls[0]?.[0];
    const createOptions = sdk.create.mock.calls[0]?.[0];
    if (driveOptions === undefined || createOptions === undefined) {
      throw new Error("Provider creation options missing");
    }
    expect(driveOptions).toMatchObject({ name: `${createOptions.name}-workspace`, region: "iad1" });
    expect(driveOptions).not.toHaveProperty("maxSize");
    expect(createOptions).toMatchObject({
      env: { MISE_DATA_DIR: "/runtime" },
      image: "vcr.vercel.com/vercel/eve/base:0.68.0",
      mounts: { "/workspace": drive },
      networkPolicy: "allow-all",
      persistent: true,
      region: "iad1",
    });
    expect(createOptions).not.toHaveProperty("source");
    expect(createOptions.fetch).toBe(driveOptions.fetch);
    expect(drives.getOrCreate.mock.invocationCallOrder[0]).toBeLessThan(
      sdk.create.mock.invocationCallOrder[0] ?? 0,
    );
    expect(sdk.create.mock.invocationCallOrder[0]).toBeLessThan(
      native.fs.mkdir.mock.invocationCallOrder[0] ?? 0,
    );
    expect(result.state.workspaceDrive).toMatchObject({
      id: drive.driveId,
      name: drive.name,
      projectId: drive.projectId,
      region: drive.region,
      sandboxName: native.name,
    });
    expect(native.writeFiles).toHaveBeenCalledWith(
      [{ content: Buffer.from("guide"), path: "/home/vercel/.agents/skills/SKILL.md" }],
      expect.anything(),
    );
    expect(await getVercelPreviewProvider(result.handle.sandbox.id)).toBe(native);
    sdk.get.mockResolvedValue(native);
    const replacementContext = {
      ...context,
      session: { ...context.session, id: "replacement-adapter" },
    };
    const resumed = await provider.resume(
      replacementContext,
      { files: [] },
      structuredClone(result.state),
    );
    expect(sdk.get).toHaveBeenCalledWith(
      expect.objectContaining({ name: native.name, resume: true }),
    );
    expect(sdk.create).toHaveBeenCalledOnce();
    expect(drives.getOrCreate).toHaveBeenCalledOnce();
    expect(drives.list).not.toHaveBeenCalled();
    await resumed.onSessionStop();
    expect(drive.delete).not.toHaveBeenCalled();
  });
  it.each(["onRuntimeShutdown", "onSessionStop"] as const)(
    "%s preserves state and reconnects without applying new source or seeds",
    async (close) => {
      const original = nativeFixture();
      const drive = driveFixture(startedDriveName);
      drives.getOrCreate.mockResolvedValue(drive);
      drives.list.mockResolvedValue(listedDrives(drive));
      sdk.create.mockResolvedValue(original);
      const provider = createBuilderVercelProvider();
      const started = await provider.start(context, undefined, { files: [] });
      // A detached copy accompanies a later Eve process's provider instance.
      const state = structuredClone(started.state);
      await started.handle[close]();
      expect(original.stop).toHaveBeenCalledOnce();
      expect(original.delete).not.toHaveBeenCalled();
      expect(drives.list).not.toHaveBeenCalled();
      expect(drives.getOrCreate).toHaveBeenCalledOnce();
      await expect(getVercelPreviewProvider(original.name)).rejects.toThrow("not connected");

      const reattached = nativeFixture();
      const editedBytes = Buffer.from([0, 255, 12, 34]);
      reattached.readFileToBuffer.mockResolvedValue(editedBytes);
      sdk.get.mockResolvedValue(reattached);
      const recovered = await createBuilderVercelProvider().resume(
        context,
        {
          files: [
            { content: Buffer.from("changed seed").toString("base64"), path: "/workspace/new" },
          ],
        },
        state,
      );
      expect(await recovered.sandbox.readBinaryFile({ path: "unpublished.bin" })).toEqual(
        editedBytes,
      );
      expect(sdk.create).toHaveBeenCalledOnce();
      expect(reattached.runCommand).not.toHaveBeenCalled();
      expect(reattached.writeFiles).not.toHaveBeenCalled();
      expect(reattached.fs.mkdir).not.toHaveBeenCalled();
      expect(drives.getOrCreate).toHaveBeenCalledOnce();
      expect(drives.list).not.toHaveBeenCalled();
      await recovered.onSessionDelete();
      expect(reattached.delete).toHaveBeenCalledOnce();
      expect(drive.delete).toHaveBeenCalledOnce();
      expect(reattached.stop).not.toHaveBeenCalled();
    },
  );
  it.each(["onRuntimeShutdown", "onSessionStop", "onSessionDelete"] as const)(
    "%s uses the current VM after a preview reattachment",
    async (close) => {
      const original = nativeFixture();
      original.status = "stopped";
      const reattached = nativeFixture();
      sdk.get.mockResolvedValueOnce(original).mockResolvedValueOnce(reattached);
      const handle = await createBuilderVercelProvider().resume(
        context,
        { files: [] },
        { name: original.name, version: 1 },
      );
      expect(await getVercelPreviewProvider(original.name)).toBe(reattached);
      reattached.readFileToBuffer.mockResolvedValue(Buffer.from("private edit"));
      expect(await handle.sandbox.readTextFile({ path: "edited.ts" })).toBe("private edit");
      expect(original.readFileToBuffer).not.toHaveBeenCalled();
      await handle.sandbox.run({ command: "git status" });
      expect(authority).toHaveBeenCalledWith({ sessionId: context.session.id });
      expect(reattached.runCommand).toHaveBeenCalledOnce();
      expect(original.runCommand).not.toHaveBeenCalled();
      await handle[close]();
      expect(reattached[close === "onSessionDelete" ? "delete" : "stop"]).toHaveBeenCalledOnce();
      expect(original.stop).not.toHaveBeenCalled();
      expect(original.delete).not.toHaveBeenCalled();
      await expect(getVercelPreviewProvider(original.name)).rejects.toThrow("not connected");
    },
  );
  it("rejects a lost native sandbox on resume without creating replacement compute", async () => {
    sdk.get.mockRejectedValue(new Error("sandbox not found"));
    await expect(
      createBuilderVercelProvider().resume(context, { files: [] }, { name: "lost", version: 1 }),
    ).rejects.toThrow("sandbox not found");
    expect(sdk.create).not.toHaveBeenCalled();
  });
  it("waits for its pending preview resume before stopping the resulting VM", async () => {
    const original = nativeFixture();
    original.status = "stopped";
    sdk.get.mockResolvedValueOnce(original);
    const handle = await createBuilderVercelProvider().resume(
      context,
      { files: [] },
      { name: original.name, version: 1 },
    );
    const reattached = nativeFixture();
    const deferred = Promise.withResolvers<typeof reattached>();
    sdk.get.mockReturnValueOnce(deferred.promise);
    const preview = getVercelPreviewProvider(original.name);
    const closing = handle.onRuntimeShutdown();
    expect(original.stop).not.toHaveBeenCalled();
    deferred.resolve(reattached);
    await expect(preview).rejects.toThrow("not connected");
    await closing;
    expect(reattached.stop).toHaveBeenCalledOnce();
    expect(original.stop).not.toHaveBeenCalled();
    await expect(getVercelPreviewProvider(original.name)).rejects.toThrow("not connected");
  });
  it("does not stop compute owned by a newer provider handle", async () => {
    const original = nativeFixture();
    const replacement = nativeFixture();
    sdk.get.mockResolvedValueOnce(original).mockResolvedValueOnce(replacement);
    const provider = createBuilderVercelProvider();
    const state = { name: original.name, version: 1 } as const;
    const old = await provider.resume(context, { files: [] }, state);
    const current = await provider.resume(context, { files: [] }, state);
    await old.onRuntimeShutdown();
    await old.onSessionDelete();
    expect(original.stop).not.toHaveBeenCalled();
    expect(original.delete).not.toHaveBeenCalled();
    expect(replacement.stop).not.toHaveBeenCalled();
    expect(replacement.delete).not.toHaveBeenCalled();
    expect(await getVercelPreviewProvider(replacement.name)).toBe(replacement);
    await current.onSessionStop();
    expect(replacement.stop).toHaveBeenCalledOnce();
  });
  it("allows explicit deletion after the same handle has stopped", async () => {
    const native = nativeFixture();
    sdk.get.mockResolvedValue(native);
    const handle = await createBuilderVercelProvider().resume(
      context,
      { files: [] },
      { name: native.name, version: 1 },
    );
    await handle.onSessionStop();
    const { signal } = new AbortController();
    await handle.onSessionDelete({ abortSignal: signal });
    expect(native.stop).toHaveBeenCalledOnce();
    expect(native.delete).toHaveBeenCalledWith({ signal });
    expect(sdk.get).toHaveBeenCalledOnce();
  });
  it("resumes legacy saved state without creating or looking up a Drive", async () => {
    const native = nativeFixture();
    sdk.get.mockResolvedValue(native);
    const handle = await createBuilderVercelProvider().resume(
      context,
      { files: [] },
      { name: native.name, version: 1 },
    );
    await handle.onSessionDelete();
    expect(native.delete).toHaveBeenCalledOnce();
    expect(drives.getOrCreate).not.toHaveBeenCalled();
    expect(drives.list).not.toHaveBeenCalled();
  });
  it("deletes only the saved exact Drive after its owned Sandbox deletion succeeds", async () => {
    const native = nativeFixture();
    const drive = driveFixture();
    native.mounts["/workspace"].drive = drive.name;
    const foreign = { ...driveFixture(), driveId: "drive-foreign", name: "owned-drive-other" };
    drives.list.mockResolvedValue(listedDrives(foreign, drive));
    sdk.get.mockResolvedValue(native);
    const handle = await createBuilderVercelProvider().resume(
      context,
      { files: [] },
      { name: native.name, version: 1, workspaceDrive: driveState },
    );
    const { signal } = new AbortController();
    await handle.onSessionDelete({ abortSignal: signal });
    expect(native.delete).toHaveBeenCalledWith({ signal });
    expect(drives.list).toHaveBeenCalledWith(
      expect.objectContaining({
        namePrefix: driveState.name,
        projectId: driveState.projectId,
        sortBy: "name",
        signal,
      }),
    );
    expect(drive.delete).toHaveBeenCalledWith({ signal });
    expect(foreign.delete).not.toHaveBeenCalled();
    expect(native.delete.mock.invocationCallOrder[0]).toBeLessThan(
      drives.list.mock.invocationCallOrder[0] ?? 0,
    );
    expect(drives.getOrCreate).not.toHaveBeenCalled();
  });
  it.each(["driveId", "name", "projectId", "region"] as const)(
    "retains a listed Drive with a foreign %s",
    async (field) => {
      const native = nativeFixture();
      const foreign = { ...driveFixture(), [field]: "foreign" };
      sdk.get.mockResolvedValue(native);
      drives.list.mockResolvedValue(listedDrives(foreign));
      const handle = await createBuilderVercelProvider().resume(
        context,
        { files: [] },
        { name: native.name, version: 1, workspaceDrive: driveState },
      );
      await expect(handle.onSessionDelete()).rejects.toThrow();
      expect(native.delete).toHaveBeenCalledOnce();
      expect(foreign.delete).not.toHaveBeenCalled();
      expect(drives.getOrCreate).not.toHaveBeenCalled();
    },
  );
  it.each(["mount", "sandboxName", "mode"] as const)(
    "retains a Drive when the saved %s binding does not match",
    async (binding) => {
      const native = nativeFixture();
      if (binding === "mount") {
        native.mounts["/workspace"].drive = "drive-foreign";
      }
      if (binding === "mode") {
        native.mounts["/workspace"].mode = "snapshot";
      }
      sdk.get.mockResolvedValue(native);
      const state = {
        name: native.name,
        version: 1,
        workspaceDrive: {
          ...driveState,
          sandboxName: binding === "sandboxName" ? "foreign-sandbox" : native.name,
        },
      } as const;
      const handle = await createBuilderVercelProvider().resume(context, { files: [] }, state);
      await expect(handle.onSessionDelete()).rejects.toThrow();
      expect(native.delete).toHaveBeenCalledOnce();
      expect(drives.list).not.toHaveBeenCalled();
    },
  );
  it("retains a saved Drive when another handle owns the Sandbox", async () => {
    const original = nativeFixture();
    const replacement = nativeFixture();
    sdk.get.mockResolvedValueOnce(original).mockResolvedValueOnce(replacement);
    const provider = createBuilderVercelProvider();
    const state = { name: original.name, version: 1, workspaceDrive: driveState } as const;
    const old = await provider.resume(context, { files: [] }, state);
    const current = await provider.resume(context, { files: [] }, state);
    await old.onSessionDelete();
    expect(original.delete).not.toHaveBeenCalled();
    expect(replacement.delete).not.toHaveBeenCalled();
    expect(drives.list).not.toHaveBeenCalled();
    await current.onSessionStop();
  });
  it.each(["unknown", "cancelled"])(
    "retains private Drive bytes after %s Sandbox deletion",
    async (outcome) => {
      const native = nativeFixture();
      const failure = new Error("provider delete response lost");
      const controller = new AbortController();
      if (outcome === "cancelled") {
        controller.abort(failure);
      }
      native.delete.mockRejectedValue(failure);
      sdk.get.mockResolvedValue(native);
      const handle = await createBuilderVercelProvider().resume(
        context,
        { files: [] },
        { name: native.name, version: 1, workspaceDrive: driveState },
      );
      await expect(handle.onSessionDelete({ abortSignal: controller.signal })).rejects.toBe(
        failure,
      );
      if (outcome === "unknown") {
        expect(native.delete).toHaveBeenCalledWith({ signal: controller.signal });
      }
      expect(drives.list).not.toHaveBeenCalled();
      expect(drives.getOrCreate).not.toHaveBeenCalled();
    },
  );
  it.each(["currentSessionId", "currentSandboxName"] as const)(
    "retains a Drive that still has an attached %s",
    async (field) => {
      const native = nativeFixture();
      const drive = { ...driveFixture(), [field]: "attached-owner" };
      sdk.get.mockResolvedValue(native);
      drives.list.mockResolvedValue(listedDrives(drive));
      const handle = await createBuilderVercelProvider().resume(
        context,
        { files: [] },
        { name: native.name, version: 1, workspaceDrive: driveState },
      );
      await expect(handle.onSessionDelete()).rejects.toThrow();
      expect(native.delete).toHaveBeenCalledOnce();
      expect(drive.delete).not.toHaveBeenCalled();
      const detached = driveFixture();
      drives.list.mockResolvedValue(listedDrives(detached));
      await handle.onSessionDelete();
      expect(native.delete).toHaveBeenCalledOnce();
      expect(detached.delete).toHaveBeenCalledOnce();
      expect(drives.getOrCreate).not.toHaveBeenCalled();
    },
  );
  it("retries failed Drive cleanup after definite Sandbox deletion without deleting compute again", async () => {
    const native = nativeFixture();
    const drive = driveFixture();
    const failure = new Error("Drive delete response lost");
    drive.delete.mockRejectedValueOnce(failure).mockResolvedValueOnce(null);
    drives.list.mockResolvedValue(listedDrives(drive));
    sdk.get.mockResolvedValue(native);
    const handle = await createBuilderVercelProvider().resume(
      context,
      { files: [] },
      { name: native.name, version: 1, workspaceDrive: driveState },
    );
    await expect(handle.onSessionDelete()).rejects.toBe(failure);
    await handle.onSessionDelete();
    expect(native.delete).toHaveBeenCalledOnce();
    expect(drive.delete).toHaveBeenCalledTimes(2);
    expect(drives.getOrCreate).not.toHaveBeenCalled();
  });
  it.each(["name", "attachment"])(
    "does not start compute using a foreign Drive %s",
    async (binding) => {
      const drive = {
        ...driveFixture(binding === "name" ? "foreign-drive" : startedDriveName),
        currentSandboxName: binding === "attachment" ? "foreign-sandbox" : undefined,
      };
      drives.getOrCreate.mockResolvedValue(drive);
      await expect(
        createBuilderVercelProvider().start(context, undefined, { files: [] }),
      ).rejects.toThrow("another sandbox");
      expect(sdk.create).not.toHaveBeenCalled();
      expect(drive.delete).not.toHaveBeenCalled();
      expect(drives.list).not.toHaveBeenCalled();
    },
  );
  it("does not start compute after a failed Drive allocation", async () => {
    const failure = new Error("Drive outcome unknown");
    drives.getOrCreate.mockRejectedValue(failure);
    await expect(
      createBuilderVercelProvider().start(context, undefined, { files: [] }),
    ).rejects.toBe(failure);
    expect(sdk.create).not.toHaveBeenCalled();
    expect(drives.list).not.toHaveBeenCalled();
  });
  it("does not create a missing Drive during deletion", async () => {
    const native = nativeFixture();
    sdk.get.mockResolvedValue(native);
    drives.list.mockResolvedValue(listedDrives());
    const handle = await createBuilderVercelProvider().resume(
      context,
      { files: [] },
      { name: native.name, version: 1, workspaceDrive: driveState },
    );
    await handle.onSessionDelete();
    expect(native.delete).toHaveBeenCalledOnce();
    expect(drives.list).toHaveBeenCalledOnce();
    expect(drives.getOrCreate).not.toHaveBeenCalled();
  });
  it("recovers the same owned Sandbox after unknown creation and a retry name conflict", async () => {
    const drive = driveFixture(startedDriveName);
    const native = { ...nativeFixture(), name: startedSandboxName };
    const failure = new Error("fetch failed");
    const conflict = new APIError(new Response("", { status: 409 }), {
      message: "Sandbox name already exists",
    });
    drives.getOrCreate.mockResolvedValue(drive);
    sdk.create.mockRejectedValueOnce(failure).mockRejectedValueOnce(conflict);
    sdk.get.mockRejectedValueOnce(new Error("Sandbox not found yet")).mockResolvedValueOnce(native);
    const provider = createBuilderVercelProvider();
    await expect(provider.start(context, undefined, { files: [] })).rejects.toBe(failure);
    expect(drive.delete).not.toHaveBeenCalled();
    expect(drives.list).not.toHaveBeenCalled();
    const started = await provider.start(context, undefined, { files: [] });
    expect(started.state.name).toBe(startedSandboxName);
    expect(drives.getOrCreate.mock.calls.map(([options]) => options.name)).toEqual([
      startedDriveName,
      startedDriveName,
    ]);
    expect(sdk.get).toHaveBeenCalledWith(
      expect.objectContaining({
        name: startedSandboxName,
        projectId: drive.projectId,
        resume: false,
      }),
    );
    expect(sdk.create.mock.calls[0]?.[0]?.mounts?.["/workspace"]).toBe(drive);
    expect(sdk.create.mock.calls[1]?.[0]?.mounts?.["/workspace"]).toBe(drive);
    expect(native.delete).not.toHaveBeenCalled();
    expect(drive.delete).not.toHaveBeenCalled();
    await started.handle.onSessionStop();
  });
  it.each(["name", "region", "persistent", "drive", "mode"] as const)(
    "rejects a recovered Sandbox with a foreign %s before any I/O",
    async (field) => {
      const drive = driveFixture(startedDriveName);
      const native = { ...nativeFixture(), name: startedSandboxName };
      if (field === "drive") {
        native.mounts["/workspace"].drive = "foreign-drive";
      } else if (field === "mode") {
        native.mounts["/workspace"].mode = "snapshot";
      } else if (field === "persistent") {
        native.persistent = false;
      } else {
        native[field] = "foreign";
      }
      const failure = new APIError(new Response("", { status: 409 }), {
        message: "Sandbox name conflict",
      });
      drives.getOrCreate.mockResolvedValue(drive);
      sdk.create.mockRejectedValue(failure);
      sdk.get.mockResolvedValue(native);
      await expect(
        createBuilderVercelProvider().start(context, undefined, { files: [] }),
      ).rejects.toBe(failure);
      expect(native.fs.mkdir).not.toHaveBeenCalled();
      expect(native.fs.lstat).not.toHaveBeenCalled();
      expect(native.runCommand).not.toHaveBeenCalled();
      expect(native.writeFiles).not.toHaveBeenCalled();
      expect(native.delete).not.toHaveBeenCalled();
      expect(drive.delete).not.toHaveBeenCalled();
      expect(drives.list).not.toHaveBeenCalled();
    },
  );
  it("recovers private workspace and existing managed seeds without overwriting them", async () => {
    const drive = driveFixture(startedDriveName);
    const native = { ...nativeFixture(), name: startedSandboxName };
    const files = seedStorage(native, [
      ["/workspace/private.txt", Buffer.from("private workspace bytes")],
      ["/home/vercel/.agents/skills/SKILL.md", Buffer.from("private skill bytes")],
    ]);
    drives.getOrCreate.mockResolvedValue(drive);
    sdk.create.mockRejectedValue(new APIError(new Response("", { status: 409 })));
    sdk.get.mockResolvedValue(native);
    const started = await createBuilderVercelProvider().start(context, undefined, {
      files: [
        {
          path: "/workspace/private.txt",
          content: Buffer.from("replacement workspace seed").toString("base64"),
        },
        {
          path: "$HOME/.agents/skills/SKILL.md",
          content: Buffer.from("replacement skill seed").toString("base64"),
        },
        { path: "/workspace/new.txt", content: Buffer.from("new seed").toString("base64") },
      ],
    });
    expect(files.get("/workspace/private.txt")).toEqual(Buffer.from("private workspace bytes"));
    expect(files.get("/home/vercel/.agents/skills/SKILL.md")).toEqual(
      Buffer.from("private skill bytes"),
    );
    expect(files.get("/workspace/new.txt")).toEqual(Buffer.from("new seed"));
    expect(native.delete).not.toHaveBeenCalled();
    expect(drive.delete).not.toHaveBeenCalled();
    await started.handle.onSessionStop();
  });
  it("preserves existing Drive workspace seeds when creating replacement compute", async () => {
    const native = nativeFixture();
    const files = seedStorage(native, [
      ["/workspace/private.txt", Buffer.from("retained workspace edit")],
    ]);
    sdk.create.mockResolvedValue(native);
    const started = await createBuilderVercelProvider().start(context, undefined, {
      files: [
        {
          path: "private.txt",
          content: Buffer.from("original seed").toString("base64"),
        },
        { path: "/workspace/new.txt", content: Buffer.from("new seed").toString("base64") },
      ],
    });
    expect(files.get("/workspace/private.txt")).toEqual(Buffer.from("retained workspace edit"));
    expect(files.get("/workspace/new.txt")).toEqual(Buffer.from("new seed"));
    await started.handle.onSessionStop();
  });
  it("retains recovered compute and Drive when seed inspection has an unknown outcome", async () => {
    const drive = driveFixture(startedDriveName);
    const native = { ...nativeFixture(), name: startedSandboxName };
    const failure = new Error("seed stat response lost");
    native.fs.lstat.mockRejectedValue(failure);
    drives.getOrCreate.mockResolvedValue(drive);
    sdk.create.mockRejectedValue(new APIError(new Response("", { status: 409 })));
    sdk.get.mockResolvedValue(native);
    await expect(
      createBuilderVercelProvider().start(context, undefined, {
        files: [
          { path: "/workspace/private.txt", content: Buffer.from("seed").toString("base64") },
        ],
      }),
    ).rejects.toBe(failure);
    expect(native.writeFiles).not.toHaveBeenCalled();
    expect(native.delete).not.toHaveBeenCalled();
    expect(drive.delete).not.toHaveBeenCalled();
    expect(drives.list).not.toHaveBeenCalled();
  });
  it.each([503, 200])(
    "reconciles an ambiguous SDK HTTP %s creation result without deleting compute",
    async (status) => {
      const native = { ...nativeFixture(), name: startedSandboxName };
      sdk.create.mockRejectedValue(new APIError(new Response("", { status })));
      sdk.get.mockResolvedValue(native);
      const started = await createBuilderVercelProvider().start(context, undefined, { files: [] });
      expect(sdk.get).toHaveBeenCalledWith(
        expect.objectContaining({
          name: startedSandboxName,
          projectId: "project-owned",
          resume: false,
        }),
      );
      expect(native.delete).not.toHaveBeenCalled();
      await started.handle.onSessionStop();
    },
  );
  it("does not turn a provider authorization denial into a Sandbox lookup", async () => {
    const failure = new APIError(new Response("", { status: 403 }));
    sdk.create.mockRejectedValue(failure);
    await expect(
      createBuilderVercelProvider().start(context, undefined, { files: [] }),
    ).rejects.toBe(failure);
    expect(sdk.get).not.toHaveBeenCalled();
    expect(drives.list).not.toHaveBeenCalled();
  });
  it("does not reconcile invalid SDK creation input", async () => {
    const failure = new TypeError("invalid creation input");
    sdk.create.mockRejectedValue(failure);
    await expect(
      createBuilderVercelProvider().start(context, undefined, { files: [] }),
    ).rejects.toBe(failure);
    expect(sdk.get).not.toHaveBeenCalled();
    expect(drives.list).not.toHaveBeenCalled();
  });
  it("does not reconcile creation after cancellation", async () => {
    const failure = new DOMException("cancelled", "AbortError");
    sdk.create.mockRejectedValue(failure);
    await expect(
      createBuilderVercelProvider().start(context, undefined, { files: [] }),
    ).rejects.toBe(failure);
    expect(sdk.get).not.toHaveBeenCalled();
    expect(drives.list).not.toHaveBeenCalled();
  });
  it("preserves the original create failure when the exact-name lookup is unavailable", async () => {
    const drive = driveFixture(startedDriveName);
    const failure = new Error("network response unknown");
    drives.getOrCreate.mockResolvedValue(drive);
    sdk.create.mockRejectedValue(failure);
    sdk.get.mockRejectedValue(new Error("lookup response unknown"));
    await expect(
      createBuilderVercelProvider().start(context, undefined, { files: [] }),
    ).rejects.toBe(failure);
    expect(drive.delete).not.toHaveBeenCalled();
    expect(drives.list).not.toHaveBeenCalled();
  });
  it("preserves the initiating setup failure and Drive if best-effort Sandbox cleanup also fails", async () => {
    const drive = driveFixture(startedDriveName);
    const native = nativeFixture();
    const failure = new Error("seed upload failed");
    native.writeFiles.mockRejectedValue(failure);
    native.delete.mockRejectedValue(new Error("delete outcome unknown"));
    drives.getOrCreate.mockResolvedValue(drive);
    sdk.create.mockResolvedValue(native);
    await expect(
      createBuilderVercelProvider().start(context, undefined, {
        files: [
          { path: "/workspace/private.txt", content: Buffer.from("private").toString("base64") },
        ],
      }),
    ).rejects.toBe(failure);
    expect(native.delete).toHaveBeenCalledOnce();
    expect(drive.delete).not.toHaveBeenCalled();
    expect(drives.list).not.toHaveBeenCalled();
  });
  it("authorizes run and spawn before sending SDK commands", async () => {
    const native = nativeFixture();
    sdk.get.mockResolvedValue(native);
    const handle = await createBuilderVercelProvider().resume(
      context,
      { files: [] },
      { name: native.name, version: 1 },
    );
    authority.mockRejectedValue(new Error("authority denied"));
    await expect(handle.sandbox.run({ command: "git status" })).rejects.toThrow("authority denied");
    await expect(handle.sandbox.spawn({ command: "bun dev" })).rejects.toThrow("authority denied");
    expect(native.runCommand).not.toHaveBeenCalled();
    await handle.onSessionDelete();
    expect(native.delete).toHaveBeenCalledOnce();
  });
  it("removes preview mapping after failed cleanup", async () => {
    const native = nativeFixture();
    sdk.get.mockResolvedValue(native);
    const handle = await createBuilderVercelProvider().resume(
      context,
      { files: [] },
      { name: native.name, version: 1 },
    );
    native.stop.mockRejectedValue(new Error("cleanup failed"));
    await expect(handle.onSessionStop()).rejects.toThrow("cleanup failed");
    await expect(getVercelPreviewProvider(native.name)).rejects.toThrow("not connected");
  });
  it("retries provider transport failures without dropping the caller signal", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(new Response("ok"));
    const { signal } = new AbortController();
    await expect(
      createProviderFetch(fetch)(new Request("https://sandbox.example.test/create", { signal })),
    ).resolves.toMatchObject({ status: 200 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("Builder provider transport", () => {
  it.each([429, 503])(
    "retries HTTP %s once and preserves the request and signal",
    async (status) => {
      const transport = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(new Response("busy", { status }))
        .mockResolvedValueOnce(new Response("ok"));
      const controller = new AbortController();
      const request = new Request("https://sandbox.example.test/create", {
        body: "payload",
        headers: { authorization: "Bearer private" },
        method: "POST",
        signal: controller.signal,
      });
      await createProviderFetch(transport)(request);
      expect(transport).toHaveBeenCalledTimes(2);
      const forwarded = transport.mock.calls[1]?.[0];
      if (!(forwarded instanceof Request)) {
        throw new Error("Request was not forwarded");
      }
      expect(forwarded.method).toBe("POST");
      expect(await forwarded.text()).toBe("payload");
      expect(forwarded.headers.get("authorization")).toBe("Bearer private");
      controller.abort(new Error("cancelled after retry"));
      expect(transport.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
      expect(forwarded.signal.aborted).toBe(true);
    },
  );
  it("does not retry a caller-cancelled transport request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const transport = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("fetch failed"));
    await expect(
      createProviderFetch(transport)(
        new Request("https://sandbox.example.test/create", { signal: controller.signal }),
      ),
    ).rejects.toThrow("fetch failed");
    expect(transport).toHaveBeenCalledOnce();
  });
});
