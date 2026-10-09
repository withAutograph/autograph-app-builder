import { setTimeout as delay } from "node:timers/promises";

export const PRODUCTION_NAVIGATION_POSTGRES_IMAGE =
  "public.ecr.aws/docker/library/postgres@sha256:48c8ad3a7284b82be4482a52076d47d879fd6fb084a1cbfccbd551f9331b0e40";

interface ImageCommandResult {
  exitCode: number;
  stderr: string;
}

interface ImagePreflightInput {
  runCommand: (
    args: string[],
    options: { signal: AbortSignal; timeoutMs: number },
  ) => Promise<ImageCommandResult>;
  signal: AbortSignal;
  now?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

const deadlineMessage = "Production navigation image preparation exceeded its deadline.";

const missingPinnedImage = (result: ImageCommandResult): boolean =>
  result.exitCode === 1 &&
  result.stderr.trim() ===
    `Error response from daemon: No such image: ${PRODUCTION_NAVIGATION_POSTGRES_IMAGE}`;

const registryThrottled = (result: ImageCommandResult): boolean =>
  /\btoomanyrequests\b|\bHTTP(?:\/\d(?:\.\d)?)?\s+429\b|\b429\s+Too Many Requests\b|\bstatus code\s*:?\s*429\b/iu.test(
    result.stderr,
  );

/** Retry only an observed registry throttle before the single container creation. */
export const ensureProductionNavigationImage = async (
  input: ImagePreflightInput,
): Promise<void> => {
  const now = input.now ?? Date.now;
  const wait =
    input.wait ?? (async (milliseconds, signal) => await delay(milliseconds, null, { signal }));
  const deadline = now() + 180_000;
  const command = async (args: string[], maximumTimeout: number) => {
    input.signal.throwIfAborted();
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error(deadlineMessage);
    }
    const result = await input.runCommand(args, {
      signal: input.signal,
      timeoutMs: Math.min(maximumTimeout, remaining),
    });
    input.signal.throwIfAborted();
    if (now() >= deadline) {
      throw new Error(deadlineMessage);
    }
    return result;
  };
  const inspected = await command(
    ["image", "inspect", PRODUCTION_NAVIGATION_POSTGRES_IMAGE],
    10_000,
  );
  if (inspected.exitCode === 0) {
    return;
  }
  if (!missingPinnedImage(inspected)) {
    throw new Error("Production navigation could not inspect the pinned PostgreSQL image.");
  }
  const backoffs = [10_000, 20_000, 40_000];
  for (let attempt = 0; attempt <= backoffs.length; attempt += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Only a registry throttle retries this same pinned image.
    const pulled = await command(["pull", PRODUCTION_NAVIGATION_POSTGRES_IMAGE], 60_000);
    if (pulled.exitCode === 0) {
      return;
    }
    if (!registryThrottled(pulled)) {
      throw new Error("Production navigation could not pull the pinned PostgreSQL image.");
    }
    const backoff = backoffs[attempt];
    if (backoff === undefined) {
      throw new Error(
        "Production navigation image registry remained throttled after four attempts.",
      );
    }
    input.signal.throwIfAborted();
    if (deadline - now() <= backoff) {
      throw new Error(deadlineMessage);
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- Abortable bounded backoff only follows registry throttling.
    await wait(backoff, input.signal);
    input.signal.throwIfAborted();
  }
};
