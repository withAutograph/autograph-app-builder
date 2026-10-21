import type { BuilderSandboxSession } from "../sandbox/builder-sandbox";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { prepareWithVerifiedGitHubFetchRecovery } from "./verified-github-fetch-recovery";
import { annotateDraftWorktreeRetirementError } from "../repository/retire-unused-draft-worktrees";
import type { DraftWorktreeRetirementAdvisory } from "../repository/retire-unused-draft-worktrees";

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
    sandbox: { setNetworkPolicy } satisfies Pick<BuilderSandboxSession, "setNetworkPolicy">,
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

describe("preparation failure cleanup advisory", () => {
  const advisory: DraftWorktreeRetirementAdvisory = {
    status: "complete",
    retired: 1,
    retained: 2,
    reasons: { referenced: 1, private_state: 1 },
    capacity: { after: { bytes: { total: "4096", available: "0" } } },
  };
  const appendedAdvisory = (error: Error, original: string) => {
    expect(error.message.startsWith(original)).toBe(true);
    const suffix = error.message.slice(original.length);
    return z.json().parse(JSON.parse(suffix.slice(suffix.indexOf("{"))));
  };

  it("preserves the actual command error identity and cause while adding sanitized maintenance evidence", async () => {
    const f = fixture();
    const cause = new Error("controlled command cause");
    const original = new TypeError("Builder could not create its checkout (exit 128)", { cause });
    const message = original.message;
    const prepare = vi.fn().mockRejectedValue(original);
    const run = async () => {
      try {
        return await prepareWithVerifiedGitHubFetchRecovery({ ...f, prepare });
      } catch (error) {
        annotateDraftWorktreeRetirementError(error, advisory);
        throw error;
      }
    };
    await expect(run()).rejects.toBe(original);
    expect(original).toBeInstanceOf(TypeError);
    expect(original.cause).toBe(cause);
    expect(appendedAdvisory(original, message)).toEqual(advisory);
    expect(prepare).toHaveBeenCalledOnce();
    expect(f.acquireCredential).toHaveBeenCalledOnce();
    expect(f.setNetworkPolicy).toHaveBeenLastCalledWith("allow-all");
  });

  it("keeps the existing single verified fetch retry before annotating its terminal failure", async () => {
    const f = fixture();
    const rejection = rejectedFetch();
    const prepare = vi.fn().mockRejectedValue(rejection);
    let terminal: unknown;
    try {
      await prepareWithVerifiedGitHubFetchRecovery({ ...f, prepare });
    } catch (error) {
      terminal = error;
      const message = error instanceof Error ? error.message : "";
      annotateDraftWorktreeRetirementError(error, advisory);
      if (!(error instanceof Error)) {
        throw new Error("Expected the original preparation failure", { cause: error });
      }
      expect(appendedAdvisory(error, message)).toEqual(advisory);
    }
    expect(terminal).toBeInstanceOf(Error);
    expect(terminal).toHaveProperty("cause", rejection);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(f.acquireCredential).toHaveBeenCalledTimes(2);
    expect(f.setNetworkPolicy).toHaveBeenCalledTimes(4);
    expect(f.setNetworkPolicy).toHaveBeenLastCalledWith("allow-all");
  });

  it("reports unavailable maintenance without replacing an ordinary preparation failure", () => {
    const error = new Error("Original command failed");
    const message = error.message;
    const unavailable: DraftWorktreeRetirementAdvisory = {
      status: "unavailable",
      retired: 0,
      retained: 0,
      reasons: {},
    };
    annotateDraftWorktreeRetirementError(error, unavailable);
    expect(appendedAdvisory(error, message)).toEqual(unavailable);
  });

  it("keeps cancellation and nonwritable or unknown failures untouched", () => {
    const controller = new AbortController();
    const cancellation = new DOMException("Original Stop reason", "AbortError");
    controller.abort(cancellation);
    expect(() => {
      annotateDraftWorktreeRetirementError(cancellation, advisory, controller.signal);
    }).not.toThrow();
    expect(cancellation.message).toBe("Original Stop reason");
    const frozen = Object.freeze(new Error("Frozen original"));
    expect(() => {
      annotateDraftWorktreeRetirementError(frozen, advisory);
    }).not.toThrow();
    expect(frozen.message).toBe("Frozen original");
    const unknown = { detail: "Unclassified original rejection" };
    expect(() => {
      annotateDraftWorktreeRetirementError(unknown, advisory);
    }).not.toThrow();
    expect(unknown).toEqual({ detail: "Unclassified original rejection" });
  });

  it("never appends unknown diagnostic fields or private reason strings", () => {
    const error = new Error("Original command failed");
    const unsafe = {
      ...advisory,
      secret: "private-token",
      reasons: { ...advisory.reasons, "/private/source/root": 1 },
    };
    expect(() => {
      annotateDraftWorktreeRetirementError(error, unsafe);
    }).not.toThrow();
    expect(error.message.startsWith("Original command failed")).toBe(true);
    expect(error.message).not.toContain("private-token");
    expect(error.message).not.toContain("/private/source/root");
  });
});
