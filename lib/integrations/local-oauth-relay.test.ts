import { describe, expect, it } from "vitest";
import { signLocalVercelRelay, verifyLocalVercelRelay } from "./local-oauth-relay";

describe("local Vercel OAuth relay", () => {
  it("accepts only signed, unexpired relay state", () => {
    const secret = "s".repeat(32);
    const value = signLocalVercelRelay(
      {
        state: "a".repeat(32),
        configurationId: "icfg_1",
        teamId: "team_1",
        origin: "https://branch-one.vercel.app",
        expiresAt: 2000,
      },
      secret,
    );
    expect(
      verifyLocalVercelRelay(value, secret, 1000, "https://branch-one.vercel.app"),
    ).toMatchObject({
      teamId: "team_1",
    });
    expect(() =>
      verifyLocalVercelRelay(value, secret, 1000, "https://branch-two.vercel.app"),
    ).toThrow("origin");
    expect(() => verifyLocalVercelRelay(`${value}x`, secret, 1000)).toThrow();
    expect(() => verifyLocalVercelRelay(value, secret, 2000)).toThrow();
  });
});
