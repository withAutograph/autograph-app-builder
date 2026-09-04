import { describe, expect, it, vi } from "vitest";
import {
  SandboxTemplateNotProvisionedError,
  type SandboxBackendHandle,
  type SandboxBackendPrewarmInput,
  type SandboxSeedFile,
  type SandboxSession,
} from "eve/sandbox";

import {
  createHostedVercelBackend,
  createProviderFetch,
  type HostedVercelBackendFactory,
  type HostedVercelBackendOptions,
} from "./vercel-backend";
import {
  clearVercelSessionGitSource,
  configureVercelSessionGitSource,
} from "./vercel-session-source";

const runtimeContext = { appRoot: "/app" };
const templateKey = "template-key";

function recoveryInput(input?: {
  readonly bootstrap?: NonNullable<SandboxBackendPrewarmInput["bootstrap"]>;
  readonly seedFiles?: readonly SandboxSeedFile[];
}) {
  return () => ({
    bootstrap: input?.bootstrap ?? (async () => undefined),
    seedFiles:
      input?.seedFiles ??
      ([
        {
          content: Buffer.from("skill bytes"),
          path: "$HOME/.agents/skills/create-app/SKILL.md",
        },
      ] satisfies readonly SandboxSeedFile[]),
  });
}

function backendFactory(input: {
  readonly create: ReturnType<typeof vi.fn>;
  readonly prewarm: ReturnType<typeof vi.fn>;
}): HostedVercelBackendFactory {
  return vi.fn(() => ({
    name: "vercel",
    create: input.create,
    prewarm: input.prewarm,
  })) as HostedVercelBackendFactory;
}

