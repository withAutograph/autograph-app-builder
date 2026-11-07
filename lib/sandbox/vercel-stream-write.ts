/* oxlint-disable eslint/no-await-in-loop, react-doctor/async-await-in-loop, react-doctor/server-sequential-independent-await -- Chunk uploads and final commit preserve stream order and bounded backpressure. */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { VercelSdkSessionNative } from "./vercel-sdk-session";
import { holdActiveCommandLease } from "./active-command-lease";

const CHUNK_BYTES = 8 * 1024 * 1024;
const createStage = `require('node:fs').mkdirSync(process.argv[1], {mode:0o700});`;
const commitStage = `
const fs = require('node:fs');
const path = require('node:path');
const {pipeline} = require('node:stream/promises');
const {Readable} = require('node:stream');
(async () => {
  const [stage, target, count] = process.argv.slice(1);
  const temporary = path.join(stage, 'complete');
  let mode = 0o644;
  try { mode = fs.statSync(target).mode & 0o777; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const output = fs.createWriteStream(temporary, {flags:'wx', mode:0o600});
  try {
    async function* chunks() {
      for (let index=0; index<Number(count); index++) {
        yield* fs.createReadStream(path.join(stage, String(index)));
      }
    }
    await pipeline(Readable.from(chunks(), {objectMode:false}), output);
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, target);
  } catch (error) { output.destroy(); throw error; }
})().catch(() => { process.exitCode=1; });
`;

/** SDK fs.appendFile rereads/reuploads the growing file. Stage bounded chunks instead. */
export const writeVercelStream = async (input: {
  current: () => VercelSdkSessionNative;
  authorize?: () => Promise<void>;
  target: string;
  content: ReadableStream<Uint8Array>;
  signal?: AbortSignal;
}): Promise<void> => {
  const lease = await holdActiveCommandLease({
    authorize: input.authorize,
    current: input.current,
    signal: input.signal,
  });
  const stage = path.posix.join(
    path.posix.dirname(input.target),
    `.autograph-stream-${randomUUID()}`,
  );
  let created = false;
  const command = async (program: string, args: string[]) => {
    await input.authorize?.();
    lease.signal.throwIfAborted();
    const running = await input.current().runCommand({
      args: ["-e", program, ...args],
      cmd: "node",
      detached: true,
      signal: lease.signal,
    });
    let killing: Promise<void> | undefined;
    const kill = () => {
      killing ??= (async () => {
        try {
          await running.kill("SIGTERM");
        } catch {
          /* Completion may race cancellation. */
        }
      })();
    };
    lease.signal.addEventListener("abort", kill, { once: true });
    try {
      if (lease.signal.aborted) {
        kill();
      }
      const result = await running.wait({ signal: lease.signal });
      lease.signal.throwIfAborted();
      if (result.exitCode !== 0) {
        throw new Error("The Builder stream transfer could not complete.");
      }
    } catch (error) {
      kill();
      throw error;
    } finally {
      lease.signal.removeEventListener("abort", kill);
      await killing;
    }
  };
  try {
    await input.authorize?.();
    lease.signal.throwIfAborted();
    await input
      .current()
      .fs.mkdir(path.posix.dirname(input.target), { recursive: true, signal: lease.signal });
    await command(createStage, [stage]);
    created = true;
    let count = 0;
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let used = 0;
    const upload = async () => {
      await input.authorize?.();
      lease.signal.throwIfAborted();
      await input.current().writeFiles(
        [
          {
            content: Buffer.from(buffer.subarray(0, used)),
            mode: 0o600,
            path: path.posix.join(stage, String(count)),
          },
        ],
        { signal: lease.signal },
      );
      count += 1;
      used = 0;
    };
    for await (const chunk of input.content) {
      lease.signal.throwIfAborted();
      let offset = 0;
      while (offset < chunk.byteLength) {
        const length = Math.min(CHUNK_BYTES - used, chunk.byteLength - offset);
        buffer.set(chunk.subarray(offset, offset + length), used);
        used += length;
        offset += length;
        if (used === CHUNK_BYTES) {
          await upload();
        }
      }
    }
    if (used > 0) {
      await upload();
    }
    await command(commitStage, [stage, input.target, String(count)]);
  } finally {
    if (created) {
      try {
        await input.current().fs.rm(stage, { force: true, recursive: true });
      } catch {
        /* Retain the initiating transfer/abort error. */
      }
    }
    await lease.finish();
  }
};
