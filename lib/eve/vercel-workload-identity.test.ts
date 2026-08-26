import { describe, expect, it, vi } from "vitest";

import { createVercelWorkloadIdentity } from "./vercel-workload-identity";

const principal = {
  issuer: "https://identity.example.test",
  audience: "eve-hosted",
  workspaceId: "workspace-1",
  ownerUserId: "user-1",
  scopes: ["eve:session"],
};

describe("Vercel workload identity", () => {
  it("acquires nothing until a request-context token is needed", async () => {
    const getToken = vi.fn(async () => "source-token");
    const exchangeToken = vi.fn(
      async (input: { token: string; audience: string }) => {
        void input;
        return "gateway-token";
      },
    );
    const identity = createVercelWorkloadIdentity({ getToken, exchangeToken });

    expect(getToken).not.toHaveBeenCalled();
    expect(exchangeToken).not.toHaveBeenCalled();

    await expect(
      identity.token({ audience: "eve-workload", principal }),
    ).resolves.toBe("gateway-token");
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(exchangeToken).toHaveBeenCalledWith({
      token: "source-token",
      audience: "eve-workload",
    });
    expect(exchangeToken.mock.calls[0]?.[0]).not.toHaveProperty("principal");
  });

  it.each(["", " token", "token\n", `x${"y".repeat(8_192)}`])(
    "rejects malformed source credentials without exchange",
    async (token) => {
      const exchangeToken = vi.fn(async () => "gateway-token");
      const identity = createVercelWorkloadIdentity({
        getToken: async () => token,
        exchangeToken,
      });

      await expect(
        identity.token({ audience: "eve-workload", principal }),
      ).rejects.toThrow("unavailable");
      expect(exchangeToken).not.toHaveBeenCalled();
    },
  );

  it("rejects a malformed exchanged credential", async () => {
    const identity = createVercelWorkloadIdentity({
      getToken: async () => "source-token",
      exchangeToken: async () => "gateway-token\n",
    });

    await expect(
      identity.token({ audience: "eve-workload", principal }),
    ).rejects.toThrow("unavailable");
  });
});
