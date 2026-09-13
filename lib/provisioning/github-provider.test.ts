import { createHash, generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { provisionGitHubRepository, starterSourceBinding } from "./github-provider";
import type { GitHubUserCredentialStore } from "./github-user-credential";
import type { StarterSource } from "./starter-source";
import { ARRUSTED_TARGET_SHA, ARRUSTED_TARGET_TREE } from "../repository/dependency-cache";

const authority = {
  audience: "https://builder.example.test/mcp",
  issuer: "https://builder.example.test/api/auth",
  ownerUserId: "user-1",
  workspaceId: "workspace-1",
};
const requestId = "123e4567-e89b-42d3-a456-426614174000";
const content = new TextEncoder().encode("# Starter\n");
const blobSha = createHash("sha1")
  .update(`blob ${content.byteLength}\0`)
  .update(content)
  .digest("hex");
const source: StarterSource = {
  files: [{ bytes: content, mode: "100644", path: "README.md" }],
  manifest: {
    archive: {
      bytes: 100,
      sha256: "e".repeat(64),
      url: `https://releases.example.test/${"e".repeat(64)}.tar.gz`,
    },
    files: [
      {
        bytes: content.byteLength,
        mode: "100644",
        path: "README.md",
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    ],
    source: {
      repository: "https://github.com/withAutograph/arrusted-development",
      sha: ARRUSTED_TARGET_SHA,
      tree: ARRUSTED_TARGET_TREE,
    },
    version: 1,
  },
  manifestSha256: "d".repeat(64),
};

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config = {
  appId: "123",
  clientId: "client-id",
  clientSecret: "client-secret-value-long-enough",
  privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function credentialStore(): GitHubUserCredentialStore {
  return {
    bind: vi.fn(),
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    deactivate: vi.fn(async () => 1),
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    read: vi.fn(async () => ({
      active: true,
      providerLogin: "octocat",
      providerUserId: "77",
      revision: 1,
      tokens: { accessToken: "github-user-access-token" },
      updatedAt: new Date(),
    })),
    rotate: vi.fn(),
  };
}

describe("GitHub starter repository provisioning", () => {
  it("binds cloned starter creation to complete V4 source provenance", () => {
    const canonical: StarterSource = {
      files: source.files,
      provenance: {
        contractDigest: "4".repeat(64),
        eligibilityDigest: "3".repeat(64),
        method: "git-clone-v1",
        readinessDigest: "1".repeat(64),
        receiptVersion: 4,
        ref: "refs/heads/main",
        repository: "https://github.com/withAutograph/arrusted-development.git",
        sourceReceiptDigest: "2".repeat(64),
        sourceSha: ARRUSTED_TARGET_SHA,
        sourceTree: ARRUSTED_TARGET_TREE,
      },
    };
    expect(starterSourceBinding(canonical)).toMatchObject({
      starter: {
        method: "git-clone-v1",
        readinessDigest: "1".repeat(64),
        receiptVersion: 4,
        sourceReceiptDigest: "2".repeat(64),
      },
    });
    expect(() =>
      starterSourceBinding({
        ...canonical,
        provenance: {
          ...canonical.provenance,
          sourceReceiptDigest: undefined,
        } as unknown as NonNullable<StarterSource["provenance"]>,
      }),
    ).toThrow("provenance-missing");
  });

  it.each([
    ["Organization", true, "/orgs/withAutograph/repos"],
    ["User", false, "/user/repos"],
  ] as const)(
    "creates a %s repository with one exact parentless main commit",
    async (accountType, isPrivate, createPath) => {
      const owner = accountType === "User" ? "octocat" : "withAutograph";
      const credentials = credentialStore();
      if (accountType === "User") {
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        credentials.read = vi.fn(async () => ({
          active: true,
          providerLogin: "octocat",
          providerUserId: "77",
          revision: 1,
          tokens: {
            accessToken: "expired-github-user-token",
            accessTokenExpiresAt: "2026-08-30T11:00:00.000Z",
            refreshToken: "github-user-refresh-token",
            refreshTokenExpiresAt: "2026-09-30T12:00:00.000Z",
          },
          updatedAt: new Date(),
        }));
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        credentials.rotate = vi.fn(async () => ({
          active: true,
          providerLogin: "octocat",
          providerUserId: "77",
          revision: 2,
          tokens: {
            accessToken: "refreshed-github-user-token",
            accessTokenExpiresAt: "2026-08-30T20:00:00.000Z",
            refreshToken: "rotated-github-refresh-token",
            refreshTokenExpiresAt: "2027-02-28T12:00:00.000Z",
          },
          updatedAt: new Date(),
        }));
      }
      let created = false;
      const methods: { path: string; method: string; body?: unknown }[] = [];
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      const request = vi.fn<typeof fetch>(async (url, init) => {
        const parsedUrl = new URL(String(url));
        const path = `${parsedUrl.pathname}${parsedUrl.search}`;
        const method = init?.method ?? "GET";
        const body =
          init?.body && parsedUrl.origin === "https://api.github.com"
            ? JSON.parse(String(init.body))
            : undefined;
        methods.push({ body, method, path });
        if (parsedUrl.origin === "https://github.com" && path === "/login/oauth/access_token")
          return Response.json(
            {
              access_token: "refreshed-github-user-token",
              expires_in: 28_800,
              refresh_token: "rotated-github-refresh-token",
              refresh_token_expires_in: 15_768_000,
            },
            { headers: { date: "Sun, 30 Aug 2026 12:00:00 GMT" } },
          );
        if (path === "/app/installations/101")
          return Response.json({
            account: {
              id: accountType === "User" ? 77 : 88,
              login: owner,
              type: accountType,
            },
            id: 101,
            repository_selection: accountType === "Organization" ? "all" : "selected",
            suspended_at: null,
          });
        if (path === "/user") return Response.json({ id: 77, login: "octocat" });
        if (path.endsWith("/access_tokens"))
          return Response.json(
            {
              permissions: body.permissions,
              token: "github-installation-access-token",
            },
            { status: 201 },
          );
        if (path === `/repos/${owner}/vendor-portal`)
          return created
            ? Response.json({
                default_branch: "main",
                description: `Created by Autograph App Builder request ${requestId}`,
                id: 202,
                name: "vendor-portal",
                owner: { login: owner },
                private: isPrivate,
              })
            : Response.json({}, { status: 404 });
        if (path === createPath) {
          created = true;
          return Response.json({ id: 202 }, { status: 201 });
        }
        if (path.endsWith("/git/blobs")) return Response.json({ sha: blobSha }, { status: 201 });
        if (path.endsWith("/git/trees"))
          return Response.json({ sha: ARRUSTED_TARGET_TREE }, { status: 201 });
        if (path.endsWith("/git/commits"))
          return Response.json({ sha: "a".repeat(40) }, { status: 201 });
        if (path.endsWith("/git/refs"))
          return Response.json({ ref: "refs/heads/main" }, { status: 201 });
        if (path.endsWith("/commits/main"))
          return Response.json({
            commit: { tree: { sha: ARRUSTED_TARGET_TREE } },
            parents: [],
            sha: "a".repeat(40),
          });
        if (path.includes(`/git/trees/${ARRUSTED_TARGET_TREE}`))
          return Response.json({
            tree: [
              {
                mode: "100644",
                path: "README.md",
                sha: blobSha,
                type: "blob",
              },
            ],
            truncated: false,
          });
        throw new Error(`Unexpected GitHub request ${method} ${path}`);
      });
      const suffixes = ["a1b2c3", "b2c3d4", "c3d4e5", "d4e5f6"];
      const result = await provisionGitHubRepository({
        authority,
        config,
        credentialStore: credentials,
        fetch: request,
        generateSuffix: () => suffixes.shift() ?? "",
        installation: {
          accountId: accountType === "User" ? "77" : "88",
          accountLogin: owner,
          accountType,
          active: true,
          installationId: "101",
          updatedAt: new Date(),
        },
        now: () => Date.parse("2026-08-30T12:00:00.000Z"),
        persistAbsent: vi.fn(),
        persistCandidate: vi.fn(),
        persistedAbsentCandidates: [],
        persistedCandidates: [],
        private: isPrivate,
        requestId,
        requestedName: "vendor-portal",
        source,
      });
      expect(result).toMatchObject({
        fullName: `${owner}/vendor-portal`,
        headTree: ARRUSTED_TARGET_TREE,
        repositoryId: "202",
        status: "succeeded",
        visibility: isPrivate ? "private" : "public",
      });
      expect(methods).toContainEqual(expect.objectContaining({ method: "POST", path: createPath }));
      expect(methods.find((entry) => entry.path.endsWith("/git/commits"))?.body).toMatchObject({
        parents: [],
        tree: ARRUSTED_TARGET_TREE,
      });
      expect(methods.find((entry) => entry.path === createPath)?.body).toMatchObject({
        auto_init: false,
        private: isPrivate,
      });
      if (accountType === "User") expect(credentials.rotate).toHaveBeenCalledTimes(1);
    },
  );

  it("deactivates a personal credential after a confirmed 401", async () => {
    const credentials = credentialStore();
    const result = await provisionGitHubRepository({
      authority,
      config,
      credentialStore: credentials,
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      fetch: vi.fn<typeof fetch>(async (url) => {
        const path = new URL(String(url)).pathname;
        if (path === "/app/installations/101")
          return Response.json({
            account: { id: 77, login: "octocat", type: "User" },
            id: 101,
            repository_selection: "selected",
            suspended_at: null,
          });
        if (path === "/user") return Response.json({}, { status: 401 });
        throw new Error(`Unexpected GitHub request ${path}`);
      }),
      installation: {
        accountId: "77",
        accountLogin: "octocat",
        accountType: "User",
        active: true,
        installationId: "101",
        updatedAt: new Date(),
      },
      persistAbsent: vi.fn(),
      persistCandidate: vi.fn(),
      persistedAbsentCandidates: [],
      persistedCandidates: [],
      private: true,
      requestId,
      requestedName: "vendor-portal",
      source,
    });
    expect(result).toMatchObject({
      code: "credential_unavailable",
      status: "failed",
    });
    expect(credentials.deactivate).toHaveBeenCalledWith(
      expect.objectContaining({ providerUserId: "77" }),
    );
  });

  it("recovers a lost create response on the persisted collision suffix", async () => {
    const candidates: string[] = [];
    const absent: string[] = [];
    let created = false;
    let main = false;
    let loseCreateResponse = true;
    const resolved = "vendor-portal-a1b2c3";
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const request = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/app/installations/101")
        return Response.json({
          account: { id: 88, login: "withAutograph", type: "Organization" },
          id: 101,
          repository_selection: "all",
          suspended_at: null,
        });
      if (path.endsWith("/access_tokens"))
        return Response.json(
          {
            permissions: {
              administration: "write",
              contents: "write",
              metadata: "read",
            },
            token: "github-installation-access-token",
          },
          { status: 201 },
        );
      if (path === "/repos/withAutograph/vendor-portal")
        return Response.json({ description: "unrelated repository" });
      if (path === `/repos/withAutograph/${resolved}`)
        return created
          ? Response.json({
              default_branch: "main",
              description: `Created by Autograph App Builder request ${requestId}`,
              id: 303,
              name: resolved,
              owner: { login: "withAutograph" },
              private: true,
            })
          : Response.json({}, { status: 404 });
      if (path === "/orgs/withAutograph/repos" && init?.method === "POST") {
        created = true;
        if (loseCreateResponse) {
          loseCreateResponse = false;
          throw new Error("connection reset after provider commit");
        }
        return Response.json({ id: 303 }, { status: 201 });
      }
      if (path.endsWith("/commits/main"))
        return main
          ? Response.json({
              commit: { tree: { sha: ARRUSTED_TARGET_TREE } },
              parents: [],
              sha: "a".repeat(40),
            })
          : Response.json({}, { status: 404 });
      if (path.endsWith("/git/blobs")) return Response.json({ sha: blobSha }, { status: 201 });
      if (path.endsWith("/git/trees"))
        return Response.json({ sha: ARRUSTED_TARGET_TREE }, { status: 201 });
      if (path.endsWith("/git/commits"))
        return Response.json({ sha: "a".repeat(40) }, { status: 201 });
      if (path.endsWith("/git/refs")) {
        main = true;
        return Response.json({ ref: "refs/heads/main" }, { status: 201 });
      }
      if (path.includes(`/git/trees/${ARRUSTED_TARGET_TREE}`))
        return Response.json({
          tree: [
            {
              mode: "100644",
              path: "README.md",
              sha: blobSha,
              type: "blob",
            },
          ],
          truncated: false,
        });
      throw new Error(`Unexpected GitHub request ${path}`);
    });
    const base = {
      authority,
      config,
      credentialStore: credentialStore(),
      fetch: request,
      installation: {
        accountId: "88",
        accountLogin: "withAutograph",
        accountType: "Organization" as const,
        active: true,
        installationId: "101",
        updatedAt: new Date(),
      },
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      persistAbsent: async (value: string) => {
        absent.push(value);
      },
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      persistCandidate: async (value: string) => {
        candidates.push(value);
      },
      private: true,
      requestId,
      requestedName: "vendor-portal",
      source,
    };
    const suffixes = ["a1b2c3", "b2c3d4", "c3d4e5", "d4e5f6"];
    const first = await provisionGitHubRepository({
      ...base,
      generateSuffix: () => suffixes.shift() ?? "",
      persistedAbsentCandidates: [],
      persistedCandidates: [],
    });
    expect(first).toMatchObject({
      code: "provider_unavailable",
      status: "failed",
    });
    expect(absent).toContain(resolved);
    const recovered = await provisionGitHubRepository({
      ...base,
      persistedAbsentCandidates: absent,
      persistedCandidates: candidates,
    });
    expect(recovered).toMatchObject({
      fullName: `withAutograph/${resolved}`,
      headTree: ARRUSTED_TARGET_TREE,
      repositoryId: "303",
      status: "succeeded",
    });
    expect(
      request.mock.calls.filter(
        ([url, init]) =>
          new URL(String(url)).pathname === "/orgs/withAutograph/repos" && init?.method === "POST",
      ),
    ).toHaveLength(1);
  });
});
