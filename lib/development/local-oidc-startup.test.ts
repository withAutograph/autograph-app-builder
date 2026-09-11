import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ensureLocalDevelopmentOidc,
  LocalOidcRefreshFailedError,
  runLocalOidcStartupCommand,
  type LocalOidcStartupInvocation,
} from "./local-oidc-startup";

const NOW = 2_000_000_000;
const PROJECT = {
  projectId: "prj_app_builder",
  orgId: "team_autograph",
  projectName: "autograph-app-builder",
};

function token(expiresAt = NOW + 3600): string {
  const claims = {
    iss: "https://oidc.vercel.com/autographing",
    aud: "https://vercel.com/autographing",
    sub: "owner:autographing:project:autograph-app-builder:environment:development",
    iat: NOW - 10,
    nbf: NOW - 10,
    exp: expiresAt,
    owner: "autographing",
    owner_id: PROJECT.orgId,
    project: PROJECT.projectName,
    project_id: PROJECT.projectId,
    environment: "development",
  };
  return [
    Buffer.from("{}", "utf8").toString("base64url"),
    Buffer.from(JSON.stringify(claims), "utf8").toString("base64url"),
    "signature",
  ].join(".");
}

function fixture(input: { expiresAt?: number; environmentMode?: number } = {}) {
  const repositoryRoot = realpathSync(
    mkdtempSync(join(tmpdir(), "local-oidc-startup-")),
  );
  mkdirSync(join(repositoryRoot, ".vercel"), { mode: 0o700 });
  writeFileSync(
    join(repositoryRoot, ".vercel/project.json"),
    `${JSON.stringify(PROJECT)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(repositoryRoot, ".env.local"),
    `VERCEL_OIDC_TOKEN=${token(input.expiresAt)}\n`,
    { mode: input.environmentMode ?? 0o600 },
  );
  chmodSync(join(repositoryRoot, ".env.local"), input.environmentMode ?? 0o600);
  return repositoryRoot;
}

function baseInput(repositoryRoot: string) {
  return {
    repositoryRoot,
    vercelExecutable: "/mise/vercel",
    miseExecutable: "/mise/mise",
    environment: {
      NODE_ENV: "test" as const,
      HOME: "/owner/home",
      PATH: "/mise/node:/usr/bin:/bin",
      VERCEL_OIDC_TOKEN: "must-not-be-forwarded",
    },
    nowEpochSeconds: NOW,
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
          writeFileSync(
            join(repositoryRoot, ".env.local"),
            `VERCEL_OIDC_TOKEN=${token()}\n`,
            { mode: 0o644 },
          );
          chmodSync(join(repositoryRoot, ".env.local"), 0o644);
        } else {
          chmodSync(join(repositoryRoot, ".env.local"), 0o600);
        }
      },
    });

    expect(result).toEqual({ refreshed: true });
    expect(invocations).toMatchObject([
      {
        executable: "/mise/vercel",
        args: [
          "env",
          "pull",
          ".env.local",
          "--environment=development",
          "--yes",
        ],
        operation: "development-env-pull",
      },
      {
        executable: "/mise/mise",
        args: ["run", "local:install-oidc"],
        operation: "owner-bind",
      },
    ]);
  });

  it("does not refresh malformed or unsafe installed OIDC", () => {
    const repositoryRoot = fixture();
    writeFileSync(
      join(repositoryRoot, ".env.local"),
      "VERCEL_OIDC_TOKEN=not-a-jwt\n",
      { mode: 0o600 },
    );
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
        executable: "/bin/sh",
        args: ["-c", `printf '%s' '${leaked}' >&2; exit 1`],
        cwd: "/tmp",
        environment: {
          NODE_ENV: "test",
          PATH: "/usr/bin:/bin",
          HOME: "/tmp",
        },
        operation: "development-env-pull",
      }),
    ).toThrow("Local OIDC development-env-pull failed.");
    try {
      runLocalOidcStartupCommand({
        executable: "/bin/sh",
        args: ["-c", `printf '%s' '${leaked}' >&2; exit 1`],
        cwd: "/tmp",
        environment: {
          NODE_ENV: "test",
          PATH: "/usr/bin:/bin",
          HOME: "/tmp",
        },
        operation: "development-env-pull",
      });
    } catch (error) {
      expect(String(error)).not.toContain(leaked);
    }
  });
});
