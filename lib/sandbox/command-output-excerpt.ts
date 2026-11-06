/* oxlint-disable eslint/no-await-in-loop -- Stream reads apply sequential backpressure while retaining only a bounded sanitized excerpt. */
import type { SandboxSession, SandboxRunOptions } from "eve/sandbox";

const MAX_DIAGNOSTIC_LINE = 6000;
/** Drain all command output, retaining only bounded sanitized complete diagnostic lines. */
export const runSandboxCommandWithExcerpt = async (input: {
  sandbox: Pick<SandboxSession, "run"> & Partial<Pick<SandboxSession, "spawn">>;
  options: SandboxRunOptions;
  sanitize: (value: string) => string;
}) => {
  if (input.sandbox.spawn === undefined) {
    const result = await input.sandbox.run(input.options);
    return {
      ...result,
      stderr: input.sanitize(result.stderr),
      stdout: input.sanitize(result.stdout),
    };
  }
  const process = await input.sandbox.spawn(input.options);
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let line = "";
    let excerpt = "";
    let omitted = false;
    const finishLine = () => {
      const safe = omitted ? "[Long diagnostic line omitted]" : input.sanitize(line);
      excerpt = `${excerpt}${safe}\n`.slice(-MAX_DIAGNOSTIC_LINE);
      line = "";
      omitted = false;
    };
    const append = (text: string) => {
      for (const character of text) {
        if (character === "\n") {
          finishLine();
        } else if (!omitted) {
          line += character;
          if (line.length > MAX_DIAGNOSTIC_LINE) {
            line = "";
            omitted = true;
          }
        }
      }
    };
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        append(decoder.decode(next.value, { stream: true }));
      }
      append(decoder.decode());
      if (line || omitted) {
        finishLine();
      }
      return input.sanitize(excerpt);
    } finally {
      reader.releaseLock();
    }
  };
  try {
    const [stdout, stderr, status] = await Promise.all([
      drain(process.stdout),
      drain(process.stderr),
      process.wait(),
    ]);
    input.options.abortSignal?.throwIfAborted();
    return { exitCode: status.exitCode, stderr, stdout };
  } catch (error) {
    await process.kill();
    throw error;
  }
};
