import { createHash, createPrivateKey, randomBytes } from "node:crypto";

import { SignJWT } from "jose";
import { z } from "zod";

import type { HostedGitHubInstallationBinding } from "../repository/postgres-github-installation-store";
import type { GitHubProvisionResult } from "./contracts";
import type { GitHubUserCredentialStore } from "./github-user-credential";
import type { BuilderProvisionAuthority } from "./journal";
import { suffixedProviderName } from "./names";
import type { StarterSource } from "./starter-source";

const API = "https://api.github.com";
const ORIGIN = "https://github.com";
const API_VERSION = "2026-03-10";
const USER_AGENT = "autograph-app-builder-provisioning";
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const decimal = z.string().regex(/^[1-9][0-9]*$/u);

const configSchema = z
  .object({
    appId: decimal,
    clientId: z.string().min(1),
    clientSecret: z.string().min(20),
    privateKey: z.string().min(1).max(32_768),
  })
  .strict();

export type GitHubProvisioningConfig = z.infer<typeof configSchema>;

export function readGitHubProvisioningEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): GitHubProvisioningConfig {
  const parsed = configSchema.parse({
    appId: environment.GITHUB_APP_ID,
    clientId: environment.GITHUB_APP_CLIENT_ID,
    clientSecret: environment.GITHUB_APP_CLIENT_SECRET,
    privateKey: environment.GITHUB_APP_PRIVATE_KEY,
  });
  createPrivateKey(parsed.privateKey);
  return parsed;
}

type JsonResponse = { status: number; body: unknown };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function property(value: unknown, key: string) {
  if (!record(value) || !(key in value)) throw new Error("invalid-response");
  return value[key];
}

function stringProperty(value: unknown, key: string) {
  const result = property(value, key);
  if (typeof result !== "string") throw new Error("invalid-response");
  return result;
}

function decimalProperty(value: unknown, key: string) {
  const result = property(value, key);
  return decimal.parse(typeof result === "number" ? String(result) : result);
}

function marker(requestId: string) {
  return `Created by Autograph App Builder request ${requestId}`;
}

function suffix() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return [...randomBytes(6)]
    .map((value) => alphabet[value % alphabet.length])
    .join("");
}

function gitBlobSha(bytes: Uint8Array) {
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}

