import type { SandboxSession } from "eve/sandbox";
import { describe, expect, it, vi } from "vitest";

import { prepareWithVerifiedGitHubFetchRecovery } from "./verified-github-fetch-recovery";

const rejectedFetch = () =>
  new Error(
    "Builder could not fetch the current draft head (exit 128). Check the selected repository and GitHub access, then retry. Cause: remote: Repository not found. fatal: repository '[URL REDACTED]' not found",
  );

const fixture = () => {
  const setNetworkPolicy = vi.fn().mockResolvedValue(null);
  const acquireCredential = vi
    .fn()
    .mockResolvedValueOnce({ token: "first-private-token" })
    .mockResolvedValueOnce({ token: "second-private-token" });
  return {
    acquireCredential,
    sandbox: { setNetworkPolicy } satisfies Pick<SandboxSession, "setNetworkPolicy">,
    setNetworkPolicy,
  };
};

describe("verified GitHub fetch recovery", () => {
  it("prepares normally with one credential and restores sandbox networking", async () => {
    const { acquireCredential, sandbox, setNetworkPolicy } = fixture();
    const prepare = vi.fn().mockResolvedValue({ created: true });

    await expect(
      prepareWithVerifiedGitHubFetchRecovery({ acquireCredential, prepare, sandbox }),
    ).resolves.toEqual({ prepared: { created: true }, retriedGitFetch: false });
    expect(prepare).toHaveBeenCalledOnce();
    expect(acquireCredential).toHaveBeenCalledOnce();
    expect(setNetworkPolicy).toHaveBeenCalledTimes(2);
    expect(setNetworkPolicy).toHaveBeenNthCalledWith(2, "allow-all");
  });

  it("reacquires a credential and retries a rejected private Git fetch once", async () => {
    const { acquireCredential, sandbox, setNetworkPolicy } = fixture();
    const prepare = vi.fn().mockRejectedValueOnce(rejectedFetch()).mockResolvedValue({
      created: true,
    });

    await expect(
      prepareWithVerifiedGitHubFetchRecovery({ acquireCredential, prepare, sandbox }),
    ).resolves.toEqual({ prepared: { created: true }, retriedGitFetch: true });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(acquireCredential).toHaveBeenCalledTimes(2);
    expect(setNetworkPolicy).toHaveBeenCalledTimes(4);
    expect(setNetworkPolicy).toHaveBeenNthCalledWith(2, "allow-all");
    expect(setNetworkPolicy).toHaveBeenNthCalledWith(4, "allow-all");
  });

  it("names the sandbox Git credential boundary after two verified fetch rejections", async () => {
    const { acquireCredential, sandbox, setNetworkPolicy } = fixture();
    const prepare = vi.fn().mockRejectedValue(rejectedFetch());

    await expect(
      prepareWithVerifiedGitHubFetchRecovery({ acquireCredential, prepare, sandbox }),
    ).rejects.toThrow(
      "Builder verified this repository through its GitHub installation, but the sandbox Git fetch",
    );
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(setNetworkPolicy).toHaveBeenNthCalledWith(4, "allow-all");
  });

  it("does not retry a changed branch or another Git operation failure", async () => {
    const { acquireCredential, sandbox, setNetworkPolicy } = fixture();
    const prepare = vi.fn().mockRejectedValue(new Error("Builder's draft branch moved"));

    await expect(
      prepareWithVerifiedGitHubFetchRecovery({ acquireCredential, prepare, sandbox }),
    ).rejects.toThrow("Builder's draft branch moved");
    expect(prepare).toHaveBeenCalledOnce();
    expect(acquireCredential).toHaveBeenCalledOnce();
    expect(setNetworkPolicy).toHaveBeenCalledTimes(2);
  });

  it("does not retry if acquiring the installation credential fails", async () => {
    const { sandbox, setNetworkPolicy } = fixture();
    const acquireCredential = vi.fn().mockRejectedValue(new Error("installation disconnected"));
    const prepare = vi.fn();

    await expect(
      prepareWithVerifiedGitHubFetchRecovery({ acquireCredential, prepare, sandbox }),
    ).rejects.toThrow("installation disconnected");
    expect(prepare).not.toHaveBeenCalled();
    expect(setNetworkPolicy).not.toHaveBeenCalled();
  });
});
