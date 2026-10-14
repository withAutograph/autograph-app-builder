import { setTimeout as delay } from "node:timers/promises";

const postgresDigest = "sha256:48c8ad3a7284b82be4482a52076d47d879fd6fb084a1cbfccbd551f9331b0e40";
export const PRODUCTION_NAVIGATION_POSTGRES_IMAGE = `public.ecr.aws/docker/library/postgres@${postgresDigest}`;
export const PRODUCTION_NAVIGATION_POSTGRES_FALLBACK_IMAGE = `docker.io/library/postgres@${postgresDigest}`;

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

const missingPinnedImage = (result: ImageCommandResult, image: string): boolean =>
  result.exitCode === 1 &&
  result.stderr.trim() === `Error response from daemon: No such image: ${image}`;

const registryThrottled = (result: ImageCommandResult): boolean =>
  /\btoomanyrequests\b|\bHTTP(?:\/\d(?:\.\d)?)?\s+429\b|\b429\s+Too Many Requests\b|\bstatus code\s*:?\s*429\b/iu.test(
    result.stderr,
  );

/** Recover an observed registry throttle using the same immutable image, before container creation. */
export const ensureProductionNavigationImage = async (
  input: ImagePreflightInput,
): Promise<string> => {
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
  const present = async (image: string) => {
    const inspected = await command(["image", "inspect", image], 10_000);
    if (inspected.exitCode === 0) {
      return true;
    }
    if (!missingPinnedImage(inspected, image)) {
      throw new Error("Production navigation could not inspect the pinned PostgreSQL image.");
    }
    return false;
  };
  let image = PRODUCTION_NAVIGATION_POSTGRES_IMAGE;
  if (await present(image)) {
    return image;
  }
  const backoffs = [10_000, 20_000, 40_000];
  let retry = 0;
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Only observed registry throttling retries the immutable image within its existing deadline.
    const pulled = await command(["pull", image], 60_000);
    if (pulled.exitCode === 0) {
      return image;
    }
    if (!registryThrottled(pulled)) {
      throw new Error("Production navigation could not pull the pinned PostgreSQL image.");
    }
    if (image === PRODUCTION_NAVIGATION_POSTGRES_IMAGE) {
      // The canonical registry supplies the identical digest when the public mirror is throttled.
      image = PRODUCTION_NAVIGATION_POSTGRES_FALLBACK_IMAGE;
    } else {
      const backoff = backoffs[Math.min(retry, backoffs.length - 1)];
      if (backoff === undefined) {
        throw new Error(deadlineMessage);
      }
      retry += 1;
      input.signal.throwIfAborted();
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new Error(deadlineMessage);
      }
      // Docker's observed diagnostics do not expose Retry-After; keep the existing backoff and deadline.
      // oxlint-disable-next-line eslint/no-await-in-loop -- Abortable backoff follows only an observed registry throttle.
      await wait(Math.min(backoff, remaining), input.signal);
      input.signal.throwIfAborted();
    }
    // Another local pull may have completed while we waited. Inspect before asking a registry again.
    // oxlint-disable-next-line eslint/no-await-in-loop -- Local cache recheck precedes only an observed throttle recovery.
    if (await present(image)) {
      return image;
    }
  }
};