describe.skip("retired template-backed Vercel backend", () => {
  it("retries transport failures at the cancellable fetch boundary", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(new Response("ok"));
    const request = new Request(
      "https://sandbox.example.test/v1/create?secret=hidden",
      {
        method: "POST",
        headers: { authorization: "Bearer hidden", "x-private": "hidden" },
        body: "hidden",
      },
    );
    await expect(createProviderFetch(fetch)(request)).resolves.toMatchObject({
      status: 200,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]![0]).toBeInstanceOf(Request);
  });

  it("retries one provider timeout without retrying caller cancellation", async () => {
    const timedOutFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
          }),
      )
      .mockResolvedValueOnce(new Response("ok"));
    await expect(
      createProviderFetch(
        timedOutFetch,
        1,
      )(
        new Request("https://sandbox.example.test/fs/write", {
          method: "POST",
        }),
      ),
    ).resolves.toMatchObject({ status: 200 });
    expect(timedOutFetch).toHaveBeenCalledTimes(2);

    const controller = new AbortController();
    controller.abort();
    const cancelledFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new DOMException("cancelled", "AbortError"));
    await expect(
      createProviderFetch(
        cancelledFetch,
        1,
      )(
        new Request("https://sandbox.example.test/fs/read", {
          signal: controller.signal,
        }),
      ),
    ).rejects.toThrow();
    expect(cancelledFetch).toHaveBeenCalledOnce();
  });

  it("keeps networking available for prewarm and every fresh live session", () => {
    let options: HostedVercelBackendOptions | undefined;
    const factory = vi.fn(((input: HostedVercelBackendOptions) => {
      options = input;
      return { name: "injected-vercel-backend" } as never;
    }) satisfies HostedVercelBackendFactory);

    createHostedVercelBackend({
      factory,
      runtimeRecoveryPrewarmInput: recoveryInput(),
    });

    expect(factory).toHaveBeenCalledOnce();
    expect(options).toBeDefined();
    expect(options!.networkPolicy).toBe("allow-all");
    expect(options!.sessionCreateOptions()).toEqual({
      networkPolicy: "allow-all",
    });
  });

  it("uses the closed Development environment and dependency bootstrap hosts", () => {
    let options: HostedVercelBackendOptions | undefined;
    const factory = vi.fn(((input: HostedVercelBackendOptions) => {
      options = input;
      return { name: "injected-vercel-backend" } as never;
    }) satisfies HostedVercelBackendFactory);
    createHostedVercelBackend({
      factory,
      bootstrapNetworkHosts: ["registry.npmjs.org"],
      sandboxEnvironment: {
        MISE_AUTO_INSTALL: "false",
        CARGO_NET_OFFLINE: "true",
      },
      runtimeRecoveryPrewarmInput: recoveryInput(),
    });
    expect(options?.networkPolicy).toBe("allow-all");
    expect(options?.env).toEqual({
      MISE_AUTO_INSTALL: "false",
      CARGO_NET_OFFLINE: "true",
    });
  });

  it("maps changing authored keys to one dependency-only provider template", async () => {
    const providerKey = "development-dependencies";
    const session = { id: "session-1" } as SandboxSession;
    const handle = {
      session,
      useSessionFn: async () => session,
      captureState: async () => ({
        backendName: "vercel",
        metadata: {},
        sessionKey: "session-1",
      }),
      stop: async () => undefined,
      shutdown: async () => undefined,
    } satisfies SandboxBackendHandle;
    const create = vi.fn(async () => handle);
    const prewarm = vi.fn(async () => ({ reused: true }));
    const backend = createHostedVercelBackend({
      factory: backendFactory({ create, prewarm }),
      providerTemplateKey: () => providerKey,
      runtimeRecoveryPrewarmInput: recoveryInput(),
    });

    await backend.prewarm({
      bootstrap: async () => undefined,
      runtimeContext,
      seedFiles: [],
      templateKey: "authored-key-a",
    });
    await backend.create({
      runtimeContext,
      sessionKey: "session-1",
      templateKey: "authored-key-b",
    });

    expect(prewarm).toHaveBeenCalledWith(
      expect.objectContaining({ templateKey: providerKey }),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ templateKey: providerKey }),
    );
  });

  it("reuses one live Development session until its handle is closed", async () => {
    const session = { id: "session-1" } as SandboxSession;
    const stop = vi.fn(async () => undefined);
    const handle = {
      session,
      useSessionFn: async () => session,
      captureState: async () => ({
        backendName: "vercel",
        metadata: { sandboxName: "provider-session" },
        sessionKey: "session-1",
      }),
      stop,
      shutdown: vi.fn(async () => undefined),
    } satisfies SandboxBackendHandle;
    const create = vi.fn(async () => handle);
    const options = {
      factory: backendFactory({
        create,
        prewarm: vi.fn(async () => ({ reused: true })),
      }),
      reuseProcessSessionHandles: true,
      runtimeRecoveryPrewarmInput: recoveryInput(),
    } as const;
    const firstBackend = createHostedVercelBackend(options);
    const secondBackend = createHostedVercelBackend(options);
    const input = {
      runtimeContext,
      sessionKey: "session-1",
      templateKey,
    };

    const [first, second] = await Promise.all([
      firstBackend.create(input),
      secondBackend.create(input),
    ]);

    expect(first).toBe(second);
    expect(create).toHaveBeenCalledOnce();

    await first.stop();
    await first.stop();
    expect(stop).toHaveBeenCalledOnce();

    const reopened = await secondBackend.create(input);
    expect(create).toHaveBeenCalledTimes(2);
    await reopened.shutdown();
  });

  it("replays the exact non-empty managed seeds and bootstrap, then retries once", async () => {
    const session = { id: "session-1" } as SandboxSession;
    const stop = vi.fn(async () => undefined);
    const shutdown = vi.fn(async () => undefined);
    const handle = {
      session,
      useSessionFn: async () => session,
      captureState: async () => ({
        backendName: "vercel",
        metadata: {},
        sessionKey: "session-1",
      }),
      stop,
      shutdown,
    } satisfies SandboxBackendHandle;
    const create = vi
      .fn()
      .mockRejectedValueOnce(
        new SandboxTemplateNotProvisionedError({
          backendName: "vercel",
          templateKey,
        }),
      )
      .mockResolvedValueOnce(handle);
    const prewarm = vi.fn(async (input: SandboxBackendPrewarmInput) => {
      void input;
      return { reused: false };
    });
    const bootstrap = vi.fn(async () => undefined);
    const seedFiles = [
      {
        content: Buffer.from("first skill"),
        path: "$HOME/.agents/skills/create-app/SKILL.md",
      },
      {
        content: Buffer.from("second skill"),
        path: "$HOME/.agents/skills/design-app/SKILL.md",
      },
    ] satisfies readonly SandboxSeedFile[];
    const resolveRecovery = vi.fn(recoveryInput({ bootstrap, seedFiles }));
    const backend = createHostedVercelBackend({
      factory: backendFactory({ create, prewarm }),
      runtimeRecoveryPrewarmInput: resolveRecovery,
    });

    const recovered = await backend.create({
      runtimeContext,
      sessionKey: "session-1",
      templateKey,
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(resolveRecovery).toHaveBeenCalledOnce();
    expect(prewarm).toHaveBeenCalledOnce();
    const prewarmInput = prewarm.mock.calls[0]![0];
    expect(prewarmInput).toMatchObject({
      runtimeContext,
      seedFiles,
      templateKey,
    });
    expect(prewarmInput.seedFiles).toBe(seedFiles);
    await prewarmInput.bootstrap!({ use: async () => session });
    expect(bootstrap).toHaveBeenCalledOnce();

    await recovered.stop();
    await recovered.shutdown();
    expect(stop).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "a null template",
      requestedTemplateKey: null,
      error: new SandboxTemplateNotProvisionedError({
        backendName: "vercel",
        templateKey,
      }),
    },
    {
      name: "an unrelated provider failure",
      requestedTemplateKey: templateKey,
      error: new Error("provider unavailable"),
    },
    {
      name: "a typed failure for a different template",
      requestedTemplateKey: templateKey,
      error: new SandboxTemplateNotProvisionedError({
        backendName: "vercel",
        templateKey: "different-template",
      }),
    },
  ])("does not recover $name", async ({ error, requestedTemplateKey }) => {
    const create = vi.fn().mockRejectedValueOnce(error);
    const prewarm = vi.fn(async (input: SandboxBackendPrewarmInput) => {
      void input;
      return { reused: false };
    });
    const resolveRecovery = vi.fn(recoveryInput());
    const backend = createHostedVercelBackend({
      factory: backendFactory({ create, prewarm }),
      runtimeRecoveryPrewarmInput: resolveRecovery,
    });

    await expect(
      backend.create({
        runtimeContext,
        sessionKey: "session-1",
        templateKey: requestedTemplateKey,
      }),
    ).rejects.toBe(error);
    expect(create).toHaveBeenCalledOnce();
    expect(prewarm).not.toHaveBeenCalled();
    expect(resolveRecovery).not.toHaveBeenCalled();
  });

  it("propagates prewarm failure without retrying create", async () => {
    const missing = new SandboxTemplateNotProvisionedError({
      backendName: "vercel",
      templateKey,
    });
    const failure = new Error("prewarm failed");
    const create = vi.fn().mockRejectedValueOnce(missing);
    const prewarm = vi.fn().mockRejectedValueOnce(failure);
    const backend = createHostedVercelBackend({
      factory: backendFactory({ create, prewarm }),
      runtimeRecoveryPrewarmInput: recoveryInput(),
    });

    await expect(
      backend.create({
        runtimeContext,
        sessionKey: "session-1",
        templateKey,
      }),
    ).rejects.toBe(failure);
    expect(create).toHaveBeenCalledOnce();
    expect(prewarm).toHaveBeenCalledOnce();
  });

  it("propagates the second create failure without recursive recovery", async () => {
    const first = new SandboxTemplateNotProvisionedError({
      backendName: "vercel",
      templateKey,
    });
    const second = new SandboxTemplateNotProvisionedError({
      backendName: "vercel",
      templateKey,
    });
    const create = vi
      .fn()
      .mockRejectedValueOnce(first)
      .mockRejectedValueOnce(second);
    const prewarm = vi.fn(async (input: SandboxBackendPrewarmInput) => {
      void input;
      return { reused: false };
    });
    const backend = createHostedVercelBackend({
      factory: backendFactory({ create, prewarm }),
      runtimeRecoveryPrewarmInput: recoveryInput(),
    });

    await expect(
      backend.create({
        runtimeContext,
        sessionKey: "session-1",
        templateKey,
      }),
    ).rejects.toBe(second);
    expect(create).toHaveBeenCalledTimes(2);
    expect(prewarm).toHaveBeenCalledOnce();
  });
});

