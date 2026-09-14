import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEveEvalOidc } from "./eve-eval-oidc";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});
const fixture = (projectId = "prj_eval") => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "eval-oidc-")));
  roots.push(root);
  mkdirSync(path.join(root, ".vercel"));
  writeFileSync(
    path.join(root, ".vercel/project.json"),
    JSON.stringify({ orgId: "team_eval", projectId: "prj_eval", projectName: "builder" }),
  );
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    aud: "https://vercel.com/eval",
    environment: "development",
    exp: now + 3600,
    iat: now - 10,
    iss: "https://oidc.vercel.com/eval",
    nbf: now - 10,
    owner: "eval",
    owner_id: "team_eval",
    project: "builder",
    project_id: projectId,
    sub: "owner:eval:project:builder:environment:development",
  };
  const token = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
  writeFileSync(path.join(root, ".env.local"), `VERCEL_OIDC_TOKEN=${token}\n`, { mode: 0o600 });
  return { root, token };
};
describe("Eve eval managed OIDC", () => {
  it("does not read credentials or invoke setup for deterministic execution", () => {
    const ensure = vi.fn<(root: string) => void>();
    const environment = {
      NODE_ENV: "test" as const,
      VERCEL_OIDC_TOKEN: "ambient-token",
      VERCEL_PROJECT_ID: "ambient-project",
      VERCEL_TEAM_ID: "ambient-team",
    };
    loadEveEvalOidc({ ensure, environment, realSandbox: false, repositoryRoot: "/absent" });
    expect(ensure).not.toHaveBeenCalled();
    expect(environment).toEqual({ NODE_ENV: "test" });
  });
  it.each(["sandbox", "hosted-artifact"])(
    "loads scoped credentials for %s without requiring live model mode",
    () => {
      const { root, token } = fixture();
      const ensure = vi.fn<(root: string) => void>();
      const environment: NodeJS.ProcessEnv = { NODE_ENV: "test" };
      loadEveEvalOidc({ ensure, environment, realSandbox: true, repositoryRoot: root });
      expect(ensure).toHaveBeenCalledWith(root);
      expect(environment).toMatchObject({
        VERCEL_OIDC_TOKEN: token,
        VERCEL_PROJECT_ID: "prj_eval",
        VERCEL_TEAM_ID: "team_eval",
      });
    },
  );
  it("loads current managed OIDC despite the trusted launcher's restricted PATH", () => {
    const { root, token } = fixture();
    const environment: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: "/usr/bin:/bin" };
    loadEveEvalOidc({
      environment,
      miseExecutable: "/managed/mise",
      realSandbox: true,
      repositoryRoot: root,
      vercelExecutable: "/managed/vercel",
    });
    expect(environment.VERCEL_OIDC_TOKEN).toBe(token);
  });
  it("rejects a different project and provides an actionable setup error", () => {
    const { root } = fixture("prj_other");
    const environment = { NODE_ENV: "test" as const };
    expect(() => {
      loadEveEvalOidc({
        ensure: vi.fn<(root: string) => void>(),
        environment,
        realSandbox: true,
        repositoryRoot: root,
      });
    }).toThrow("mise run local:ensure-oidc");
    expect(environment).toEqual({ NODE_ENV: "test" });
  });
});
