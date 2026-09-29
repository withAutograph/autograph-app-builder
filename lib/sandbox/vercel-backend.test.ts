import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SandboxProviderPrepareContext,
  SandboxProviderSessionContext,
} from "eve/sandbox/provider";
import { createBuilderVercelProvider, createProviderFetch } from "./vercel-backend";
import {
  configureVercelSessionGitSourceResolver,
  clearVercelSessionGitSource,
} from "./vercel-session-source";
import { getVercelPreviewProvider } from "./vercel-preview-provider";

const sdk = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn() }));
const authority = vi.hoisted(() => vi.fn());
vi.mock("@vercel/sandbox", () => ({ Sandbox: sdk }));
vi.mock("./deployment-execution-lease", () => ({ assertHostedSandboxCommandAuthority: authority }));
const context = { session: { id: "provider-test" } } as SandboxProviderSessionContext;
const nativeFixture = () => ({
  name: "owned-name",
  status: "running",
  fs: { mkdir: vi.fn().mockResolvedValue(undefined) },
  writeFiles: vi.fn().mockResolvedValue(undefined),
  runCommand: vi.fn().mockResolvedValue({
    exitCode: 0,
    stdout: async () => "/home/vercel\n",
    stderr: async () => "",
  }),
  stop: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
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
      resources: {
        source: { kind: "none" },
        workspace: {
          key: "workspace",
          mountPath: "/unused",
          targetPath: "/workspace",
          files: [{ relativePath: "seed.txt", content: "seed" }],
        },
        skills: {
          key: "skills",
          mountPath: "/unused",
          targetPath: "$HOME/.agents/skills",
          files: [{ relativePath: "design/SKILL.md", content: "guide" }],
        },
      },
    } as unknown as SandboxProviderPrepareContext);
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
      url: "https://github.com/acme/private.git",
      token: "private-token",
      revision: "selected-head",
    });
    configureVercelSessionGitSourceResolver({ sessionId: context.session.id, resolve: resolver });
    const provider = createBuilderVercelProvider({
      sandboxEnvironment: { MISE_DATA_DIR: "/runtime" },
    });
    try {
      const result = await provider.start(context, undefined, {
        files: [
          {
            path: "$HOME/.agents/skills/SKILL.md",
            content: Buffer.from("guide").toString("base64"),
          },
        ],
      });
      expect(sdk.create).toHaveBeenCalledWith(
        expect.objectContaining({
          networkPolicy: "allow-all",
          env: { MISE_DATA_DIR: "/runtime" },
          source: {
            type: "git",
            url: "https://github.com/acme/private.git",
            password: "private-token",
            username: "x-access-token",
            revision: "selected-head",
          },
        }),
      );
      expect(JSON.stringify(result.state)).not.toContain("private-token");
      expect(native.writeFiles).toHaveBeenCalledWith(
        [{ path: "/home/vercel/.agents/skills/SKILL.md", content: Buffer.from("guide") }],
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
        signal: controller.signal,
        method: "POST",
        body: "payload",
        headers: { authorization: "Bearer private" },
      });
      await createProviderFetch(transport)(request);
      expect(transport).toHaveBeenCalledTimes(2);
      const forwarded = transport.mock.calls[1]![0] as Request;
      expect(forwarded.method).toBe("POST");
      expect(await forwarded.text()).toBe("payload");
      expect(forwarded.headers.get("authorization")).toBe("Bearer private");
      controller.abort(new Error("cancelled after retry"));
      expect(transport.mock.calls[1]![1]?.signal?.aborted).toBe(true);
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
