import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxProviderSessionContext } from "eve/sandbox/provider";
import { createBuilderVercelProvider, createProviderFetch } from "./vercel-backend";
import {
  configureVercelSessionGitSourceResolver,
  clearVercelSessionGitSource,
} from "./vercel-session-source";
import { getVercelPreviewProvider } from "./vercel-preview-provider";

const sdk = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn() }));
const authority = vi.hoisted(() => vi.fn());
// oxlint-disable-next-line anti-slop/no-module-mocking -- Mock only the external SDK boundary so this test cannot create provider resources.
vi.mock("@vercel/sandbox", () => ({ Sandbox: sdk }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- The persistent authority store is a terminal provider boundary in these lifecycle tests.
vi.mock("./deployment-execution-lease", () => ({ assertHostedSandboxCommandAuthority: authority }));
const context = { session: { id: "provider-test" } } as SandboxProviderSessionContext;
const nativeFixture = () => ({
  delete: vi.fn().mockResolvedValue(null),
  fs: { mkdir: vi.fn().mockResolvedValue(null) },
  name: "owned-name",
  runCommand: vi.fn().mockResolvedValue({
    exitCode: 0,
    stderr: () => Promise.resolve(""),
    stdout: () => Promise.resolve("/home/vercel\n"),
  }),
  status: "running",
  stop: vi.fn().mockResolvedValue(null),
  writeFiles: vi.fn().mockResolvedValue(null),
});

describe("Builder Vercel provider", () => {
  beforeEach(() => {
    sdk.create.mockReset();
    sdk.get.mockReset();
    authority.mockReset();
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
  });
  it("uses a short-lived selected Git source only for creation, retaining no token in state", async () => {
    const native = nativeFixture();
    sdk.create.mockResolvedValue(native);
    const resolver = vi.fn().mockResolvedValue({
      revision: "selected-head",
      token: "private-token",
      url: "https://github.com/acme/private.git",
    });
    configureVercelSessionGitSourceResolver({ resolve: resolver, sessionId: context.session.id });
    const provider = createBuilderVercelProvider({
      sandboxEnvironment: { MISE_DATA_DIR: "/runtime" },
    });
    try {
      const result = await provider.start(context, undefined, {
        files: [
          {
            content: Buffer.from("guide").toString("base64"),
            path: "$HOME/.agents/skills/SKILL.md",
          },
        ],
      });
      expect(sdk.create).toHaveBeenCalledWith(
        expect.objectContaining({
          env: { MISE_DATA_DIR: "/runtime" },
          networkPolicy: "allow-all",
          source: {
            password: ["private", "token"].join("-"),
            revision: "selected-head",
            type: "git",
            url: "https://github.com/acme/private.git",
            username: "x-access-token",
          },
        }),
      );
      expect(JSON.stringify(result.state)).not.toContain("private-token");
      expect(native.writeFiles).toHaveBeenCalledWith(
        [{ content: Buffer.from("guide"), path: "/home/vercel/.agents/skills/SKILL.md" }],
        expect.anything(),
      );
      expect(await getVercelPreviewProvider(result.handle.sandbox.id)).toBe(native);
      sdk.get.mockResolvedValue(native);
      await provider.resume(context, { files: [] }, result.state);
      expect(resolver).toHaveBeenCalledOnce();
      expect(sdk.create).toHaveBeenCalledOnce();
      expect(sdk.get).toHaveBeenCalledWith(
        expect.objectContaining({ name: "owned-name", resume: true }),
      );
      await result.handle.onSessionStop();
    } finally {
      clearVercelSessionGitSource(context.session.id);
    }
  });
  it("rejects a lost native sandbox on resume without creating replacement compute", async () => {
    sdk.get.mockRejectedValue(new Error("sandbox not found"));
    await expect(
      createBuilderVercelProvider().resume(context, { files: [] }, { name: "lost", version: 1 }),
    ).rejects.toThrow("sandbox not found");
    expect(sdk.create).not.toHaveBeenCalled();
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
