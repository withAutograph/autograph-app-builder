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
  type HostedVercelBackendFactory,
  type HostedVercelBackendOptions,
} from "./vercel-backend";

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

describe("hosted Vercel sandbox backend", () => {
  it("allows bootstrap hosts only for prewarm and denies every fresh live session", () => {
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
    expect(options!.networkPolicy).toEqual({
      allow: [
        "github.com",
        "release-assets.githubusercontent.com",
        "nodejs.org",
        "static.rust-lang.org",
      ],
    });
    expect(options!.resources).toEqual({ vcpus: 2 });
    expect(options!.timeout).toBe(900_000);
    expect(options!.ports).toEqual([]);
    expect(options!.sessionCreateOptions()).toEqual({
      networkPolicy: "deny-all",
    });
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
