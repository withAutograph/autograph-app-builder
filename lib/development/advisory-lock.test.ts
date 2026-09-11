import { describe, expect, it } from "vitest";

import { developmentLockInvocation } from "./advisory-lock";

describe("development advisory lock", () => {
  it("holds the macOS lock across the exact development command", () => {
    expect(
      developmentLockInvocation({
        args: ["--import", "tsx", "scripts/development.mts"],
        command: "/mise/node",
        lockPath: "/private/dev/development.lock",
        platform: "darwin",
      })
    ).toEqual({
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
      command: "/usr/bin/lockf",
    });
  });

  it("uses a distinct lock-contention exit on Linux", () => {
    expect(
      developmentLockInvocation({
        args: ["scripts/development.mts"],
        command: "/mise/node",
        lockPath: "/private/dev/development.lock",
        platform: "linux",
      })
    ).toEqual({
      args: [
        "-E",
        "73",
        "-n",
        "/private/dev/development.lock",
        "/mise/node",
        "scripts/development.mts",
      ],
      busyExitCode: 73,
      command: "/usr/bin/flock",
    });
  });
});
