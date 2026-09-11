import type {
  SandboxBackend,
  SandboxBackendHandle,
  SandboxSession,
} from "eve/sandbox";

export function createAuthorizedSandboxSession(input: {
  session: SandboxSession;
  authorize?: () => Promise<unknown>;
}): SandboxSession {
  const authorize = async () => void (await input.authorize?.());
  return {
    id: input.session.id,
    readBinaryFile: (options) => input.session.readBinaryFile(options),
    readFile: (options) => input.session.readFile(options),
    readTextFile: (options) => input.session.readTextFile(options),
    removePath: (options) => input.session.removePath(options),
    resolvePath: (path) => input.session.resolvePath(path),
    async run(options) {
      await authorize();
      // Vercel Sandbox owns command streaming and the explicit caller abort
      // signal. Do not insert an unrelated wall, silence, or output limit
      // between an Arrusted operation and its provider runtime.
      return input.session.run(options);
    },
    setNetworkPolicy: (policy) => input.session.setNetworkPolicy(policy),
    async spawn(options) {
      await authorize();
      // Keep the signed-user boundary while delegating process semantics to
      // Vercel Sandbox. The previous rejection forced callers through a
      // custom command wrapper and turned ordinary repository work into an
      // artificial gate.
      return input.session.spawn(options);
    },
    writeBinaryFile: (options) => input.session.writeBinaryFile(options),
    writeFile: (options) => input.session.writeFile(options),
    writeTextFile: (options) => input.session.writeTextFile(options),
  };
}

function wrapHandle<SO>(input: {
  handle: SandboxBackendHandle<SO>;
  authorize: () => Promise<unknown>;
}): SandboxBackendHandle<SO> {
  return {
    ...input.handle,
    session: createAuthorizedSandboxSession({
      authorize: input.authorize,
      session: input.handle.session,
    }),
    async useSessionFn(options) {
      return createAuthorizedSandboxSession({
        authorize: input.authorize,
        session: await input.handle.useSessionFn(options),
      });
    },
  };
}

/** Preserves tenant-bound command authority without replacing Vercel's transport. */
export function createAuthorizedSandboxBackend<BO, SO>(input: {
  backend: SandboxBackend<BO, SO>;
  authorizeSessionCommand(sessionId: string): Promise<unknown>;
}): SandboxBackend<BO, SO> {
  return {
    async create(createInput) {
      const handle = await input.backend.create(createInput);
      return wrapHandle({
        handle,
        authorize: () => input.authorizeSessionCommand(createInput.sessionKey),
      });
    },
    name: `${input.backend.name}-authorized`,
    prewarm(prewarmInput) {
      const bootstrap = prewarmInput.bootstrap;
      return input.backend.prewarm({
        ...prewarmInput,
        bootstrap:
          bootstrap === undefined
            ? undefined
            : (context) =>
                bootstrap({
                  ...context,
                  use: async (options) =>
                    createAuthorizedSandboxSession({
                      session: await context.use(options),
                    }),
                }),
      });
    },
  };
}
