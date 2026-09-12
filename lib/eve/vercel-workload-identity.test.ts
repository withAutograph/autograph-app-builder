import { describe, expect, it, vi } from "vitest";

import { createVercelWorkloadIdentity } from "./vercel-workload-identity";

describe("Vercel workload identity", () => {
  it("acquires nothing until a request-context token is needed", async () => {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const getToken = vi.fn(async () => "source-token");
    const identity = createVercelWorkloadIdentity({ getToken });

    expect(getToken).not.toHaveBeenCalled();

    await expect(identity.token()).resolves.toBe("source-token");
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it.each(["", " token", "token\n", `x${"y".repeat(8192)}`])(
    "rejects malformed source credentials",
    async (token) => {
      const identity = createVercelWorkloadIdentity({
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        getToken: async () => token,
      });

      await expect(identity.token()).rejects.toThrow("unavailable");
    },
  );
});
