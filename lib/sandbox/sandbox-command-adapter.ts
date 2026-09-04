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
    resolvePath: (path) => input.session.resolvePath(path),
    setNetworkPolicy: (policy) => input.session.setNetworkPolicy(policy),
    removePath: (options) => input.session.removePath(options),
    readFile: (options) => input.session.readFile(options),
    readBinaryFile: (options) => input.session.readBinaryFile(options),
    readTextFile: (options) => input.session.readTextFile(options),
    writeFile: (options) => input.session.writeFile(options),
    writeBinaryFile: (options) => input.session.writeBinaryFile(options),
    writeTextFile: (options) => input.session.writeTextFile(options),
    async run(options) {
      await authorize();
      // Vercel Sandbox owns command streaming and the explicit caller abort
      // signal. Do not insert an unrelated wall, silence, or output limit
      // between an Arrusted operation and its provider runtime.
      return input.session.run(options);
    },
    async spawn() {
      await authorize();
      throw new Error(
        "Direct authored sandbox spawn is disabled; use the bounded command adapter.",
      );
    },
  };
}

function wrapHandle<SO>(input: {
  handle: SandboxBackendHandle<SO>;
  authorize: () => Promise<unknown>;
}): SandboxBackendHandle<SO> {
  return {
    ...input.handle,
    session: createAuthorizedSandboxSession({
      session: input.handle.session,
      authorize: input.authorize,
    }),
    async useSessionFn(options) {
      return createAuthorizedSandboxSession({
        session: await input.handle.useSessionFn(options),
        authorize: input.authorize,
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
    name: `${input.backend.name}-bounded-v1`,
    async create(createInput) {
      const handle = await input.backend.create(createInput);
      return wrapHandle({
        handle,
        authorize: () => input.authorizeSessionCommand(createInput.sessionKey),
      });
    },
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
