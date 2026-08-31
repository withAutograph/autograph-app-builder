import { spawn, type ChildProcess } from "node:child_process";
import { platform as hostPlatform } from "node:os";

import {
  developmentChildExit,
  stopDevelopmentChild,
} from "./process-supervisor";

type SupportedPlatform = "darwin" | "linux";

export type DevelopmentLockInvocation = Readonly<{
  command: string;
  args: readonly string[];
  busyExitCode: number;
}>;

export function developmentLockInvocation(input: {
  platform: SupportedPlatform;
  lockPath: string;
  command: string;
  args: readonly string[];
}): DevelopmentLockInvocation {
  if (input.platform === "darwin")
    return {
      command: "/usr/bin/lockf",
      args: ["-t", "0", input.lockPath, input.command, ...input.args],
      busyExitCode: 75,
    };
  return {
    command: "/usr/bin/flock",
    args: ["-E", "73", "-n", input.lockPath, input.command, ...input.args],
    busyExitCode: 73,
  };
}

function supportedPlatform(): SupportedPlatform {
  const platform = hostPlatform();
  if (platform === "darwin" || platform === "linux") return platform;
  throw new Error("Development mode supports macOS and Linux hosts only.");
}

export async function runWithDevelopmentLock(input: {
  lockPath: string;
  command: string;
  args: readonly string[];
  environment?: NodeJS.ProcessEnv;
  spawnChild?: typeof spawn;
}): Promise<number> {
  const invocation = developmentLockInvocation({
    platform: supportedPlatform(),
    lockPath: input.lockPath,
    command: input.command,
    args: input.args,
  });
  const child: ChildProcess = (input.spawnChild ?? spawn)(
    invocation.command,
    [...invocation.args],
    {
      env: input.environment ?? process.env,
      stdio: "inherit",
    },
  );
  const signals = ["SIGINT", "SIGTERM"] as const;
  const handlers = signals.map((signal) => {
    const handler = () => void stopDevelopmentChild(child);
    process.once(signal, handler);
    return { signal, handler };
  });
  try {
    const code = await developmentChildExit(child);
    if (code === invocation.busyExitCode)
      throw new Error(
        "Another `mise run dev` proof already owns this App Builder state root.",
      );
    return code;
  } finally {
    for (const { signal, handler } of handlers)
      process.removeListener(signal, handler);
  }
}
