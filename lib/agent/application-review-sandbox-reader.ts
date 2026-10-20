import { Sandbox } from "@vercel/sandbox";
import type { SandboxSession } from "eve/sandbox";
import path from "node:path";
import { Readable } from "node:stream";

type ReviewReadSession = Pick<ReturnType<Sandbox["currentSession"]>, "readFile">;

export interface ApplicationReviewSandboxReaderDependencies {
  get?: (
    options: Parameters<typeof Sandbox.get>[0],
  ) => Promise<{ currentSession: () => ReviewReadSession }>;
}

/** Reconnect a server-owned review source without creating or resuming compute. */
export const createApplicationReviewSandboxReader = async (
  input: {
    sandboxName: string;
    abortSignal?: AbortSignal;
    assertCurrentOwner: () => Promise<void>;
  },
  dependencies: ApplicationReviewSandboxReaderDependencies = {},
): Promise<Pick<SandboxSession, "readFile">> => {
  const guard = async (signal = input.abortSignal) => {
    signal?.throwIfAborted();
    await input.assertCurrentOwner();
    signal?.throwIfAborted();
  };
  await guard();
  const get: NonNullable<ApplicationReviewSandboxReaderDependencies["get"]> =
    dependencies.get ?? ((options) => Sandbox.get(options));
  const sandbox = await get({
    name: input.sandboxName,
    resume: false,
    signal: input.abortSignal,
  });
  await guard();
  // Sandbox.readFile auto-resumes stopped compute. Session.readFile never does.
  const session = sandbox.currentSession();
  return {
    async readFile(options) {
      let signal = input.abortSignal ?? options.abortSignal;
      if (input.abortSignal !== undefined && options.abortSignal !== undefined) {
        signal = AbortSignal.any([input.abortSignal, options.abortSignal]);
      }
      await guard(signal);
      const content = await session.readFile(
        { path: path.posix.resolve("/workspace", options.path) },
        { signal },
      );
      if (content === null) {
        await guard(signal);
        return null;
      }
      const stream = Readable.toWeb(content);
      try {
        await guard(signal);
      } catch (error) {
        try {
          await stream.cancel();
        } catch {
          // Preserve the owner/cancellation failure after closing the local reader.
        }
        throw error;
      }
      // SAFETY: The SDK readFile contract supplies bytes; Node and DOM stream types differ.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Preserve the supported SDK byte stream through Node's conversion.
      return stream as ReadableStream<Uint8Array>;
    },
  };
};
