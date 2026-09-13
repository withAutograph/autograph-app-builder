import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseLinkedVercelProject,
  parseLocalVercelOidcToken,
  readOwnerBoundLocalFile,
  resolveInstalledEveCli,
  validateLocalVercelOidcClaims,
  validateLocalVercelOidcToken,
} from "./local-vercel-oidc";

const now = 2_000_000_000;
const realPnpmStoreEntry =
  "eve@0.44.4_@vercel+functions@3.9.5_ws@8.21.3__ai@7.0.79_zod@4.4.3__dotenv@17.4.2_drizzl_1358a224edaa8ba31fee79f308c3b7e1";
const project = {
  orgId: "team_autographing",
  projectId: "prj_builder",
  projectName: "autograph-app-builder",
};
const claims = {
  aud: "https://vercel.com/autographing",
  environment: "development",
  exp: now + 3600,
  iat: now - 60,
  iss: "https://oidc.vercel.com/autographing",
  nbf: now - 60,
  owner: "autographing",
  owner_id: project.orgId,
  project: project.projectName,
  project_id: project.projectId,
  sub: "owner:autographing:project:autograph-app-builder:environment:development",
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function token(payload: Record<string, unknown> = claims): string {
  return [
    Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

describe("local Vercel OIDC binding", () => {
  it("accepts only the linked Development project token", () => {
    const value = token();
    expect(
      validateLocalVercelOidcToken({
        nowEpochSeconds: now,
        project,
        token: value,
      }),
    ).toBe(value);
    expect(parseLinkedVercelProject(JSON.stringify(project))).toEqual(project);
    expect(parseLocalVercelOidcToken(`VERCEL_OIDC_TOKEN="${value}"\n`)).toBe(value);
    const receipt = JSON.stringify(
      validateLocalVercelOidcClaims({
        nowEpochSeconds: now,
        project,
        token: value,
      }),
    );
    for (const sensitive of [
      value,
      claims.sub,
      claims.owner,
      claims.owner_id,
      claims.project,
      claims.project_id,
    ]) {
      expect(receipt).not.toContain(sensitive);
    }
    expect(JSON.parse(receipt)).toMatchObject({
      audienceBound: true,
      environment: "development",
      ownerBound: true,
      projectBound: true,
      subjectBound: true,
    });
  });

  it("does not require an unrelated user identity claim", () => {
    expect(
      validateLocalVercelOidcClaims({
        nowEpochSeconds: now,
        project,
        token: token(),
      }),
    ).toMatchObject({ environment: "development", projectBound: true });
  });

  it.each([
    ["team", { owner_id: "team_other" }],
    ["project", { project_id: "prj_other" }],
    ["environment", { environment: "production" }],
    ["audience", { aud: "https://vercel.com/other" }],
    ["issuer", { iss: "https://issuer.example.test" }],
    ["expired", { exp: now }],
    ["future", { nbf: now + 1 }],
    ["unbounded", { exp: now + 43_201 }],
  ])("rejects a %s mismatch", (_name, override) => {
    expect(() =>
      validateLocalVercelOidcToken({
        nowEpochSeconds: now,
        project,
        token: token({ ...claims, ...override }),
      }),
    ).toThrow();
  });

  it("rejects malformed and ambiguous dotenv values", () => {
    expect(() => parseLocalVercelOidcToken("VERCEL_OIDC_TOKEN=nope\n")).toThrow();
    expect(() =>
      parseLocalVercelOidcToken(`VERCEL_OIDC_TOKEN=${token()}\nVERCEL_OIDC_TOKEN=${token()}\n`),
    ).toThrow();
    expect(() =>
      validateLocalVercelOidcToken({
        nowEpochSeconds: now,
        project,
        token: "header.not-json.signature",
      }),
    ).toThrow("malformed");
  });

  it("rejects symlinked and permissive local credential inputs", () => {
    const root = mkdtempSync(path.join(tmpdir(), "local-oidc-input-"));
    const secret = path.join(root, "secret");
    const linked = path.join(root, "linked");
    writeFileSync(secret, "value", { mode: 0o600 });
    expect(readOwnerBoundLocalFile(secret, { confidential: true })).toBe("value");
    chmodSync(secret, 0o644);
    expect(() => readOwnerBoundLocalFile(secret, { confidential: true })).toThrow("owner-bound");
    symlinkSync(secret, linked);
    expect(() => readOwnerBoundLocalFile(linked, { confidential: true })).toThrow("owner-bound");
    chmodSync(secret, 0o666);
    expect(() => readOwnerBoundLocalFile(secret, { confidential: false })).toThrow("owner-bound");
  });
});

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function installedEveFixture(
  input: {
    name?: string;
    version?: string;
    bin?: string;
  } = {},
): string {
  const root = mkdtempSync(path.join(tmpdir(), "installed-eve-"));
  const packageRoot = path.join(root, `node_modules/.pnpm/${realPnpmStoreEntry}/node_modules/eve`);
  mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ dependencies: { eve: "0.44.4" } }),
  );
  writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      bin: { eve: input.bin ?? "./bin/eve.js" },
      name: input.name ?? "eve",
      version: input.version ?? "0.44.4",
    }),
  );
  writeFileSync(path.join(packageRoot, "bin/eve.js"), "#!/usr/bin/env node\n", {
    mode: 0o755,
  });
  symlinkSync(`.pnpm/${realPnpmStoreEntry}/node_modules/eve`, path.join(root, "node_modules/eve"));
  return realpathSync(root);
}

