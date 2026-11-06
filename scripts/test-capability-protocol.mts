import type { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";

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
  ) {
    throw new Error("Protocol relay configuration was invalid.");
  }

  const abortController = new AbortController();
  let buffered = Buffer.alloc(0);
  let frames = 0;
  let settled = false;
  let sourceEnded = false;
  let waitingForDrain = false;
  let processBuffered: (() => void) | undefined;
  const fail = (error: Error): void => {
    if (settled) {
      return;
    }
    settled = true;
    abortController.abort(error);
  };
  const finishIfComplete = () => {
    if (!sourceEnded || waitingForDrain || settled) {
      return;
    }
    if (frames !== options.expectedFrames || buffered.byteLength !== 0) {
      fail(new Error("Protocol relay ended before its exact frames."));
      return;
    }
    options.target.end();
  };
  const resumeAfterDrain = () => {
    waitingForDrain = false;
    processBuffered?.();
  };
  processBuffered = () => {
    while (true) {
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) {
        if (buffered.byteLength > maximumFrameBytes) {
          fail(new Error("Protocol frame exceeded its byte limit."));
        } else if (sourceEnded) {
          finishIfComplete();
        } else {
          options.source.resume();
        }
        return;
      }
      const frame = buffered.subarray(0, newline + 1);
      buffered = buffered.subarray(newline + 1);
      frames += 1;
      if (frame.byteLength > maximumFrameBytes) {
        fail(new Error("Protocol frame exceeded its byte limit."));
        return;
      }
      if (frames > options.expectedFrames) {
        fail(new Error("Protocol relay received trailing frames."));
        return;
      }
      if (!options.target.write(frame)) {
        waitingForDrain = true;
        options.target.once("drain", resumeAfterDrain);
        return;
      }
      if (frames === options.expectedFrames && buffered.byteLength > 0) {
        fail(new Error("Protocol relay received trailing bytes."));
        return;
      }
    }
  };
  options.source.on("data", (chunk: Buffer) => {
    options.source.pause();
    buffered = Buffer.concat([buffered, chunk]);
    processBuffered?.();
  });
  options.source.once("end", () => {
    sourceEnded = true;
    callbacks.processBuffered?.();
  });
  options.target.once("finish", () => {
    if (settled) {
      return;
    }
    settled = true;
  });
  options.source.once("error", (error) => {
    fail(error);
  });
  options.target.once("error", (error) => {
    fail(error);
  });
  await finished(options.target, { signal: abortController.signal });
}
