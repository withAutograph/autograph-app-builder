import { describe, expect, it } from "vitest";

import { developmentLockInvocation } from "./advisory-lock";

describe("development advisory lock", () => {
  it("holds the macOS lock across the exact development command", () => {
    expect(
      developmentLockInvocation({
        platform: "darwin",
        lockPath: "/private/dev/development.lock",
        command: "/mise/node",
        args: ["--import", "tsx", "scripts/development.mts"],
      }),
    ).toEqual({
      command: "/usr/bin/lockf",
      args: [
        "-t",
        "0",
        "/private/dev/development.lock",
        "/mise/node",
        "--import",
        "tsx",
        "scripts/development.mts",
      ],
      busyExitCode: 75,
    });
  });

  it("uses a distinct lock-contention exit on Linux", () => {
    expect(
      developmentLockInvocation({
        platform: "linux",
        lockPath: "/private/dev/development.lock",
        command: "/mise/node",
        args: ["scripts/development.mts"],
      }),
    ).toEqual({
      command: "/usr/bin/flock",
      args: [
        "-E",
        "73",
        "-n",
        "/private/dev/development.lock",
        "/mise/node",
        "scripts/development.mts",
      ],
      busyExitCode: 73,
    });
  });
});
