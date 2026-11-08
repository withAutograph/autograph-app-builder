import { existsSync } from "node:fs";
import { captureProcessStdout, streamProcessStdout } from "./captured-process-output";

const systemGitPath = "/usr/bin/git";

export const git = function git(path: string, args: string[]): string {
  const executable = existsSync(systemGitPath) ? systemGitPath : "/bin/git";
  return captureProcessStdout(
    executable,
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.attributesfile=/dev/null",
      "-C",
      path,
      ...args,
    ],
    {
      env: {
        GIT_ATTR_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        HOME: "/dev/null",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        NODE_ENV: process.env.NODE_ENV ?? "production",
        PATH: "/usr/bin:/bin",
        TMPDIR: "/tmp",
        XDG_CONFIG_HOME: "/dev/null",
      },
    },
  )
    .toString("utf-8")
    .trim();
};

export const gitByteInvocation = (path: string, args: string[]) => ({
  args: [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.attributesfile=/dev/null",
    "-c",
    "credential.helper=",
    "-c",
    "protocol.allow=never",
    "-C",
    path,
    ...args,
  ],
  command: existsSync(systemGitPath) ? systemGitPath : "/bin/git",
  options: {
    env: {
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_NO_LAZY_FETCH: "1",
      GIT_TERMINAL_PROMPT: "0",
      HOME: "/dev/null",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      NODE_ENV: process.env.NODE_ENV ?? "production",
      PATH: "/usr/bin:/bin",
      TMPDIR: "/tmp",
      XDG_CONFIG_HOME: "/dev/null",
    },
  },
});

export const gitStream = (path: string, args: string[]): AsyncGenerator<Uint8Array> => {
  const command = gitByteInvocation(path, args);
  return streamProcessStdout(command.command, command.args, command.options);
};

export const gitNulRecords = async function* gitNulRecords(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<string> {
  let pending = Buffer.alloc(0);
  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array)) {
      throw new Error("Git emitted a non-byte source record.");
    }
    const bytes = pending.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
    let start = 0;
    for (let index = bytes.indexOf(0); index !== -1; index = bytes.indexOf(0, start)) {
      yield bytes.subarray(start, index).toString("utf-8");
      start = index + 1;
    }
    pending = bytes.subarray(start);
  }
  if (pending.byteLength > 0) {
    throw new Error("Git returned an incomplete source-tree record.");
  }
};
