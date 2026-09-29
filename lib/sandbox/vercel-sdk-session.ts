import type { Sandbox } from "@vercel/sandbox";
import type { SandboxRunOptions, SandboxProcess } from "eve/sandbox";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import type { BuilderSandboxSession } from "./builder-sandbox";

const resolvePath = (value: string) => path.posix.resolve("/workspace", value);
const encoding = (value = "utf-8"): BufferEncoding => {
  if (!Buffer.isEncoding(value)) {
    throw new TypeError(`Unsupported text encoding: ${value}`);
  }
  return value;
};

/** The Builder's Vercel provider uses only the SDK's supported I/O APIs. */
export const createVercelSdkSession = (native: Sandbox): BuilderSandboxSession => {
  const runCommand = (options: SandboxRunOptions) => ({
    args: ["-lc", options.command],
    cmd: "bash",
    cwd: resolvePath(options.workingDirectory ?? "."),
    env: options.env,
    signal: options.abortSignal,
  });
  const readBinaryFile: BuilderSandboxSession["readBinaryFile"] = async (options) =>
    await native.readFileToBuffer(
      { path: resolvePath(options.path) },
      { signal: options.abortSignal },
    );
  const writeBinaryFile: BuilderSandboxSession["writeBinaryFile"] = async (options) => {
    await native.fs.mkdir(path.posix.dirname(resolvePath(options.path)), {
      recursive: true,
      signal: options.abortSignal,
    });
    await native.writeFiles(
      [{ content: Buffer.from(options.content), path: resolvePath(options.path) }],
      {
        signal: options.abortSignal,
      },
    );
  };
  return {
    id: native.name,
    readBinaryFile,
    async readFile(options) {
      const content = await native.readFile(
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
      await native.fs.rm(resolvePath(options.path), {
        force: options.force,
        recursive: options.recursive,
        signal: options.abortSignal,
      });
    },
    resolvePath,
    async run(options) {
      const command = await native.runCommand(runCommand(options));
      const [stdout, stderr] = await Promise.all([
        command.stdout({ signal: options.abortSignal }),
        command.stderr({ signal: options.abortSignal }),
      ]);
      return { exitCode: command.exitCode, stderr, stdout };
    },
    async setNetworkPolicy(policy) {
      await native.update({ networkPolicy: policy });
    },
    async spawn(options): Promise<SandboxProcess> {
      const stdout = new TransformStream<Uint8Array, Uint8Array>();
      const stderr = new TransformStream<Uint8Array, Uint8Array>();
      const output = Writable.fromWeb(stdout.writable);
      const errors = Writable.fromWeb(stderr.writable);
      // Detached SDK commands stream directly; no command/output deadline is added.
      const command = await native.runCommand({
        ...runCommand(options),
        detached: true,
        stderr: errors,
        stdout: output,
      });
      const kill = async () => {
        await command.kill("SIGTERM");
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
      options.abortSignal?.addEventListener("abort", abort, { once: true });
      if (options.abortSignal?.aborted === true) {
        abort();
      }
      return {
        kill,
        stderr: stderr.readable,
        stdout: stdout.readable,
        async wait() {
          try {
            const result = await command.wait({ signal: options.abortSignal });
            return { exitCode: result.exitCode };
          } finally {
            options.abortSignal?.removeEventListener("abort", abort);
            output.end();
            errors.end();
          }
        },
      };
    },
    writeBinaryFile,
    async writeFile(options) {
      const target = resolvePath(options.path);
      await native.fs.mkdir(path.posix.dirname(target), {
        recursive: true,
        signal: options.abortSignal,
      });
      await native.fs.writeFile(target, Buffer.alloc(0), { signal: options.abortSignal });
      for await (const chunk of options.content) {
        options.abortSignal?.throwIfAborted();
        await native.fs.appendFile(target, chunk, { signal: options.abortSignal });
      }
    },
    writeTextFile: (options) =>
      writeBinaryFile({
        ...options,
        content: Buffer.from(options.content, encoding(options.encoding)),
      }),
  };
};
