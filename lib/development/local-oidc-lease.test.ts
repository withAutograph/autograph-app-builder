import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { publishLocalDevelopmentOidcLease } from "./local-oidc-lease";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});
const fixture = () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "builder-oidc-lease-")));
  roots.push(root);
  const repositoryRoot = path.join(root, "repository");
  const applicationRoot = path.join(root, "application");
  const runtimeHome = path.join(root, "home");
  for (const directory of [
    repositoryRoot,
    applicationRoot,
    runtimeHome,
    path.join(repositoryRoot, ".vercel"),
  ]) {
    mkdirSync(directory, { mode: 0o700, recursive: true });
  }
  const project = { projectId: "prj_owned", orgId: "team_owned", projectName: "builder" };
  writeFileSync(path.join(repositoryRoot, ".vercel/project.json"), JSON.stringify(project), {
    mode: 0o600,
  });
  const token = (expiresAt: number) =>
    [
      Buffer.from("{}").toString("base64url"),
      Buffer.from(
        JSON.stringify({
          iss: "https://oidc.vercel.com/owned",
          aud: "https://vercel.com/owned",
          owner: "owned",
          owner_id: project.orgId,
          project: project.projectName,
          project_id: project.projectId,
          environment: "development",
          sub: "owner:owned:project:builder:environment:development",
          iat: Math.floor(Date.now() / 1000) - 60,
          nbf: Math.floor(Date.now() / 1000) - 60,
          exp: expiresAt,
        }),
      ).toString("base64url"),
      "fixture",
    ].join(".");
  const install = (value: string) => {
    writeFileSync(path.join(repositoryRoot, ".env.local"), `VERCEL_OIDC_TOKEN=${value}\n`, {
      mode: 0o600,
    });
  };
  return { applicationRoot, install, project, repositoryRoot, root, runtimeHome, token };
};
it("the actual OIDC SDK recovers an expired process token from the renewed isolated project lease", () => {
  const f = fixture();
  const now = Math.floor(Date.now() / 1000);
  const current = f.token(now + 3600);
  f.install(current);
  expect(publishLocalDevelopmentOidcLease(f)).toEqual({ expiresAt: now + 3600 });
  const sdk = path.resolve("node_modules/@vercel/oidc/dist/index.js");
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      `require(${JSON.stringify(sdk)}).getVercelOidcToken().then(token => { if(token !== process.env.EXPECTED_FIXTURE_TOKEN)process.exitCode=2; else console.log('renewed'); }).catch(()=>process.exitCode=3)`,
    ],
    {
      cwd: f.applicationRoot,
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH,
        HOME: f.runtimeHome,
        XDG_DATA_HOME: path.join(f.runtimeHome, "data"),
        VERCEL_OIDC_TOKEN: f.token(now - 1),
        EXPECTED_FIXTURE_TOKEN: current,
      },
      encoding: "utf-8",
    },
  );
  expect(probe.status, probe.stderr).toBe(0);
  expect(probe.stdout.trim()).toBe("renewed");
  const file = path.join(f.runtimeHome, "data/com.vercel.token", `${f.project.projectId}.json`);
  // oxlint-disable-next-line eslint/no-bitwise -- Verify credentials remain owner-only.
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(file, "utf-8")).toBe(JSON.stringify({ token: current }));
});
it("refuses to change a retained cycle's selected project", () => {
  const f = fixture();
  f.install(f.token(Math.floor(Date.now() / 1000) + 3600));
  publishLocalDevelopmentOidcLease(f);
  writeFileSync(
    path.join(f.applicationRoot, ".vercel/project.json"),
    JSON.stringify({ ...f.project, projectId: "prj_foreign" }),
  );
  expect(() => publishLocalDevelopmentOidcLease(f)).toThrow("project changed");
});
it("does not follow an escaping credential cache directory", () => {
  const f = fixture();
  f.install(f.token(Math.floor(Date.now() / 1000) + 3600));
  const elsewhere = path.join(f.root, "other");
  mkdirSync(elsewhere, { mode: 0o700 });
  symlinkSync(elsewhere, path.join(f.runtimeHome, "data"));
  expect(() => publishLocalDevelopmentOidcLease(f)).toThrow("not private");
});

it("refuses a project identifier that escapes the credential cache", () => {
  const f = fixture();
  f.project.projectId = "../escape";
  writeFileSync(path.join(f.repositoryRoot, ".vercel/project.json"), JSON.stringify(f.project));
  f.install(f.token(Math.floor(Date.now() / 1000) + 3600));
  expect(() => publishLocalDevelopmentOidcLease(f)).toThrow("cache path escaped");
});
