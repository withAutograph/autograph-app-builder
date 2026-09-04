import { describe, expect, it, vi } from "vitest";

import { cloneGitHubSource } from "./sandbox-github-source";

describe("sandbox GitHub source", () => {
  it("passes the installation credential through git config without putting it in the command", async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    await cloneGitHubSource({
      sandbox: { run } as never,
      url: "https://github.com/acme/private.git",
      token: "secret-installation-token",
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          GIT_CONFIG_VALUE_0: expect.stringContaining("Authorization: Basic "),
        }),
      }),
    );
    expect(run.mock.calls[0]?.[0].command).not.toContain(
      "secret-installation-token",
    );
    expect(run.mock.calls[0]?.[0].env.GIT_CONFIG_VALUE_0).toBe(
      `Authorization: Basic ${Buffer.from("x-access-token:secret-installation-token").toString("base64")}`,
    );
  });
});