describe("provider-native Vercel source", () => {
  it("falls back to a fresh sandbox when an optional template is absent", async () => {
    const session = { id: "fresh-session" } as SandboxSession;
    const handle = {
      session,
      useSessionFn: async () => session,
      captureState: async () => ({
        backendName: "vercel",
        metadata: {},
        sessionKey: "fresh-session",
      }),
      stop: async () => undefined,
      shutdown: async () => undefined,
    } satisfies SandboxBackendHandle;
    const create = vi
      .fn()
      .mockRejectedValueOnce(
        new SandboxTemplateNotProvisionedError({
          backendName: "vercel",
          templateKey,
        }),
      )
      .mockResolvedValueOnce(handle);
    const prewarm = vi.fn();
    const backend = createHostedVercelBackend({
      factory: backendFactory({ create, prewarm }),
    });

    const result = await backend.create({
      runtimeContext,
      sessionKey: "fresh-session",
      templateKey,
    });
    expect(result.session.id).toBe("fresh-session");
    expect(create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ templateKey }),
    );
    expect(create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ templateKey: null }),
    );
    expect(prewarm).not.toHaveBeenCalled();
  });

  it("forwards a server-owned Git source only to the matching fresh session", () => {
    let options: HostedVercelBackendOptions | undefined;
    const factory = vi.fn(((input: HostedVercelBackendOptions) => {
      options = input;
      return { name: "injected-vercel-backend" } as never;
    }) satisfies HostedVercelBackendFactory);
    const token = "short_lived_installation_token";
    configureVercelSessionGitSource({
      sessionId: "session-source",
      source: { url: "https://github.com/acme/private.git", token },
    });
    try {
      createHostedVercelBackend({ factory });
      expect(
        options?.sessionCreateOptions({ session: { id: "other" } }),
      ).toEqual({
        networkPolicy: "allow-all",
      });
      expect(
        options?.sessionCreateOptions({ session: { id: "session-source" } }),
      ).toEqual({
        networkPolicy: "allow-all",
        source: {
          type: "git",
          url: "https://github.com/acme/private.git",
          username: "x-access-token",
          password: token,
        },
      });
      expect(JSON.stringify(factory.mock.calls)).not.toContain(token);
    } finally {
      clearVercelSessionGitSource("session-source");
    }
  });
});
