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
import { join } from "node:path";

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
const project = {
  projectId: "prj_builder",
  orgId: "team_autographing",
  projectName: "autograph-app-builder",
};
const claims = {
  iss: "https://oidc.vercel.com/autographing",
  aud: "https://vercel.com/autographing",
  sub: "owner:autographing:project:autograph-app-builder:environment:development",
  iat: now - 60,
  nbf: now - 60,
  exp: now + 3600,
  owner: "autographing",
  owner_id: project.orgId,
  project: project.projectName,
  project_id: project.projectId,
  environment: "development",
  user_id: "user_local",
};

function token(payload: Record<string, unknown> = claims): string {
  return [
    Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString(
      "base64url",
    ),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

describe("local Vercel OIDC binding", () => {
  it("accepts only the linked Development project token", () => {
    const value = token();
    expect(
      validateLocalVercelOidcToken({
        token: value,
        project,
        nowEpochSeconds: now,
      }),
    ).toBe(value);
    expect(parseLinkedVercelProject(JSON.stringify(project))).toEqual(project);
    expect(parseLocalVercelOidcToken(`VERCEL_OIDC_TOKEN="${value}"\n`)).toBe(
      value,
    );
    const receipt = JSON.stringify(
      validateLocalVercelOidcClaims({
        token: value,
        project,
        nowEpochSeconds: now,
      }),
    );
    for (const sensitive of [
      value,
      claims.sub,
      claims.owner,
      claims.owner_id,
      claims.project,
      claims.project_id,
      claims.user_id,
    ]) {
      expect(receipt).not.toContain(sensitive);
    }
    expect(JSON.parse(receipt)).toMatchObject({
      audienceBound: true,
      subjectBound: true,
      ownerBound: true,
      projectBound: true,
      environment: "development",
    });
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
        token: token({ ...claims, ...override }),
        project,
        nowEpochSeconds: now,
      }),
    ).toThrow();
  });

  it("rejects malformed and ambiguous dotenv values", () => {
    expect(() =>
      parseLocalVercelOidcToken("VERCEL_OIDC_TOKEN=nope\n"),
    ).toThrow();
    expect(() =>
      parseLocalVercelOidcToken(
        `VERCEL_OIDC_TOKEN=${token()}\nVERCEL_OIDC_TOKEN=${token()}\n`,
      ),
    ).toThrow();
    expect(() =>
      validateLocalVercelOidcToken({
        token: "header.not-json.signature",
        project,
        nowEpochSeconds: now,
      }),
    ).toThrow("malformed");
  });

  it("rejects symlinked and permissive local credential inputs", () => {
    const root = mkdtempSync(join(tmpdir(), "local-oidc-input-"));
    const secret = join(root, "secret");
    const linked = join(root, "linked");
    writeFileSync(secret, "value", { mode: 0o600 });
    expect(readOwnerBoundLocalFile(secret, { confidential: true })).toBe(
      "value",
    );
    chmodSync(secret, 0o644);
    expect(() =>
      readOwnerBoundLocalFile(secret, { confidential: true }),
    ).toThrow("owner-bound");
    symlinkSync(secret, linked);
    expect(() =>
      readOwnerBoundLocalFile(linked, { confidential: true }),
    ).toThrow("owner-bound");
    chmodSync(secret, 0o666);
    expect(() =>
      readOwnerBoundLocalFile(secret, { confidential: false }),
    ).toThrow("owner-bound");
  });
});

function installedEveFixture(
  input: {
    name?: string;
    version?: string;
    bin?: string;
  } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "installed-eve-"));
  const packageRoot = join(
    root,
    "node_modules/.pnpm/eve@0.43.0_peer/node_modules/eve",
  );
  mkdirSync(join(packageRoot, "bin"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ dependencies: { eve: "0.43.0" } }),
  );
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: input.name ?? "eve",
      version: input.version ?? "0.43.0",
      bin: { eve: input.bin ?? "./bin/eve.js" },
    }),
  );
  writeFileSync(join(packageRoot, "bin/eve.js"), "#!/usr/bin/env node\n", {
    mode: 0o755,
  });
  symlinkSync(
    ".pnpm/eve@0.43.0_peer/node_modules/eve",
    join(root, "node_modules/eve"),
  );
  return realpathSync(root);
}

describe("installed Eve command identity", () => {
  it("accepts the real relative pnpm layout and exact 0.43.0 bin contract", () => {
    const root = installedEveFixture();
    expect(resolveInstalledEveCli(root)).toBe(
      join(
        root,
        "node_modules/.pnpm/eve@0.43.0_peer/node_modules/eve/bin/eve.js",
      ),
    );
  });

  it.each([
    ["package", { name: "not-eve" }],
    ["version", { version: "0.44.0" }],
    ["bin", { bin: "bin/other.js" }],
  ])("rejects the wrong %s metadata", (_name, override) => {
    expect(() => resolveInstalledEveCli(installedEveFixture(override))).toThrow(
      "identity",
    );
  });

  it("rejects external, parent-traversing, and chained package links", () => {
    for (const target of ["/tmp/external-eve", "../external-eve"]) {
      const root = realpathSync(
        mkdtempSync(join(tmpdir(), "installed-eve-link-")),
      );
      mkdirSync(join(root, "node_modules/.pnpm"), { recursive: true });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ dependencies: { eve: "0.43.0" } }),
      );
      symlinkSync(target, join(root, "node_modules/eve"));
      expect(() => resolveInstalledEveCli(root)).toThrow();
    }

    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "installed-eve-chain-")),
    );
    const external = realpathSync(
      mkdtempSync(join(tmpdir(), "installed-eve-external-")),
    );
    mkdirSync(join(root, "node_modules"));
    symlinkSync(external, join(root, "node_modules/.pnpm"));
    symlinkSync(
      ".pnpm/eve@0.43.0_peer/node_modules/eve",
      join(root, "node_modules/eve"),
    );
    expect(() => resolveInstalledEveCli(root)).toThrow("pnpm layout");
  });

  it("rejects a wrong pnpm version and a permissive package parent", () => {
    const wrongVersion = installedEveFixture();
    const link = join(wrongVersion, "node_modules/eve");
    const wrongTarget = ".pnpm/eve@0.43.1_peer/node_modules/eve";
    const wrongRoot = join(wrongVersion, "node_modules", wrongTarget);
    mkdirSync(join(wrongRoot, "bin"), { recursive: true });
    writeFileSync(join(wrongRoot, "package.json"), "{}");
    writeFileSync(join(wrongRoot, "bin/eve.js"), "", { mode: 0o755 });
    unlinkSync(link);
    symlinkSync(wrongTarget, link);
    expect(() => resolveInstalledEveCli(wrongVersion)).toThrow("link");

    const permissive = installedEveFixture();
    chmodSync(join(permissive, "node_modules/.pnpm"), 0o777);
    expect(() => resolveInstalledEveCli(permissive)).toThrow("owner-bound");
  });
});
