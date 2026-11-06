import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  symlinkSync,
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
  "eve@0.68.0_@vercel+functions@3.9.5_ws@8.21.3__ai@7.0.79_zod@4.4.3__dotenv@17.4.2_drizzl_1358a224edaa8ba31fee79f308c3b7e1";
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

interface InstalledEveFixture {
  cli: string;
  packageRoot: string;
  root: string;
}

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
    expect(() =>
      readOwnerBoundLocalFile(secret, {
        confidential: true,
        ownerId: (process.getuid?.() ?? 0) + 1,
      }),
    ).toThrow("owner-bound");
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
    layout?: "pnpm" | "bun" | "npm";
    outsideCache?: boolean;
    name?: string;
    bin?: string;
  } = {},
): InstalledEveFixture {
  const root = mkdtempSync(path.join(tmpdir(), "installed-eve-"));
  const nodeModules = path.join(root, "node_modules");
  mkdirSync(nodeModules);
  let packageRoot: string;
  let linkTarget: string | undefined;
  if (input.outsideCache === true) {
    const cache = mkdtempSync(path.join(tmpdir(), "eve-cache-"));
    packageRoot = path.join(cache, "eve@0.68.0/node_modules/eve");
    linkTarget = packageRoot;
  } else {
    switch (input.layout ?? "pnpm") {
      case "pnpm": {
        packageRoot = path.join(nodeModules, `.pnpm/${realPnpmStoreEntry}/node_modules/eve`);
        linkTarget = `.pnpm/${realPnpmStoreEntry}/node_modules/eve`;
        break;
      }
      case "bun": {
        packageRoot = path.join(nodeModules, ".bun/eve@0.68.0/node_modules/eve");
        linkTarget = ".bun/eve@0.68.0/node_modules/eve";
        break;
      }
      case "npm": {
        packageRoot = path.join(nodeModules, "eve");
        break;
      }
      default: {
        throw new Error("Unsupported Eve fixture layout.");
      }
    }
  }
  mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ dependencies: { eve: "0.68.0" } }),
  );
  writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      bin: { eve: input.bin ?? "./bin/eve.js" },
      name: input.name ?? "eve",
      version: "0.68.0",
    }),
  );
  writeFileSync(path.join(packageRoot, "bin/eve.js"), "#!/usr/bin/env node\n", {
    mode: 0o755,
  });
  if (linkTarget !== undefined) {
    symlinkSync(linkTarget, path.join(nodeModules, "eve"));
  }
  return {
    cli: path.join(packageRoot, "bin/eve.js"),
    packageRoot,
    root: realpathSync(root),
  };
}

describe("installed Eve command identity", () => {
  it.each(["pnpm", "bun", "npm"] as const)(
    "resolves the installed bin from the %s package layout",
    (layout) => {
      const fixture = installedEveFixture({ layout });
      expect(resolveInstalledEveCli(fixture.root)).toBe(realpathSync(fixture.cli));
    },
  );

  it.each([
    ["package", { name: "not-eve" }],
    ["bin", { bin: "bin/other.js" }],
    ["escaping bin", { bin: "../other/eve.js" }],
  ])("rejects the wrong %s metadata", (_name, override) => {
    expect(() => resolveInstalledEveCli(installedEveFixture(override).root)).toThrow();
  });

  it.each([
    ["absolute link", "/tmp/external-eve"],
    ["parent traversal", "../external-eve"],
  ])("rejects an %s", (_name, target) => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "installed-eve-link-")));
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { eve: "0.68.0" } }),
    );
    symlinkSync(target, path.join(root, "node_modules/eve"));
    expect(() => resolveInstalledEveCli(root)).toThrow();
  });

  it("resolves an owned external node_modules cache without changing the declared package or bin", () => {
    const fixture = installedEveFixture();
    const cache = mkdtempSync(path.join(tmpdir(), "eve-node-modules-cache-"));
    const cachedModules = path.join(cache, "node_modules");
    const nodeModulesLink = path.join(fixture.root, "node_modules");
    renameSync(nodeModulesLink, cachedModules);
    symlinkSync(cachedModules, nodeModulesLink);
    expect(resolveInstalledEveCli(fixture.root)).toBe(
      realpathSync(
        path.join(cachedModules, `.pnpm/${realPnpmStoreEntry}/node_modules/eve/bin/eve.js`),
      ),
    );
    chmodSync(cache, 0o777);
    expect(() => resolveInstalledEveCli(fixture.root)).toThrow("owner-bound");
  });
  it("rejects an external cache target owned by another account", () => {
    const fixture = installedEveFixture();
    const cache = mkdtempSync(path.join(tmpdir(), "eve-foreign-cache-"));
    const nodeModulesLink = path.join(fixture.root, "node_modules");
    renameSync(nodeModulesLink, path.join(cache, "node_modules"));
    const foreignDirectory = path.parse(fixture.root).root;
    expect(lstatSync(foreignDirectory).uid).not.toBe(process.getuid?.());
    symlinkSync(foreignDirectory, nodeModulesLink);
    expect(() => resolveInstalledEveCli(fixture.root)).toThrow("owner-bound");
  });
  it("accepts a package-manager cache outside the repository when owner-bound", () => {
    const fixture = installedEveFixture({ outsideCache: true });
    expect(resolveInstalledEveCli(fixture.root)).toBe(realpathSync(fixture.cli));
  });

  it("rejects a package cache another user could modify", () => {
    const fixture = installedEveFixture({ outsideCache: true });
    chmodSync(path.resolve(fixture.packageRoot, "../../.."), 0o777);
    expect(() => resolveInstalledEveCli(fixture.root)).toThrow("owner-bound");
  });

  it.each([
    ["node_modules root", "node_modules"],
    ["pnpm root", "node_modules/.pnpm"],
    ["package store", `node_modules/.pnpm/${realPnpmStoreEntry}`],
    ["package node_modules", `node_modules/.pnpm/${realPnpmStoreEntry}/node_modules`],
    ["package", `node_modules/.pnpm/${realPnpmStoreEntry}/node_modules/eve`],
  ])("rejects a permissive %s directory", (_name, relativePath) => {
    const permissive = installedEveFixture();
    chmodSync(path.join(permissive.root, relativePath), 0o777);
    expect(() => resolveInstalledEveCli(permissive.root)).toThrow("owner-bound");
  });
});