export async function provisionGitHubRepository(input: {
  config: GitHubProvisioningConfig;
  authority: BuilderProvisionAuthority;
  installation: HostedGitHubInstallationBinding;
  credentialStore: GitHubUserCredentialStore;
  requestId: string;
  requestedName: string;
  private: boolean;
  source: StarterSource;
  persistedCandidates: readonly string[];
  persistedAbsentCandidates: readonly string[];
  persistCandidate(candidate: string): Promise<void>;
  persistAbsent(candidate: string): Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
  generateSuffix?: () => string;
}): Promise<GitHubProvisionResult> {
  const config = configSchema.parse(input.config);
  const request = input.fetch ?? fetch;
  const now = input.now ?? Date.now;
  const privateKey = createPrivateKey(config.privateKey);

  async function appJwt() {
    const issuedAt = Math.floor(now() / 1_000) - 30;
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(config.appId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 540)
      .sign(privateKey);
  }

  async function github(args: {
    method?: "GET" | "POST";
    path: string;
    token: string;
    body?: unknown;
    expected: readonly number[];
  }): Promise<JsonResponse> {
    let response: Response;
    try {
      response = await request(`${API}${args.path}`, {
        method: args.method ?? "GET",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${args.token}`,
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
          "X-GitHub-Api-Version": API_VERSION,
        },
        ...(args.body === undefined ? {} : { body: JSON.stringify(args.body) }),
      });
    } catch {
      throw new Error("provider-unavailable");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 2 * 1024 * 1024) throw new Error("invalid-response");
    let body: unknown;
    try {
      body = bytes.byteLength
        ? JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes))
        : undefined;
    } catch {
      throw new Error("invalid-response");
    }
    if (response.status === 401) throw new Error("credential-rejected");
    if (!args.expected.includes(response.status))
      throw new Error(`github-status-${response.status}`);
    return { status: response.status, body };
  }

  async function installationToken() {
    const response = await github({
      method: "POST",
      path: `/app/installations/${input.installation.installationId}/access_tokens`,
      token: await appJwt(),
      body: {
        permissions: {
          administration: "write",
          contents: "write",
          metadata: "read",
        },
      },
      expected: [201],
    });
    const token = stringProperty(response.body, "token");
    if (token.length < 20 || token.length > 512)
      throw new Error("invalid-response");
    return token;
  }

  async function verifyInstallation() {
    const response = await github({
      path: `/app/installations/${input.installation.installationId}`,
      token: await appJwt(),
      expected: [200],
    });
    const account = property(response.body, "account");
    if (
      decimalProperty(response.body, "id") !==
        input.installation.installationId ||
      decimalProperty(account, "id") !== input.installation.accountId ||
      stringProperty(account, "login") !== input.installation.accountLogin ||
      stringProperty(account, "type") !== input.installation.accountType ||
      !["all", "selected"].includes(
        stringProperty(response.body, "repository_selection"),
      ) ||
      property(response.body, "suspended_at") !== null
    )
      throw new Error("installation-inactive");
  }

  async function refreshUserToken() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const credential = await input.credentialStore.read({
        authority: input.authority,
        providerUserId: input.installation.accountId,
      });
      if (!credential?.active) throw new Error("credential-unavailable");
      const expires = credential.tokens.accessTokenExpiresAt
        ? Date.parse(credential.tokens.accessTokenExpiresAt)
        : undefined;
      if (expires === undefined || expires > now() + 60_000)
        return credential.tokens.accessToken;
      if (
        !credential.tokens.refreshToken ||
        !credential.tokens.refreshTokenExpiresAt ||
        Date.parse(credential.tokens.refreshTokenExpiresAt) <= now()
      )
        throw new Error("credential-unavailable");
      const response = await request(`${ORIGIN}/login/oauth/access_token`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": USER_AGENT,
        },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: "refresh_token",
          refresh_token: credential.tokens.refreshToken,
        }),
      });
      if (response.status === 401) {
        await input.credentialStore.deactivate({
          authority: input.authority,
          providerUserId: input.installation.accountId,
          now: new Date(now()),
        });
        throw new Error("credential-unavailable");
      }
      if (!response.ok) throw new Error("provider-unavailable");
      const body = (await response.json()) as unknown;
      const accessToken = stringProperty(body, "access_token");
      const refreshToken = stringProperty(body, "refresh_token");
      const expiresIn = property(body, "expires_in");
      const refreshExpiresIn = property(body, "refresh_token_expires_in");
      if (
        typeof expiresIn !== "number" ||
        typeof refreshExpiresIn !== "number" ||
        !Number.isSafeInteger(expiresIn) ||
        !Number.isSafeInteger(refreshExpiresIn) ||
        expiresIn <= 0 ||
        refreshExpiresIn <= 0
      )
        throw new Error("invalid-response");
      const refreshedAt = now();
      const rotated = await input.credentialStore.rotate({
        authority: input.authority,
        providerUserId: input.installation.accountId,
        expectedRevision: credential.revision,
        tokens: {
          accessToken,
          accessTokenExpiresAt: new Date(
            refreshedAt + expiresIn * 1_000,
          ).toISOString(),
          refreshToken,
          refreshTokenExpiresAt: new Date(
            refreshedAt + refreshExpiresIn * 1_000,
          ).toISOString(),
        },
        now: new Date(refreshedAt),
      });
      if (rotated) return rotated.tokens.accessToken;
    }
    throw new Error("credential-contention");
  }

  let token: string;
  try {
    await verifyInstallation();
    token =
      input.installation.accountType === "Organization"
        ? await installationToken()
        : await refreshUserToken();
    if (input.installation.accountType === "User") {
      const user = await github({
        path: "/user",
        token,
        expected: [200],
      });
      if (
        decimalProperty(user.body, "id") !== input.installation.accountId ||
        stringProperty(user.body, "login") !== input.installation.accountLogin
      )
        throw new Error("credential-unavailable");
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "credential-rejected" &&
      input.installation.accountType === "User"
    )
      await input.credentialStore.deactivate({
        authority: input.authority,
        providerUserId: input.installation.accountId,
        now: new Date(now()),
      });
    return {
      status: "failed",
      code:
        error instanceof Error && error.message.includes("credential")
          ? "credential_unavailable"
          : error instanceof Error && error.message.includes("installation")
            ? "installation_inactive"
            : "provider_unavailable",
      retryable: true,
    };
  }

  async function repository(name: string) {
    return github({
      path: `/repos/${encodeURIComponent(input.installation.accountLogin)}/${encodeURIComponent(name)}`,
      token,
      expected: [200, 404],
    });
  }

  async function writeStarter(name: string) {
    const blobs = new Map<string, string>();
    for (let offset = 0; offset < input.source.files.length; offset += 12) {
      const page = input.source.files.slice(offset, offset + 12);
      const values = await Promise.all(
        page.map(async (file) => {
          const response = await github({
            method: "POST",
            path: `/repos/${encodeURIComponent(input.installation.accountLogin)}/${encodeURIComponent(name)}/git/blobs`,
            token,
            body: {
              content: Buffer.from(file.bytes).toString("base64"),
              encoding: "base64",
            },
            expected: [201],
          });
          return [
            file.path,
            objectId.parse(stringProperty(response.body, "sha")),
          ] as const;
        }),
      );
      for (const [path, sha] of values) blobs.set(path, sha);
    }
    const tree = await github({
      method: "POST",
      path: `/repos/${encodeURIComponent(input.installation.accountLogin)}/${encodeURIComponent(name)}/git/trees`,
      token,
      body: {
        tree: input.source.files.map((file) => ({
          path: file.path,
          mode: file.mode,
          type: "blob",
          sha: blobs.get(file.path),
        })),
      },
      expected: [201],
    });
    const treeSha = objectId.parse(stringProperty(tree.body, "sha"));
    if (treeSha !== input.source.manifest.source.tree)
      throw new Error("source-tree-mismatch");
    const commit = await github({
      method: "POST",
      path: `/repos/${encodeURIComponent(input.installation.accountLogin)}/${encodeURIComponent(name)}/git/commits`,
      token,
      body: {
        message: "Initialize repository from supported Arrusted starter",
        tree: treeSha,
        parents: [],
      },
      expected: [201],
    });
    const commitSha = objectId.parse(stringProperty(commit.body, "sha"));
    await github({
      method: "POST",
      path: `/repos/${encodeURIComponent(input.installation.accountLogin)}/${encodeURIComponent(name)}/git/refs`,
      token,
      body: { ref: "refs/heads/main", sha: commitSha },
      expected: [201],
    });
  }

  async function readBack(name: string): Promise<GitHubProvisionResult> {
    const repo = await repository(name);
    if (repo.status !== 200) throw new Error("repository-missing");
    if (stringProperty(repo.body, "description") !== marker(input.requestId))
      throw new Error("repository-marker-mismatch");
    const commit = await github({
      path: `/repos/${encodeURIComponent(input.installation.accountLogin)}/${encodeURIComponent(name)}/commits/main`,
      token,
      expected: [200],
    });
    const commitData = property(commit.body, "commit");
    const treeData = property(commitData, "tree");
    const parents = property(commit.body, "parents");
    if (!Array.isArray(parents) || parents.length !== 0)
      throw new Error("commit-not-parentless");
    const headSha = objectId.parse(stringProperty(commit.body, "sha"));
    const headTree = objectId.parse(stringProperty(treeData, "sha"));
    if (headTree !== input.source.manifest.source.tree)
      throw new Error("source-tree-mismatch");
    const tree = await github({
      path: `/repos/${encodeURIComponent(input.installation.accountLogin)}/${encodeURIComponent(name)}/git/trees/${headTree}?recursive=1`,
      token,
      expected: [200],
    });
    if (property(tree.body, "truncated") !== false)
      throw new Error("tree-truncated");
    const entries = property(tree.body, "tree");
    if (!Array.isArray(entries)) throw new Error("invalid-response");
    const observed = entries
      .filter((entry) => record(entry) && entry.type === "blob")
      .map((entry) => ({
        path: stringProperty(entry, "path"),
        mode: stringProperty(entry, "mode"),
        sha: stringProperty(entry, "sha"),
      }))
      .toSorted((left, right) => left.path.localeCompare(right.path));
    const expected = input.source.files
      .map((file) => ({
        path: file.path,
        mode: file.mode,
        sha: gitBlobSha(file.bytes),
      }))
      .toSorted((left, right) => left.path.localeCompare(right.path));
    if (JSON.stringify(observed) !== JSON.stringify(expected))
      throw new Error("source-files-mismatch");
    const repositoryId = decimalProperty(repo.body, "id");
    const owner = stringProperty(property(repo.body, "owner"), "login");
    const resolvedName = stringProperty(repo.body, "name");
    const isPrivate = property(repo.body, "private");
    if (
      owner !== input.installation.accountLogin ||
      typeof isPrivate !== "boolean" ||
      isPrivate !== input.private ||
      stringProperty(repo.body, "default_branch") !== "main"
    )
      throw new Error("repository-postcondition");
    return {
      status: "succeeded",
      installationId: input.installation.installationId,
      repositoryId,
      owner,
      name: resolvedName,
      fullName: `${owner}/${resolvedName}`,
      url: `https://github.com/${owner}/${resolvedName}`,
      scope: {
        type:
          input.installation.accountType === "Organization"
            ? "organization"
            : "user",
        id: input.installation.accountId,
        login: input.installation.accountLogin,
      },
      visibility: isPrivate ? "private" : "public",
      defaultBranch: "main",
      headSha,
      headTree,
      starter: {
        sourceSha: input.source.manifest.source.sha,
        sourceTree: input.source.manifest.source.tree,
        archiveSha256: input.source.manifest.archive.sha256,
        archiveBytes: input.source.manifest.archive.bytes,
        manifestSha256: input.source.manifestSha256,
      },
    };
  }

  try {
    const candidates = [...input.persistedCandidates];
    for (
      let generated = 0;
      candidates.length < 5 && generated < 20;
      generated += 1
    ) {
      const candidate =
        candidates.length === 0
          ? input.requestedName
          : suffixedProviderName({
              base: input.requestedName,
              suffix: (input.generateSuffix ?? suffix)(),
              maximumLength: 100,
            });
      if (candidates.includes(candidate)) continue;
      await input.persistCandidate(candidate);
      candidates.push(candidate);
    }
    for (const candidate of candidates.slice(0, 5)) {
      const before = await repository(candidate);
      const wasAbsent = input.persistedAbsentCandidates.includes(candidate);
      if (before.status === 200 && !wasAbsent) continue;
      if (before.status === 404 && !wasAbsent)
        await input.persistAbsent(candidate);
      if (before.status === 404) {
        const createPath =
          input.installation.accountType === "Organization"
            ? `/orgs/${encodeURIComponent(input.installation.accountLogin)}/repos`
            : "/user/repos";
        const created = await github({
          method: "POST",
          path: createPath,
          token,
          body: {
            name: candidate,
            private: input.private,
            auto_init: false,
            description: marker(input.requestId),
          },
          expected: [201, 422],
        });
        if (created.status === 422) {
          const recovered = await repository(candidate);
          if (recovered.status !== 200) continue;
        } else {
          if (input.installation.accountType === "Organization")
            token = await installationToken();
          await writeStarter(candidate);
        }
      }
      const owned = await repository(candidate);
      if (
        owned.status !== 200 ||
        stringProperty(owned.body, "description") !== marker(input.requestId)
      )
        continue;
      const main = await github({
        path: `/repos/${encodeURIComponent(input.installation.accountLogin)}/${encodeURIComponent(candidate)}/commits/main`,
        token,
        expected: [200, 404, 409],
      });
      if (main.status !== 200) await writeStarter(candidate);
      try {
        return await readBack(candidate);
      } catch {
        return {
          status: "failed",
          code: "postcondition_failed",
          retryable: false,
        };
      }
    }
    return { status: "failed", code: "name_conflict", retryable: true };
  } catch (error) {
    if (error instanceof Error && error.message === "credential-rejected") {
      await input.credentialStore.deactivate({
        authority: input.authority,
        providerUserId: input.installation.accountId,
        now: new Date(now()),
      });
      return {
        status: "failed",
        code: "credential_unavailable",
        retryable: true,
      };
    }
    return {
      status: "failed",
      code:
        error instanceof Error && error.message.includes("source")
          ? "source_mismatch"
          : "provider_unavailable",
      retryable: true,
    };
  }
}
