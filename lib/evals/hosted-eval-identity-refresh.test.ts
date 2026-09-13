import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { refreshWorkerIdentity } from "../../scripts/hosted-eval-identity-preload.mjs";
import { syncHostedEvalIdentity } from "./hosted-eval-identity-refresh";

it("refreshes only verified project identity and retains it after rejected replacements", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hosted-identity-"));
  const file = path.join(directory, "identity.json");
  const environment = {
    NODE_ENV: "test" as const,
    SELF_REPRODUCTION_WORKLOAD_IDENTITY_FILE: file,
    VERCEL_ENV: "production",
    VERCEL_OIDC_TOKEN: "previous",
    VERCEL_PROJECT_ID: "prj_eval",
    VERCEL_TEAM_ID: "team_eval",
  };
  const verify = vi
    .fn()
    .mockResolvedValueOnce({ token: "renewed" })
    .mockRejectedValueOnce(new Error("wrong project"));
  try {
    await writeFile(file, JSON.stringify({ token: "renewed" }));
    await refreshWorkerIdentity(environment, verify);
    expect(environment.VERCEL_OIDC_TOKEN).toBe("renewed");
    expect(verify).toHaveBeenCalledWith("renewed", {
      environment: "production",
      projectId: "prj_eval",
      teamId: "team_eval",
    });
    await writeFile(file, JSON.stringify({ projectId: "attacker", token: "untrusted" }));
    await expect(refreshWorkerIdentity(environment, verify)).rejects.toThrow("wrong project");
    expect(environment.VERCEL_OIDC_TOKEN).toBe("renewed");
    await writeFile(file, "{");
    await expect(refreshWorkerIdentity(environment, verify)).rejects.toThrow();
    expect(environment.VERCEL_OIDC_TOKEN).toBe("renewed");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

it("native evaluator verifies the private file using deployment-owned scope", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hosted-native-identity-"));
  const file = path.join(directory, "identity.json");
  const environment = {
    NODE_ENV: "test" as const,
    SELF_REPRODUCTION_WORKLOAD_IDENTITY_FILE: file,
    VERCEL_ENV: "production",
    VERCEL_OIDC_TOKEN: "stale",
    VERCEL_PROJECT_ID: "prj_eval",
    VERCEL_TEAM_ID: "team_eval",
  };
  const acquire = vi.fn(async (scope, dependencies) => ({
    ...scope,
    expiresAt: 100,
    token: await dependencies.getToken(),
  }));
  try {
    await writeFile(file, JSON.stringify({ token: "replacement" }));
    await syncHostedEvalIdentity(environment, acquire);
    expect(acquire.mock.calls[0]?.[0]).toEqual({
      environment: "production",
      projectId: "prj_eval",
      teamId: "team_eval",
    });
    expect(environment.VERCEL_OIDC_TOKEN).toBe("replacement");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