describe("installed Eve command identity", () => {
  it("accepts the real relative pnpm layout and exact 0.44.4 bin contract", () => {
    const root = installedEveFixture();
    expect(resolveInstalledEveCli(root)).toBe(
      path.join(root, `node_modules/.pnpm/${realPnpmStoreEntry}/node_modules/eve/bin/eve.js`),
    );
  });

  it.each([
    ["package", { name: "not-eve" }],
    ["version", { version: "0.44.0" }],
    ["bin", { bin: "bin/other.js" }],
  ])("rejects the wrong %s metadata", (_name, override) => {
    expect(() => resolveInstalledEveCli(installedEveFixture(override))).toThrow("identity");
  });

  it.each([
    ["absolute link", "/tmp/external-eve"],
    ["parent traversal", "../external-eve"],
  ])("rejects an %s", (_name, target) => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "installed-eve-link-")));
    mkdirSync(path.join(root, "node_modules/.pnpm"), { recursive: true });
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { eve: "0.44.4" } }),
    );
    symlinkSync(target, path.join(root, "node_modules/eve"));
    expect(() => resolveInstalledEveCli(root)).toThrow("link");
  });

  it("rejects a valid-looking pnpm link whose store entry resolves outside", () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "installed-eve-outside-")));
    const outsideStore = realpathSync(
      mkdtempSync(path.join(tmpdir(), "installed-eve-outside-store-")),
    );
    const storeEntry = "eve@0.44.4_peer";
    mkdirSync(path.join(root, "node_modules/.pnpm"), { recursive: true });
    mkdirSync(path.join(outsideStore, "node_modules/eve"), { recursive: true });
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { eve: "0.44.4" } }),
    );
    symlinkSync(outsideStore, path.join(root, "node_modules/.pnpm", storeEntry));
    symlinkSync(`.pnpm/${storeEntry}/node_modules/eve`, path.join(root, "node_modules/eve"));
    expect(() => resolveInstalledEveCli(root)).toThrow("outside");
  });

  it("rejects a chained pnpm store root", () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "installed-eve-chain-")));
    const external = realpathSync(mkdtempSync(path.join(tmpdir(), "installed-eve-external-")));
    mkdirSync(path.join(root, "node_modules"));
    symlinkSync(external, path.join(root, "node_modules/.pnpm"));
    symlinkSync(".pnpm/eve@0.44.4_peer/node_modules/eve", path.join(root, "node_modules/eve"));
    expect(() => resolveInstalledEveCli(root)).toThrow("owner-bound");
  });

  it("rejects a wrong 0.44.x pnpm version", () => {
    const wrongVersion = installedEveFixture();
    const link = path.join(wrongVersion, "node_modules/eve");
    const wrongTarget = ".pnpm/eve@0.44.3_peer/node_modules/eve";
    const wrongRoot = path.join(wrongVersion, "node_modules", wrongTarget);
    mkdirSync(path.join(wrongRoot, "bin"), { recursive: true });
    writeFileSync(path.join(wrongRoot, "package.json"), "{}");
    writeFileSync(path.join(wrongRoot, "bin/eve.js"), "", { mode: 0o755 });
    unlinkSync(link);
    symlinkSync(wrongTarget, link);
    expect(() => resolveInstalledEveCli(wrongVersion)).toThrow("link");
  });

  it.each([
    ["node_modules root", "node_modules"],
    ["pnpm root", "node_modules/.pnpm"],
    ["package store", `node_modules/.pnpm/${realPnpmStoreEntry}`],
    ["package node_modules", `node_modules/.pnpm/${realPnpmStoreEntry}/node_modules`],
    ["package", `node_modules/.pnpm/${realPnpmStoreEntry}/node_modules/eve`],
  ])("rejects a permissive %s directory", (_name, relativePath) => {
    const permissive = installedEveFixture();
    chmodSync(path.join(permissive, relativePath), 0o777);
    expect(() => resolveInstalledEveCli(permissive)).toThrow("owner-bound");
  });
});
