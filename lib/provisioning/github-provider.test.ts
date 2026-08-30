import { createHash, generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { provisionGitHubRepository } from "./github-provider";
import type { GitHubUserCredentialStore } from "./github-user-credential";
import type { StarterSource } from "./starter-source";
import {
  ARRUSTED_TARGET_SHA,
  ARRUSTED_TARGET_TREE,
} from "../repository/dependency-cache";

const authority = {
  issuer: "https://builder.example.test/api/auth",
  audience: "https://builder.example.test/mcp",
  workspaceId: "workspace-1",
  ownerUserId: "user-1",
};
const requestId = "123e4567-e89b-42d3-a456-426614174000";
const content = new TextEncoder().encode("# Starter\n");
const blobSha = createHash("sha1")
  .update(`blob ${content.byteLength}\0`)
  .update(content)
  .digest("hex");
const source: StarterSource = {
  manifestSha256: "d".repeat(64),
  manifest: {
    version: 1,
    source: {
      repository: "https://github.com/withAutograph/arrusted-development",
      sha: ARRUSTED_TARGET_SHA,
      tree: ARRUSTED_TARGET_TREE,
    },
    archive: {
      url: `https://releases.example.test/${"e".repeat(64)}.tar.gz`,
      sha256: "e".repeat(64),
      bytes: 100,
    },
    files: [
      {
        path: "README.md",
        mode: "100644",
        sha256: createHash("sha256").update(content).digest("hex"),
        bytes: content.byteLength,
      },
    ],
  },
  files: [{ path: "README.md", mode: "100644", bytes: content }],
};

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config = {
  appId: "123",
  clientId: "client-id",
  clientSecret: "client-secret-value-long-enough",
  privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};

function credentialStore(): GitHubUserCredentialStore {
  return {
    bind: vi.fn(),
    read: vi.fn(async () => ({
      providerUserId: "77",
      providerLogin: "octocat",
      tokens: { accessToken: "github-user-access-token" },
      revision: 1,
      active: true,
      updatedAt: new Date(),
    })),
    rotate: vi.fn(),
    deactivate: vi.fn(async () => 1),
  };
}

describe("GitHub starter repository provisioning", () => {
  it.each([
    ["Organization", true, "/orgs/withAutograph/repos"],
    ["User", false, "/user/repos"],
  ] as const)(
    "creates a %s repository with one exact parentless main commit",
    async (accountType, isPrivate, createPath) => {
      const owner = accountType === "User" ? "octocat" : "withAutograph";
      const credentials = credentialStore();
      if (accountType === "User") {
        credentials.read = vi.fn(async () => ({
          providerUserId: "77",
          providerLogin: "octocat",
          tokens: {
            accessToken: "expired-github-user-token",
            accessTokenExpiresAt: "2026-08-30T11:00:00.000Z",
            refreshToken: "github-user-refresh-token",
            refreshTokenExpiresAt: "2026-09-30T12:00:00.000Z",
          },
          revision: 1,
          active: true,
          updatedAt: new Date(),
        }));
        credentials.rotate = vi.fn(async () => ({
          providerUserId: "77",
          providerLogin: "octocat",
          tokens: {
            accessToken: "refreshed-github-user-token",
            accessTokenExpiresAt: "2026-08-30T20:00:00.000Z",
            refreshToken: "rotated-github-refresh-token",
            refreshTokenExpiresAt: "2027-02-28T12:00:00.000Z",
          },
          revision: 2,
          active: true,
          updatedAt: new Date(),
        }));
      }
      let created = false;
      const methods: Array<{ path: string; method: string; body?: unknown }> =
        [];
      const request = vi.fn<typeof fetch>(async (url, init) => {
        const parsedUrl = new URL(String(url));
        const path = `${parsedUrl.pathname}${parsedUrl.search}`;
        const method = init?.method ?? "GET";
        const body =
          init?.body && parsedUrl.origin === "https://api.github.com"
            ? JSON.parse(String(init.body))
            : undefined;
        methods.push({ path, method, body });
        if (
          parsedUrl.origin === "https://github.com" &&
          path === "/login/oauth/access_token"
        )
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
            id: 101,
            repository_selection:
              accountType === "Organization" ? "all" : "selected",
            suspended_at: null,
            account: {
              id: accountType === "User" ? 77 : 88,
              login: owner,
              type: accountType,
            },
          });
        if (path === "/user")
          return Response.json({ id: 77, login: "octocat" });
        if (path.endsWith("/access_tokens"))
          return Response.json(
            {
              token: "github-installation-access-token",
              permissions: body.permissions,
            },
            { status: 201 },
          );
        if (path === `/repos/${owner}/vendor-portal`)
          return created
            ? Response.json({
                id: 202,
                name: "vendor-portal",
                description: `Created by Autograph App Builder request ${requestId}`,
                private: isPrivate,
                default_branch: "main",
                owner: { login: owner },
              })
            : Response.json({}, { status: 404 });
        if (path === createPath) {
          created = true;
          return Response.json({ id: 202 }, { status: 201 });
        }
        if (path.endsWith("/git/blobs"))
          return Response.json({ sha: blobSha }, { status: 201 });
        if (path.endsWith("/git/trees"))
          return Response.json({ sha: ARRUSTED_TARGET_TREE }, { status: 201 });
        if (path.endsWith("/git/commits"))
          return Response.json({ sha: "a".repeat(40) }, { status: 201 });
        if (path.endsWith("/git/refs"))
          return Response.json({ ref: "refs/heads/main" }, { status: 201 });
        if (path.endsWith("/commits/main"))
          return Response.json({
            sha: "a".repeat(40),
            commit: { tree: { sha: ARRUSTED_TARGET_TREE } },
            parents: [],
          });
        if (path.includes(`/git/trees/${ARRUSTED_TARGET_TREE}`))
          return Response.json({
            truncated: false,
            tree: [
              {
                path: "README.md",
                mode: "100644",
                type: "blob",
                sha: blobSha,
              },
            ],
          });
        throw new Error(`Unexpected GitHub request ${method} ${path}`);
      });
      const suffixes = ["a1b2c3", "b2c3d4", "c3d4e5", "d4e5f6"];
      const result = await provisionGitHubRepository({
        config,
        authority,
        installation: {
          installationId: "101",
          accountId: accountType === "User" ? "77" : "88",
          accountLogin: owner,
          accountType,
          active: true,
          updatedAt: new Date(),
        },
        credentialStore: credentials,
        requestId,
        requestedName: "vendor-portal",
        private: isPrivate,
        source,
        persistedCandidates: [],
        persistedAbsentCandidates: [],
        persistCandidate: vi.fn(),
        persistAbsent: vi.fn(),
        fetch: request,
        now: () => Date.parse("2026-08-30T12:00:00.000Z"),
        generateSuffix: () => suffixes.shift()!,
      });
      expect(result).toMatchObject({
        status: "succeeded",
        repositoryId: "202",
        fullName: `${owner}/vendor-portal`,
        visibility: isPrivate ? "private" : "public",
        headTree: ARRUSTED_TARGET_TREE,
      });
      expect(methods).toContainEqual(
        expect.objectContaining({ path: createPath, method: "POST" }),
      );
      expect(
        methods.find((entry) => entry.path.endsWith("/git/commits"))?.body,
      ).toMatchObject({ parents: [], tree: ARRUSTED_TARGET_TREE });
      expect(
        methods.find((entry) => entry.path === createPath)?.body,
      ).toMatchObject({ private: isPrivate, auto_init: false });
      if (accountType === "User")
        expect(credentials.rotate).toHaveBeenCalledTimes(1);
    },
  );

  it("deactivates a personal credential after a confirmed 401", async () => {
    const credentials = credentialStore();
    const result = await provisionGitHubRepository({
      config,
      authority,
      installation: {
        installationId: "101",
        accountId: "77",
        accountLogin: "octocat",
        accountType: "User",
        active: true,
        updatedAt: new Date(),
      },
      credentialStore: credentials,
      requestId,
      requestedName: "vendor-portal",
      private: true,
      source,
      persistedCandidates: [],
      persistedAbsentCandidates: [],
      persistCandidate: vi.fn(),
      persistAbsent: vi.fn(),
      fetch: vi.fn<typeof fetch>(async (url) => {
        const path = new URL(String(url)).pathname;
        if (path === "/app/installations/101")
          return Response.json({
            id: 101,
            repository_selection: "selected",
            suspended_at: null,
            account: { id: 77, login: "octocat", type: "User" },
          });
        if (path === "/user") return Response.json({}, { status: 401 });
        throw new Error(`Unexpected GitHub request ${path}`);
      }),
    });
    expect(result).toMatchObject({
      status: "failed",
      code: "credential_unavailable",
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
    const request = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/app/installations/101")
        return Response.json({
          id: 101,
          repository_selection: "all",
          suspended_at: null,
          account: { id: 88, login: "withAutograph", type: "Organization" },
        });
      if (path.endsWith("/access_tokens"))
        return Response.json(
          {
            token: "github-installation-access-token",
            permissions: {
              administration: "write",
              contents: "write",
              metadata: "read",
            },
          },
          { status: 201 },
        );
      if (path === "/repos/withAutograph/vendor-portal")
        return Response.json({ description: "unrelated repository" });
      if (path === `/repos/withAutograph/${resolved}`)
        return created
          ? Response.json({
              id: 303,
              name: resolved,
              description: `Created by Autograph App Builder request ${requestId}`,
              private: true,
              default_branch: "main",
              owner: { login: "withAutograph" },
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
              sha: "a".repeat(40),
              commit: { tree: { sha: ARRUSTED_TARGET_TREE } },
              parents: [],
            })
          : Response.json({}, { status: 404 });
      if (path.endsWith("/git/blobs"))
        return Response.json({ sha: blobSha }, { status: 201 });
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
          truncated: false,
          tree: [
            {
              path: "README.md",
              mode: "100644",
              type: "blob",
              sha: blobSha,
            },
          ],
        });
      throw new Error(`Unexpected GitHub request ${path}`);
    });
    const base = {
      config,
      authority,
      installation: {
        installationId: "101",
        accountId: "88",
        accountLogin: "withAutograph",
        accountType: "Organization" as const,
        active: true,
        updatedAt: new Date(),
      },
      credentialStore: credentialStore(),
      requestId,
      requestedName: "vendor-portal",
      private: true,
      source,
      persistCandidate: async (value: string) => void candidates.push(value),
      persistAbsent: async (value: string) => void absent.push(value),
      fetch: request,
    };
    const suffixes = ["a1b2c3", "b2c3d4", "c3d4e5", "d4e5f6"];
    const first = await provisionGitHubRepository({
      ...base,
      persistedCandidates: [],
      persistedAbsentCandidates: [],
      generateSuffix: () => suffixes.shift()!,
    });
    expect(first).toMatchObject({
      status: "failed",
      code: "provider_unavailable",
    });
    expect(absent).toContain(resolved);
    const recovered = await provisionGitHubRepository({
      ...base,
      persistedCandidates: candidates,
      persistedAbsentCandidates: absent,
    });
    expect(recovered).toMatchObject({
      status: "succeeded",
      repositoryId: "303",
      fullName: `withAutograph/${resolved}`,
      headTree: ARRUSTED_TARGET_TREE,
    });
    expect(
      request.mock.calls.filter(
        ([url, init]) =>
          new URL(String(url)).pathname === "/orgs/withAutograph/repos" &&
          init?.method === "POST",
      ),
    ).toHaveLength(1);
  });
});
