import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ensureLocalDevelopmentOidc,
  LocalOidcRefreshFailedError,
  runLocalOidcStartupCommand,
} from "./local-oidc-startup";
import type { LocalOidcStartupInvocation } from "./local-oidc-startup";

const NOW = 2_000_000_000;
const PROJECT = {
  orgId: "team_autograph",
  projectId: "prj_app_builder",
  projectName: "autograph-app-builder",
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function token(expiresAt = NOW + 3600): string {
  const claims = {
    aud: "https://vercel.com/autographing",
    environment: "development",
    exp: expiresAt,
    iat: NOW - 10,
    iss: "https://oidc.vercel.com/autographing",
    nbf: NOW - 10,
    owner: "autographing",
    owner_id: PROJECT.orgId,
    project: PROJECT.projectName,
    project_id: PROJECT.projectId,
    sub: "owner:autographing:project:autograph-app-builder:environment:development",
  };
  return [
    Buffer.from("{}", "utf-8").toString("base64url"),
    Buffer.from(JSON.stringify(claims), "utf-8").toString("base64url"),
    "signature",
  ].join(".");
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function fixture(input: { expiresAt?: number; environmentMode?: number } = {}) {
  const repositoryRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "local-oidc-startup-")));
  mkdirSync(path.join(repositoryRoot, ".vercel"), { mode: 0o700 });
  writeFileSync(path.join(repositoryRoot, ".vercel/project.json"), `${JSON.stringify(PROJECT)}\n`, {
    mode: 0o600,
  });
  writeFileSync(
    path.join(repositoryRoot, ".env.local"),
    `VERCEL_OIDC_TOKEN=${token(input.expiresAt)}\n`,
    { mode: input.environmentMode ?? 0o600 },
  );
  chmodSync(path.join(repositoryRoot, ".env.local"), input.environmentMode ?? 0o600);
  return repositoryRoot;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function baseInput(repositoryRoot: string) {
  return {
    environment: {
      HOME: "/owner/home",
      NODE_ENV: "test" as const,
      PATH: "/mise/node:/usr/bin:/bin",
      VERCEL_OIDC_TOKEN: "must-not-be-forwarded",
    },
    miseExecutable: "/mise/mise",
    nowEpochSeconds: NOW,
    repositoryRoot,
    vercelExecutable: "/mise/vercel",
  };
}

describe("local Development OIDC startup", () => {
  it("exits without a command when the installed token is current", () => {
    const repositoryRoot = fixture();
    const invocations: LocalOidcStartupInvocation[] = [];

    expect(
      ensureLocalDevelopmentOidc({
        ...baseInput(repositoryRoot),
        runCommand: (invocation) => invocations.push(invocation),
      }),
    ).toEqual({ refreshed: false });
    expect(invocations).toEqual([]);
  });

  it("pulls Development once, owner-binds through mise, and revalidates", () => {
    const repositoryRoot = fixture({ expiresAt: NOW + 60 });
    const invocations: LocalOidcStartupInvocation[] = [];

    const result = ensureLocalDevelopmentOidc({
      ...baseInput(repositoryRoot),
      runCommand: (invocation) => {
        invocations.push(invocation);
        expect(invocation.environment).not.toHaveProperty("VERCEL_OIDC_TOKEN");
        expect(invocation.environment).not.toHaveProperty("VERCEL_TOKEN");
        expect(invocation.environment).not.toHaveProperty("AI_GATEWAY_API_KEY");
        if (invocation.operation === "development-env-pull") {
          writeFileSync(path.join(repositoryRoot, ".env.local"), `VERCEL_OIDC_TOKEN=${token()}\n`, {
            mode: 0o644,
          });
          chmodSync(path.join(repositoryRoot, ".env.local"), 0o644);
        } else {
          chmodSync(path.join(repositoryRoot, ".env.local"), 0o600);
        }
      },
    });

    expect(result).toEqual({ refreshed: true });
    expect(invocations).toMatchObject([
      {
        args: ["env", "pull", ".env.local", "--environment=development", "--yes"],
        executable: "/mise/vercel",
        operation: "development-env-pull",
      },
      {
        args: ["run", "local:install-oidc"],
        environment: { MISE_BIN_PATH: "/mise/mise" },
        executable: "/mise/mise",
        operation: "owner-bind",
      },
    ]);
  });

  it("does not refresh malformed or unsafe installed OIDC", () => {
    const repositoryRoot = fixture();
    writeFileSync(path.join(repositoryRoot, ".env.local"), "VERCEL_OIDC_TOKEN=not-a-jwt\n", {
      mode: 0o600,
    });
    // Keep this command fixture scoped to the test setup.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const runCommand = () => {
      throw new Error("command must not run");
    };

    expect(() =>
      ensureLocalDevelopmentOidc({
        ...baseInput(repositoryRoot),
        runCommand,
      }),
    ).toThrow("VERCEL_OIDC_TOKEN was not a bounded JWT");
  });

  it("reports one safe error when a required refresh cannot run", () => {
    const repositoryRoot = fixture({ expiresAt: NOW + 60 });

    expect(() =>
      ensureLocalDevelopmentOidc({
        ...baseInput(repositoryRoot),
        runCommand: () => {
          throw new Error("network access denied");
        },
      }),
    ).toThrow(LocalOidcRefreshFailedError);
  });

  it.each(["VERCEL_TOKEN", "AI_GATEWAY_API_KEY"] as const)(
    "rejects ambient %s before running a command",
    (name) => {
      const repositoryRoot = fixture({ expiresAt: NOW + 60 });
      // Keep this command fixture scoped to the test setup.
      // oxlint-disable-next-line unicorn/consistent-function-scoping
      const runCommand = () => {
        throw new Error("command must not run");
      };
      expect(() =>
        ensureLocalDevelopmentOidc({
          ...baseInput(repositoryRoot),
          environment: {
            ...baseInput(repositoryRoot).environment,
            [name]: "static-secret",
          },
          runCommand,
        }),
      ).toThrow("refuses static provider credentials");
    },
  );

  it("does not include child output in a command failure", () => {
    const leaked = "secret-token-and-claims";
    expect(() =>
      runLocalOidcStartupCommand({
        args: ["-c", `printf '%s' '${leaked}' >&2; exit 1`],
        cwd: "/tmp",
        environment: {
          HOME: "/tmp",
          NODE_ENV: "test",
          PATH: "/usr/bin:/bin",
        },
        executable: "/bin/sh",
        operation: "development-env-pull",
      }),
    ).toThrow("Local OIDC development-env-pull failed.");
    try {
      runLocalOidcStartupCommand({
        args: ["-c", `printf '%s' '${leaked}' >&2; exit 1`],
        cwd: "/tmp",
        environment: {
          HOME: "/tmp",
          NODE_ENV: "test",
          PATH: "/usr/bin:/bin",
        },
        executable: "/bin/sh",
        operation: "development-env-pull",
      });
    } catch (error) {
      expect(String(error)).not.toContain(leaked);
    }
  });
});
