import { expect, it, vi } from "vitest";
import { acquireHostedEvalOidc } from "./hosted-eval-oidc";

const scope = { environment: "preview", projectId: "prj_eval", teamId: "team_eval" };

it("acquires fresh invocation identity and asks SDK to verify exact hosted scope", async () => {
  const getToken = vi.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("second");
  const verify = vi.fn().mockResolvedValue({ payload: { exp: 1234 } });
  const result = await acquireHostedEvalOidc(scope, { getToken, verify });
  expect(result).toEqual({
    expiresAt: 1234,
    projectId: "prj_eval",
    teamId: "team_eval",
    token: "first",
  });
  expect(verify).toHaveBeenCalledWith("first", {
    environment: "preview",
    ownerId: "team_eval",
    projectId: "prj_eval",
    requiredClaims: ["exp", "iat", "nbf"],
  });
  const next = await acquireHostedEvalOidc(scope, { getToken, verify });
  expect(next.token).toBe("second");
});

it("preserves verification rejection without leaking raw credentials", async () => {
  const verify = vi.fn().mockRejectedValue(new Error("expired private-token"));
  await expect(
    acquireHostedEvalOidc(scope, { getToken: () => Promise.resolve("private-token"), verify }),
  ).rejects.toThrow("could not be acquired or verified");
});

it("rejects missing or wildcard scope before credential acquisition", async () => {
  const getToken = vi.fn();
  await expect(acquireHostedEvalOidc({ ...scope, projectId: "*" }, { getToken })).rejects.toThrow(
    "explicit",
  );
  expect(getToken).not.toHaveBeenCalled();
});
