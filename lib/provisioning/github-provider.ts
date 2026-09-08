import { createHash, createPrivateKey, randomBytes } from "node:crypto";

import { z } from "zod";

import {
  createGitHubApp,
  createGitHubOAuthApp,
  createGitHubTokenOctokit,
} from "../github/octokit";
import type { HostedGitHubInstallationBinding } from "../repository/postgres-github-installation-store";
import type { GitHubProvisionResult } from "./contracts";
import type { GitHubUserCredentialStore } from "./github-user-credential";
import type { BuilderProvisionAuthority } from "./journal";
import { suffixedProviderName } from "./names";
import type { StarterSource } from "./starter-source";

const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
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

export function starterSourceBinding(source: StarterSource) {
  if (source.provenance !== undefined) {
    if (source.provenance.method === "git-clone-v1") {
      if (
        source.provenance.receiptVersion !== 4 ||
        [
          source.provenance.readinessDigest,
          source.provenance.sourceReceiptDigest,
          source.provenance.eligibilityDigest,
          source.provenance.contractDigest,
        ].some((value) => value === undefined)
      )
        throw new Error("starter-source-provenance-missing");
      return {
        sourceSha: objectId.parse(source.provenance.sourceSha),
        sourceTree: objectId.parse(source.provenance.sourceTree),
        starter: {
          sourceSha: objectId.parse(source.provenance.sourceSha),
          sourceTree: objectId.parse(source.provenance.sourceTree),
          repository: source.provenance.repository,
          ref: source.provenance.ref,
          method: source.provenance.method,
          readinessDigest: digest.parse(source.provenance.readinessDigest),
          receiptVersion: source.provenance.receiptVersion,
          sourceReceiptDigest: digest.parse(
            source.provenance.sourceReceiptDigest,
          ),
          eligibilityDigest: digest.parse(source.provenance.eligibilityDigest),
          contractDigest: digest.parse(source.provenance.contractDigest),
        },
      };
    }
    return {
      sourceSha: objectId.parse(source.provenance.sourceSha),
      sourceTree: objectId.parse(source.provenance.sourceTree),
      starter: {
        sourceSha: objectId.parse(source.provenance.sourceSha),
        sourceTree: objectId.parse(source.provenance.sourceTree),
        repository: source.provenance.repository,
        ref: source.provenance.ref,
        method: source.provenance.method,
      },
    };
  }
  if (source.manifest === undefined || source.manifestSha256 === undefined)
    throw new Error("starter-source-provenance-missing");
  return {
    sourceSha: source.manifest.source.sha,
    sourceTree: source.manifest.source.tree,
    starter: {
      sourceSha: source.manifest.source.sha,
      sourceTree: source.manifest.source.tree,
      repository: source.manifest.source.repository,
      ref: "refs/heads/main" as const,
      method: "starter-archive-v3" as const,
      archiveSha256: source.manifest.archive.sha256,
      archiveBytes: source.manifest.archive.bytes,
      manifestSha256: source.manifestSha256,
    },
  };
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
  const source = starterSourceBinding(input.source);
  const request = input.fetch ?? fetch;
  const now = input.now ?? Date.now;
  const app = createGitHubApp({
    appId: config.appId,
    privateKey: config.privateKey,
    fetch: request,
  });

  async function github(args: {
    method?: "GET" | "POST";
    path: string;
    token: string;
    body?: unknown;
    expected: readonly number[];
  }): Promise<JsonResponse> {
    try {
      const response = await createGitHubTokenOctokit({
        token: args.token,
        fetch: request,
      }).request(`${args.method ?? "GET"} ${args.path}`, {
        ...(record(args.body) ? args.body : {}),
      });
      if (!args.expected.includes(response.status))
        throw new Error(`github-status-${response.status}`);
      return { status: response.status, body: response.data };
    } catch (error) {
      const status = record(error) ? error.status : undefined;
      const response = record(error) ? error.response : undefined;
      if (status === 401) throw new Error("credential-rejected");
      if (typeof status === "number" && args.expected.includes(status))
        return {
          status,
          body: record(response) ? response.data : undefined,
        };
      throw new Error("provider-unavailable");
    }
  }

  async function installationToken() {
    const authentication = await app.octokit.auth({
      type: "installation",
      installationId: input.installation.installationId,
      permissions: {
        administration: "write",
        contents: "write",
        metadata: "read",
      },
      refresh: true,
    });
    const token = stringProperty(authentication, "token");
    const permissions = property(authentication, "permissions");
    if (token.length < 20 || token.length > 512)
      throw new Error("invalid-response");
    if (
      !record(permissions) ||
      Object.keys(permissions).toSorted().join(",") !==
        "administration,contents,metadata" ||
      permissions.administration !== "write" ||
      permissions.contents !== "write" ||
      permissions.metadata !== "read"
    )
      throw new Error("invalid-response");
    return token;
  }

  async function verifyInstallation() {
    const { data } = await app.octokit.request(
      "GET /app/installations/{installation_id}",
      { installation_id: Number(input.installation.installationId) },
    );
    const account = property(data, "account");
    if (
      decimalProperty(data, "id") !== input.installation.installationId ||
      decimalProperty(account, "id") !== input.installation.accountId ||
      stringProperty(account, "login") !== input.installation.accountLogin ||
      stringProperty(account, "type") !== input.installation.accountType ||
      !["all", "selected"].includes(
        stringProperty(data, "repository_selection"),
      ) ||
      property(data, "suspended_at") !== null
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
      let authentication: unknown;
      try {
        ({ authentication } = await createGitHubOAuthApp({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          redirectUrl: "https://github.com/login/oauth/access_token",
          fetch: request,
        }).refreshToken({ refreshToken: credential.tokens.refreshToken }));
      } catch (error) {
        if (record(error) && error.status === 401) {
          await input.credentialStore.deactivate({
            authority: input.authority,
            providerUserId: input.installation.accountId,
            now: new Date(now()),
          });
          throw new Error("credential-unavailable");
        }
        throw new Error("provider-unavailable");
      }
      const accessToken = stringProperty(authentication, "token");
      const refreshToken = stringProperty(authentication, "refreshToken");
      const accessTokenExpiresAt = stringProperty(authentication, "expiresAt");
      const refreshTokenExpiresAt = stringProperty(
        authentication,
        "refreshTokenExpiresAt",
      );
      if (
        Date.parse(accessTokenExpiresAt) <= now() ||
        Date.parse(refreshTokenExpiresAt) <= now()
      )
        throw new Error("invalid-response");
      const refreshedAt = now();
      const rotated = await input.credentialStore.rotate({
        authority: input.authority,
        providerUserId: input.installation.accountId,
        expectedRevision: credential.revision,
        tokens: {
          accessToken,
          accessTokenExpiresAt,
          refreshToken,
          refreshTokenExpiresAt,
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
    if (treeSha !== source.sourceTree) throw new Error("source-tree-mismatch");
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
    if (headTree !== source.sourceTree) throw new Error("source-tree-mismatch");
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
        ...source.starter,
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
