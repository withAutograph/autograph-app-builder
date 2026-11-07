import type { SandboxSession } from "eve/sandbox";

/** Protect commands while preserving every application/provider capability. */
export const createAuthorizedSandboxSession = <Session extends SandboxSession>(input: {
  session: Session;
  authorize?: () => Promise<unknown>;
}): Session => ({
  ...input.session,
  async run(options) {
    await input.authorize?.();
    return await input.session.run(options);
  },
  async spawn(options) {
    await input.authorize?.();
    return await input.session.spawn(options);
  },
});
