import { holdActiveCommandLease } from "./active-command-lease";
import type { Sandbox, Command } from "@vercel/sandbox";
import type { SandboxRunOptions, SandboxProcess } from "eve/sandbox";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import type { BuilderSandboxSession } from "./builder-sandbox";

export type VercelSdkSessionNative = Pick<
  Sandbox,
  | "name"
  | "runCommand"
  | "readFile"
  | "readFileToBuffer"
  | "writeFiles"
  | "update"
  | "expiresAt"
  | "extendTimeout"
> & { readonly fs: Pick<Sandbox["fs"], "mkdir" | "writeFile" | "appendFile" | "rm"> };

const resolvePath = (value: string) => path.posix.resolve("/workspace", value);
const encoding = (value = "utf-8"): BufferEncoding => {
  if (!Buffer.isEncoding(value)) {
    throw new TypeError(`Unsupported text encoding: ${value}`);
  }
  return value;
};

/** The Builder's Vercel provider uses only the SDK's supported I/O APIs. */
export const createVercelSdkSession = (
  native: VercelSdkSessionNative,
  current: () => VercelSdkSessionNative = () => native,
  authorize?: () => Promise<void>,
): BuilderSandboxSession => {
  const runCommand = (options: SandboxRunOptions) => ({
    // A login profile may change directories after the SDK applies cwd.
    args: ["-c", options.command],
    cmd: "bash",
    cwd: resolvePath(options.workingDirectory ?? "."),
    env: options.env,
    signal: options.abortSignal,
  });
  const readBinaryFile: BuilderSandboxSession["readBinaryFile"] = async (options) =>
    await current().readFileToBuffer(
      { path: resolvePath(options.path) },
      { signal: options.abortSignal },
    );
  const writeBinaryFile: BuilderSandboxSession["writeBinaryFile"] = async (options) => {
    const provider = current();
    await provider.fs.mkdir(path.posix.dirname(resolvePath(options.path)), {
      recursive: true,
      signal: options.abortSignal,
    });
    await provider.writeFiles(
      [{ content: Buffer.from(options.content), path: resolvePath(options.path) }],
      {
        signal: options.abortSignal,
      },
    );
  };
  return {
    get id() {
      return current().name;
    },
    readBinaryFile,
    async readFile(options) {
      const content = await current().readFile(
        { path: resolvePath(options.path) },
        { signal: options.abortSignal },
      );
      if (content === null) {
        return null;
      }
      const stream = Readable.toWeb(content);
      // SAFETY: Vercel readFile streams bytes; Node and DOM stream declarations differ structurally.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The byte payload is established by the SDK readFile contract.
      return stream as ReadableStream<Uint8Array>;
    },
    async readTextFile(options) {
      const content = await readBinaryFile(options);
      if (content === null) {
        return null;
      }
      const text =
        (options.encoding ?? "utf-8") === "utf-8"
          ? new TextDecoder("utf-8", { fatal: true }).decode(content)
          : Buffer.from(content).toString(encoding(options.encoding));
      if (options.startLine === undefined && options.endLine === undefined) {
        return text;
      }
      return text
        .split("\n")
        .slice((options.startLine ?? 1) - 1, options.endLine)
        .join("\n");
    },
    async removePath(options) {
      await current().fs.rm(resolvePath(options.path), {
        force: options.force,
        recursive: options.recursive,
        signal: options.abortSignal,
      });
    },
    resolvePath,
    async run(options) {
      const lease = await holdActiveCommandLease({
        authorize,
        current,
        signal: options.abortSignal,
      });
      let command: Command | undefined;
      let killing: Promise<void> | undefined;
      const kill = () => {
        if (command !== undefined && killing === undefined) {
          const ownedCommand = command;
          killing = (async () => {
            try {
              await ownedCommand.kill("SIGTERM");
            } catch {
              /* The command may have already exited. */
            }
          })();
        }
      };
      lease.signal.addEventListener("abort", kill, { once: true });
      try {
        command = await current().runCommand({
          ...runCommand(options),
          detached: true,
          signal: lease.signal,
        });
        if (lease.signal.aborted) {
          kill();
        }
        const [stdout, stderr, result] = await Promise.all([
          command.stdout({ signal: lease.signal }),
          command.stderr({ signal: lease.signal }),
          command.wait({ signal: lease.signal }),
        ]);
        lease.signal.throwIfAborted();
        return { exitCode: result.exitCode, stderr, stdout };
      } catch (error) {
        kill();
        throw error;
      } finally {
        lease.signal.removeEventListener("abort", kill);
        await lease.finish();
        await killing;
      }
    },
    async setNetworkPolicy(policy) {
      await current().update({ networkPolicy: policy });
    },
    async spawn(options): Promise<SandboxProcess> {
      const stdout = new TransformStream<Uint8Array, Uint8Array>();
      const stderr = new TransformStream<Uint8Array, Uint8Array>();
      const output = Writable.fromWeb(stdout.writable);
      const errors = Writable.fromWeb(stderr.writable);
      // Detached SDK commands stream directly; no command/output deadline is added.
      const lease = await holdActiveCommandLease({
        authorize,
        current,
        signal: options.abortSignal,
      });
      let command;
      try {
        command = await current().runCommand({
          ...runCommand(options),
          detached: true,
          signal: lease.signal,
          stderr: errors,
          stdout: output,
        });
      } catch (error) {
        await lease.finish();
        output.end();
        errors.end();
        throw error;
      }
      let killing: Promise<void> | undefined;
      const kill = async () => {
        killing ??= (async () => {
          await command.kill("SIGTERM");
        })();
        await killing;
      };
      const abort = () => {
        void (async () => {
          try {
            await kill();
          } catch {
            // Native cancellation can race process exit.
          }
        })();
      };
      lease.signal.addEventListener("abort", abort, { once: true });
      if (lease.signal.aborted) {
        abort();
      }
      const completion = (async () => {
        try {
          const result = await command.wait({ signal: lease.signal });
          lease.signal.throwIfAborted();
          return { exitCode: result.exitCode };
        } finally {
          lease.signal.removeEventListener("abort", abort);
          await lease.finish();
          if (killing !== undefined) {
            try {
              await killing;
            } catch {
              /* Cancellation retains its own error. */
            }
          }
          output.end();
          errors.end();
        }
      })();
      // Preserve rejection for wait() while avoiding an unhandled rejection if the owner closes first.
      void (async () => {
        try {
          await completion;
        } catch {
          /* wait() retains the original failure. */
        }
      })();
      return {
        kill,
        stderr: stderr.readable,
        stdout: stdout.readable,
        wait: async () => await completion,
      };
    },
    writeBinaryFile,
    async writeFile(options) {
      const provider = current();
      const target = resolvePath(options.path);
      await provider.fs.mkdir(path.posix.dirname(target), {
        recursive: true,
        signal: options.abortSignal,
      });
      await provider.fs.writeFile(target, Buffer.alloc(0), { signal: options.abortSignal });
      for await (const chunk of options.content) {
        options.abortSignal?.throwIfAborted();
        await provider.fs.appendFile(target, chunk, { signal: options.abortSignal });
      }
    },
    writeTextFile: (options) =>
      writeBinaryFile({
        ...options,
        content: Buffer.from(options.content, encoding(options.encoding)),
      }),
  };
};
