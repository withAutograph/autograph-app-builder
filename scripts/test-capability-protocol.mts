import type { Readable, Writable } from "node:stream";

export async function relayBoundedFrames(options: {
  source: Readable;
  target: Writable;
  expectedFrames: number;
  maximumFrameBytes?: number;
}): Promise<void> {
  const maximumFrameBytes = options.maximumFrameBytes ?? 4096;
  if (
    !Number.isSafeInteger(options.expectedFrames) ||
    options.expectedFrames < 1 ||
    !Number.isSafeInteger(maximumFrameBytes) ||
    maximumFrameBytes < 1
  )
    throw new Error("Protocol relay configuration was invalid.");

  await new Promise<void>((resolveRelay, rejectRelay) => {
    let buffered = Buffer.alloc(0);
    let frames = 0;
    let settled = false;
    let sourceEnded = false;
    let waitingForDrain = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      options.source.destroy();
      options.target.destroy();
      rejectRelay(error);
    };
    const finishIfComplete = () => {
      if (!sourceEnded || waitingForDrain || settled) return;
      if (frames !== options.expectedFrames || buffered.byteLength !== 0)
        return fail(new Error("Protocol relay ended before its exact frames."));
      options.target.end();
    };
    const processBuffered = () => {
      while (true) {
        const newline = buffered.indexOf(0x0a);
        if (newline < 0) {
          if (buffered.byteLength > maximumFrameBytes)
            fail(new Error("Protocol frame exceeded its byte limit."));
          else if (sourceEnded) finishIfComplete();
          else options.source.resume();
          return;
        }
        const frame = buffered.subarray(0, newline + 1);
        buffered = buffered.subarray(newline + 1);
        frames += 1;
        if (frame.byteLength > maximumFrameBytes)
          return fail(new Error("Protocol frame exceeded its byte limit."));
        if (frames > options.expectedFrames)
          return fail(new Error("Protocol relay received trailing frames."));
        if (!options.target.write(frame)) {
          waitingForDrain = true;
          options.target.once("drain", () => {
            waitingForDrain = false;
            processBuffered();
          });
          return;
        }
        if (frames === options.expectedFrames && buffered.byteLength > 0)
          return fail(new Error("Protocol relay received trailing bytes."));
      }
    };
    options.source.on("data", (chunk: Buffer) => {
      options.source.pause();
      buffered = Buffer.concat([buffered, chunk]);
      processBuffered();
    });
    options.source.once("end", () => {
      sourceEnded = true;
      processBuffered();
    });
    options.target.once("finish", () => {
      if (settled) return;
      settled = true;
      resolveRelay();
    });
    options.source.once("error", (error) => fail(error));
    options.target.once("error", (error) => fail(error));
  });
}
