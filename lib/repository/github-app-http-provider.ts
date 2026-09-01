import { createHash, createPrivateKey } from "node:crypto";

import { z } from "zod";

import { createGitHubApp, createGitHubTokenOctokit } from "../github/octokit";
import type { GitHubAppInstallationProvider } from "./github-app-adapter";
import {
  assertExactGitHubFreshRepositoryContent,
  assertExactGitHubDraftPullRequestContent,
  assertExactDraftPullRequestProposal,
  assertExactFreshRepositoryProposal,
  type DraftPullRequestProposal,
} from "./github-publication";
import { safeSourcePath } from "./source-path";
import { compareOverlayPaths } from "./target-apply";

const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_MATERIAL_BYTES = 100 * 1024 * 1024;
const MAX_INSTALLATION_REPOSITORIES = 10_000;

const decimal = z.string().regex(/^[1-9]\d*$/u);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const name = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/u);

const configSchema = z
  .object({
    appId: decimal,
    installationId: decimal,
    privateKey: z.string().min(1).max(32_768),
  })
  .strict();

export type GitHubAppHttpProviderConfig = z.infer<typeof configSchema>;

const credentialsSchema = configSchema.omit({ installationId: true });
export type GitHubAppHttpProviderCredentials = z.infer<
  typeof credentialsSchema
>;

export function parseGitHubAppHttpProviderCredentials(
  input: unknown,
): GitHubAppHttpProviderCredentials {
  const parsed = credentialsSchema.safeParse(input);
  if (!parsed.success)
    throw new Error("GitHub App provider configuration is invalid.");
  try {
    const key = createPrivateKey(parsed.data.privateKey);
    if (key.asymmetricKeyType !== "rsa") throw new Error("not-rsa");
  } catch {
    throw new Error("GitHub App provider configuration is invalid.");
  }
  return parsed.data;
}

export function parseGitHubAppHttpProviderConfig(
  input: unknown,
): GitHubAppHttpProviderConfig {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success)
    throw new Error("GitHub App provider configuration is invalid.");
  const credentials = parseGitHubAppHttpProviderCredentials({
    appId: parsed.data.appId,
    privateKey: parsed.data.privateKey,
  });
  return { ...credentials, installationId: parsed.data.installationId };
}

export type GitHubPublicationFile = {
  path: string;
  mode: "100644" | "100755";
  content: Uint8Array;
};

export interface GitHubAppHttpProvider extends GitHubAppInstallationProvider {
  inspectRepositoryByName(input: {
    owner: string;
    name: string;
  }): Promise<unknown | undefined>;
  acquireRepositoryReadCredential(input: {
    repositoryId: string;
  }): Promise<{ token: string }>;
}

type Fetch = typeof fetch;
type PermissionSnapshot = {
  metadata: "read";
  contents: "read" | "write";
  workflows: "none" | "write";
  pullRequests: "none" | "write";
  administration: "none" | "write";
  variables: "read";
};

const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function property(value: unknown, key: string): unknown {
  if (!record(value) || !(key in value)) throw new Error("invalid-response");
  return value[key];
}

function stringProperty(value: unknown, key: string): string {
  const result = property(value, key);
  if (typeof result !== "string") throw new Error("invalid-response");
  return result;
}

function decimalProperty(value: unknown, key: string): string {
  const result = property(value, key);
  if (
    (typeof result !== "number" ||
      !Number.isSafeInteger(result) ||
      result < 1) &&
    (typeof result !== "string" || !decimal.safeParse(result).success)
  )
    throw new Error("invalid-response");
  return String(result);
}

function safeRepositoryIdNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== value)
    throw new Error("invalid-response");
  return parsed;
}

function booleanProperty(value: unknown, key: string): boolean {
  const result = property(value, key);
  if (typeof result !== "boolean") throw new Error("invalid-response");
  return result;
}

function arrayProperty(value: unknown, key: string): unknown[] {
  const result = property(value, key);
  if (!Array.isArray(result)) throw new Error("invalid-response");
  return result;
}

function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function validateFile(file: GitHubPublicationFile): void {
  if (
    !safeSourcePath(file.path) ||
    (file.mode !== "100644" && file.mode !== "100755") ||
    !(file.content instanceof Uint8Array) ||
    file.content.byteLength > MAX_FILE_BYTES
  )
    throw new Error("invalid-material");
}

function canonicalFiles(
  input: readonly GitHubPublicationFile[],
): readonly GitHubPublicationFile[] {
  if (input.length === 0 || input.length > MAX_FILES)
    throw new Error("invalid-material");
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of input) {
    validateFile(file);
    totalBytes += file.content.byteLength;
    if (
      paths.has(file.path) ||
      [...paths].some(
        (path) =>
          path.startsWith(`${file.path}/`) || file.path.startsWith(`${path}/`),
      )
    )
      throw new Error("invalid-material");
    paths.add(file.path);
  }
  if (totalBytes > MAX_TOTAL_MATERIAL_BYTES)
    throw new Error("invalid-material");
  return [...input].toSorted((left, right) =>
    compareOverlayPaths(left.path, right.path),
  );
}

function permissionRequest(permission: PermissionSnapshot) {
  return {
    metadata: "read" as const,
    contents: permission.contents,
    ...(permission.workflows === "write"
      ? { workflows: "write" as const }
      : {}),
    ...(permission.pullRequests === "write"
      ? { pull_requests: "write" as const }
      : {}),
    ...(permission.administration === "write"
      ? { administration: "write" as const }
      : {}),
    actions_variables: "read" as const,
  };
}

function normalizedPermissions(value: unknown): PermissionSnapshot {
  if (!record(value)) throw new Error("invalid-response");
  const allowed = new Set([
    "metadata",
    "contents",
    "workflows",
    "pull_requests",
    "administration",
    "actions_variables",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new Error("invalid-response");
  const metadata = value.metadata;
  const contents = value.contents;
  const workflows = value.workflows ?? "none";
  const pullRequests = value.pull_requests ?? "none";
  const administration = value.administration ?? "none";
  const variables = value.actions_variables;
  if (
    metadata !== "read" ||
    (contents !== "read" && contents !== "write") ||
    (workflows !== "none" && workflows !== "write") ||
    (pullRequests !== "none" && pullRequests !== "write") ||
    (administration !== "none" && administration !== "write") ||
    variables !== "read"
  )
    throw new Error("invalid-response");
  return {
    metadata,
    contents,
    workflows,
    pullRequests,
    administration,
    variables,
  };
}

function requestId(value: string): string {
  return /^[A-Za-z0-9_-]{1,128}$/u.test(value)
    ? value
    : sha256(value).slice(0, 32);
}

export function createGitHubAppHttpProvider(input: {
  config: GitHubAppHttpProviderConfig;
  fetch?: Fetch;
  now?: () => number;
}): GitHubAppHttpProvider {
  const config = parseGitHubAppHttpProviderConfig(input.config);
  const request = input.fetch ?? fetch;
  const app = createGitHubApp({
    appId: config.appId,
    privateKey: config.privateKey,
    fetch: request,
  });

  async function github(input: {
    method?: "GET" | "POST";
    path: string;
    authorization: string;
    body?: unknown;
    expected: readonly number[];
  }): Promise<{ status: number; body: unknown; requestId: string }> {
    try {
      const response = await createGitHubTokenOctokit({
        token: input.authorization,
        fetch: request,
      }).request(`${input.method ?? "GET"} ${input.path}`, {
        ...(record(input.body) ? input.body : {}),
      });
      if (!input.expected.includes(response.status))
        throw new Error(`github-status-${response.status}`);
      return {
        status: response.status,
        body: response.data,
        requestId: requestId(
          String(response.headers["x-github-request-id"] ?? "github"),
        ),
      };
    } catch (error) {
      const status = record(error) ? error.status : undefined;
      const response = record(error) ? error.response : undefined;
      if (typeof status === "number" && input.expected.includes(status))
        return {
          status,
          body: record(response) ? response.data : undefined,
          requestId: requestId(
            record(response) && record(response.headers)
              ? String(response.headers["x-github-request-id"] ?? "github")
              : "github",
          ),
        };
      throw new Error("github-request-failed");
    }
  }

  async function installation() {
    const { data } = await app.octokit.request(
      "GET /app/installations/{installation_id}",
      { installation_id: Number(config.installationId) },
    );
    const account = property(data, "account");
    const selection = stringProperty(data, "repository_selection");
    const accountType = stringProperty(account, "type");
    if (
      decimalProperty(data, "id") !== config.installationId ||
      (selection !== "all" && selection !== "selected") ||
      (accountType !== "Organization" && accountType !== "User")
    )
      throw new Error("invalid-response");
    return {
      installationId: config.installationId,
      accountId: decimalProperty(account, "id"),
      accountLogin: stringProperty(account, "login"),
      accountType: accountType as "Organization" | "User",
      repositorySelection: selection,
    };
  }

  async function token(
    permissions: PermissionSnapshot,
    repositoryIds?: readonly string[],
  ) {
    const authentication = await app.octokit.auth({
      type: "installation",
      installationId: config.installationId,
      permissions: permissionRequest(permissions),
      ...(repositoryIds === undefined
        ? {}
        : { repositoryIds: repositoryIds.map(safeRepositoryIdNumber) }),
      refresh: true,
    });
    const value = stringProperty(authentication, "token");
    if (value.length < 20 || value.length > 512)
      throw new Error("invalid-response");
    const granted = normalizedPermissions(
      property(authentication, "permissions"),
    );
    if (JSON.stringify(granted) !== JSON.stringify(permissions))
      throw new Error("invalid-response");
    return value;
  }

  async function repositoryReadToken(repositoryId: string) {
    decimal.parse(repositoryId);
    const authentication = await app.octokit.auth({
      type: "installation",
      installationId: config.installationId,
      permissions: { contents: "read" },
      repositoryIds: [safeRepositoryIdNumber(repositoryId)],
      refresh: true,
    });
    const value = stringProperty(authentication, "token");
    if (value.length < 20 || value.length > 512)
      throw new Error("invalid-response");
    const permissions = property(authentication, "permissions");
    if (
      !record(permissions) ||
      permissions.contents !== "read" ||
      (permissions.metadata !== undefined && permissions.metadata !== "read") ||
      Object.keys(permissions).some(
        (key) => key !== "contents" && key !== "metadata",
      )
    )
      throw new Error("invalid-response");
    return value;
  }

  async function selectedRepositories(
    permissions: PermissionSnapshot,
  ): Promise<readonly string[]> {
    const accessToken = await token(permissions);
    const ids: string[] = [];
    for (let page = 1; ; page += 1) {
      const response = await github({
        path: `/installation/repositories?per_page=100&page=${page}`,
        authorization: accessToken,
        expected: [200],
      });
      const repositories = arrayProperty(response.body, "repositories");
      ids.push(
        ...repositories.map((repository) => decimalProperty(repository, "id")),
      );
      if (ids.length > MAX_INSTALLATION_REPOSITORIES)
        throw new Error("installation-too-large");
      if (repositories.length < 100) break;
    }
    return [...new Set(ids)].toSorted();
  }

  async function repositoryById(
    repositoryId: string,
    ref: string,
    permissions: PermissionSnapshot,
  ) {
    decimal.parse(repositoryId);
    const accessToken = await token(permissions, [repositoryId]);
    const repositoryResponse = await github({
      path: `/repositories/${repositoryId}`,
      authorization: accessToken,
      expected: [200],
    });
    const owner = property(repositoryResponse.body, "owner");
    const repositoryOwner = stringProperty(owner, "login");
    const repositoryName = stringProperty(repositoryResponse.body, "name");
    if (
      !name.safeParse(repositoryOwner).success ||
      !name.safeParse(repositoryName).success
    )
      throw new Error("invalid-response");
    const commit = await github({
      path: `/repos/${encodeURIComponent(repositoryOwner)}/${encodeURIComponent(repositoryName)}/commits/${encodePath(ref)}`,
      authorization: accessToken,
      expected: [200],
    });
    const commitData = property(commit.body, "commit");
    const tree = property(commitData, "tree");
    const variableNames: string[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const variables = await github({
        path: `/repos/${encodeURIComponent(repositoryOwner)}/${encodeURIComponent(repositoryName)}/actions/variables?per_page=100&page=${page}`,
        authorization: accessToken,
        expected: [200],
      });
      const pageVariables = arrayProperty(variables.body, "variables");
      variableNames.push(
        ...pageVariables.map((value) => stringProperty(value, "name")),
      );
      if (pageVariables.length < 100) break;
      if (page === 10) throw new Error("repository-variables-too-large");
    }
    if (!booleanProperty(repositoryResponse.body, "private"))
      throw new Error("invalid-response");
    return {
      repositoryId,
      owner: repositoryOwner,
      name: repositoryName,
      visibility: "private" as const,
      defaultBranch: stringProperty(repositoryResponse.body, "default_branch"),
      headSha: objectId.parse(stringProperty(commit.body, "sha")),
      headTree: objectId.parse(stringProperty(tree, "sha")),
      repositoryVariableNames: variableNames.toSorted(),
      accessToken,
    };
  }

  async function repositoryByName(
    owner: string,
    repositoryName: string,
    permissions: PermissionSnapshot,
  ) {
    if (
      !name.safeParse(owner).success ||
      !name.safeParse(repositoryName).success
    )
      throw new Error("invalid-destination");
    const accessToken = await token(permissions);
    let response;
    try {
      response = await github({
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}`,
        authorization: accessToken,
        expected: [200, 404],
      });
    } catch {
      throw new Error("github-request-failed");
    }
    if (response.status === 404) return undefined;
    const repositoryId = decimalProperty(response.body, "id");
    return repositoryById(
      repositoryId,
      stringProperty(response.body, "default_branch"),
      permissions,
    );
  }

  async function createBlob(
    owner: string,
    repositoryName: string,
    accessToken: string,
    file: GitHubPublicationFile,
  ): Promise<string> {
    const response = await github({
      method: "POST",
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}/git/blobs`,
      authorization: accessToken,
      body: {
        content: Buffer.from(file.content).toString("base64"),
        encoding: "base64",
      },
      expected: [201],
    });
    return objectId.parse(stringProperty(response.body, "sha"));
  }

  async function createTree(input: {
    owner: string;
    repositoryName: string;
    accessToken: string;
    files: readonly GitHubPublicationFile[];
    deletions?: readonly string[];
    baseTree?: string;
  }): Promise<string> {
    const entries: Array<{
      path: string;
      mode: "100644" | "100755";
      type: "blob";
      sha: string;
    }> = [];
    for (const file of input.files) {
      entries.push({
        path: file.path,
        mode: file.mode,
        type: "blob",
        sha: await createBlob(
          input.owner,
          input.repositoryName,
          input.accessToken,
          file,
        ),
      });
    }
    const response = await github({
      method: "POST",
      path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repositoryName)}/git/trees`,
      authorization: input.accessToken,
      body: {
        ...(input.baseTree === undefined ? {} : { base_tree: input.baseTree }),
        tree: [
          ...entries,
          ...(input.deletions ?? []).map((path) => ({
            path,
            mode: "100644",
            type: "blob",
            sha: null,
          })),
        ],
      },
      expected: [201],
    });
    return objectId.parse(stringProperty(response.body, "sha"));
  }

  async function repositorySnapshotForProposal(
    proposal: DraftPullRequestProposal,
    permissions: PermissionSnapshot,
  ) {
    const snapshot = await repositoryById(
      proposal.repositoryId,
      proposal.baseBranch,
      permissions,
    );
    return {
      snapshot: publicRepositorySnapshot(snapshot),
      accessToken: snapshot.accessToken,
    };
  }

  function publicRepositorySnapshot(
    snapshot: Awaited<ReturnType<typeof repositoryById>>,
  ) {
    return {
      repositoryId: snapshot.repositoryId,
      owner: snapshot.owner,
      name: snapshot.name,
      visibility: snapshot.visibility,
      defaultBranch: snapshot.defaultBranch,
      headSha: snapshot.headSha,
      headTree: snapshot.headTree,
      repositoryVariableNames: snapshot.repositoryVariableNames,
    };
  }

  return {
    async acquireRepositoryReadCredential({ repositoryId }) {
      try {
        return { token: await repositoryReadToken(repositoryId) };
      } catch {
        throw new Error("GitHub provider operation failed.");
      }
    },
    async inspectInstallation({ requestedPermissions }) {
      const identity = await installation();
      const selectedRepositoryIds =
        await selectedRepositories(requestedPermissions);
      return {
        ...identity,
        selectedRepositoryIds,
        grantedPermissions: requestedPermissions,
      };
    },

    async inspectRepository({ repositoryId, ref }) {
      const permissions: PermissionSnapshot = {
        metadata: "read",
        contents: "read",
        workflows: "none",
        pullRequests: "none",
        administration: "none",
        variables: "read",
      };
      const snapshot = await repositoryById(repositoryId, ref, permissions);
      return publicRepositorySnapshot(snapshot);
    },

    async inspectRepositoryByName({ owner, name: repositoryName }) {
      const permissions: PermissionSnapshot = {
        metadata: "read",
        contents: "read",
        workflows: "none",
        pullRequests: "none",
        administration: "none",
        variables: "read",
      };
      const snapshot = await repositoryByName(
        owner,
        repositoryName,
        permissions,
      );
      if (snapshot === undefined) return undefined;
      const response = await github({
        path: `/repositories/${snapshot.repositoryId}`,
        authorization: snapshot.accessToken,
        expected: [200],
      });
      return {
        ...publicRepositorySnapshot(snapshot),
        archived: booleanProperty(response.body, "archived"),
      };
    },

    async inspectDestination({ owner, name: repositoryName }) {
      const permissions: PermissionSnapshot = {
        metadata: "read",
        contents: "write",
        workflows: "write",
        pullRequests: "none",
        administration: "write",
        variables: "read",
      };
      const snapshot = await repositoryByName(
        owner,
        repositoryName,
        permissions,
      );
      if (snapshot === undefined) return "absent";
      return publicRepositorySnapshot(snapshot);
    },

    async inspectFreshRepositoryOutcome(proposal) {
      assertExactFreshRepositoryProposal(proposal);
      const permissions: PermissionSnapshot = {
        metadata: "read",
        contents: "write",
        workflows: "write",
        pullRequests: "none",
        administration: "write",
        variables: "read",
      };
      const snapshot = await repositoryByName(
        proposal.destinationOwner,
        proposal.destinationName,
        permissions,
      );
      if (snapshot === undefined) return undefined;
      const commit = await github({
        path: `/repos/${encodeURIComponent(proposal.destinationOwner)}/${encodeURIComponent(proposal.destinationName)}/commits/${encodeURIComponent(proposal.defaultBranch)}`,
        authorization: snapshot.accessToken,
        expected: [200],
      });
      const parents = arrayProperty(commit.body, "parents").map((parent) =>
        objectId.parse(stringProperty(parent, "sha")),
      );
      if (
        !stringProperty(property(commit.body, "commit"), "message").includes(
          `App-Builder-Idempotency: ${proposal.idempotencyKey}`,
        )
      )
        throw new Error("fresh-repository-marker-mismatch");
      const repository = publicRepositorySnapshot(snapshot);
      return {
        idempotencyKey: proposal.idempotencyKey,
        repository,
        initialCommit: {
          sha: objectId.parse(stringProperty(commit.body, "sha")),
          tree: repository.headTree,
          parents,
        },
      };
    },

    async createPrivateFreshHistoryRepository(proposal, content) {
      assertExactFreshRepositoryProposal(proposal);
      const identity = await installation();
      if (identity.accountLogin !== proposal.destinationOwner)
        return { status: "rejected", code: "destination-owner" };
      let files: readonly GitHubPublicationFile[];
      try {
        assertExactGitHubFreshRepositoryContent({ proposal, content });
        files = canonicalFiles(
          content.files.map((file) => ({
            path: file.path,
            mode: file.mode,
            content: file.bytes,
          })),
        );
      } catch {
        return {
          status: "rejected",
          code: "invalid-publication-material",
        };
      }
      const permissions: PermissionSnapshot = {
        metadata: "read",
        contents: "write",
        workflows: "write",
        pullRequests: "none",
        administration: "write",
        variables: "read",
      };
      const accessToken = await token(permissions);
      const createPath =
        identity.accountType === "Organization"
          ? `/orgs/${encodeURIComponent(identity.accountLogin)}/repos`
          : "/user/repos";
      const created = await github({
        method: "POST",
        path: createPath,
        authorization: accessToken,
        body: {
          name: proposal.destinationName,
          private: true,
          auto_init: false,
        },
        expected: [201],
      });
      const repositoryId = decimalProperty(created.body, "id");
      const repositoryToken = await token(permissions, [repositoryId]);
      const tree = await createTree({
        owner: proposal.destinationOwner,
        repositoryName: proposal.destinationName,
        accessToken: repositoryToken,
        files,
      });
      if (tree !== proposal.sourceTree) throw new Error("source-tree-mismatch");
      const commit = await github({
        method: "POST",
        path: `/repos/${encodeURIComponent(proposal.destinationOwner)}/${encodeURIComponent(proposal.destinationName)}/git/commits`,
        authorization: repositoryToken,
        body: {
          message: `${proposal.initialCommitMessage}\n\nApp-Builder-Idempotency: ${proposal.idempotencyKey}`,
          tree,
          parents: [],
        },
        expected: [201],
      });
      const commitSha = objectId.parse(stringProperty(commit.body, "sha"));
      const reference = await github({
        method: "POST",
        path: `/repos/${encodeURIComponent(proposal.destinationOwner)}/${encodeURIComponent(proposal.destinationName)}/git/refs`,
        authorization: repositoryToken,
        body: { ref: `refs/heads/${proposal.defaultBranch}`, sha: commitSha },
        expected: [201],
      });
      return { status: "accepted", requestId: reference.requestId };
    },

    async inspectDraftPublication(proposal) {
      assertExactDraftPullRequestProposal(proposal);
      const permissions: PermissionSnapshot = {
        metadata: "read",
        contents: "write",
        workflows: "write",
        pullRequests: "write",
        administration: "none",
        variables: "read",
      };
      const { snapshot, accessToken } = await repositorySnapshotForProposal(
        proposal,
        permissions,
      );
      const compare = await github({
        path: `/repos/${encodeURIComponent(proposal.owner)}/${encodeURIComponent(proposal.name)}/compare/${encodeURIComponent(proposal.baseSha)}...${encodeURIComponent(snapshot.headSha)}`,
        authorization: accessToken,
        expected: [200],
      });
      const changedPathsSinceBase = arrayProperty(compare.body, "files")
        .map((file) => stringProperty(file, "filename"))
        .toSorted();
      let branch: unknown = { status: "absent" };
      let branchSha: string | undefined;
      try {
        const branchResponse = await github({
          path: `/repos/${encodeURIComponent(proposal.owner)}/${encodeURIComponent(proposal.name)}/branches/${encodePath(proposal.branchName)}`,
          authorization: accessToken,
          expected: [200, 404],
        });
        if (branchResponse.status === 200) {
          const commit = property(branchResponse.body, "commit");
          branchSha = objectId.parse(stringProperty(commit, "sha"));
          const branchCommit = await github({
            path: `/repos/${encodeURIComponent(proposal.owner)}/${encodeURIComponent(proposal.name)}/commits/${branchSha}`,
            authorization: accessToken,
            expected: [200],
          });
          const tree = property(property(branchCommit.body, "commit"), "tree");
          const markerMatches = stringProperty(
            property(branchCommit.body, "commit"),
            "message",
          ).includes(`App-Builder-Idempotency: ${proposal.idempotencyKey}`);
          const branchCompare = await github({
            path: `/repos/${encodeURIComponent(proposal.owner)}/${encodeURIComponent(proposal.name)}/compare/${encodeURIComponent(proposal.baseSha)}...${encodeURIComponent(branchSha)}`,
            authorization: accessToken,
            expected: [200],
          });
          const normalizedChangedPaths = arrayProperty(
            branchCompare.body,
            "files",
          )
            .map((file) => stringProperty(file, "filename"))
            .toSorted();
          branch = {
            status: "present",
            branchName: proposal.branchName,
            branchSha,
            branchTree: objectId.parse(stringProperty(tree, "sha")),
            normalizedChangedPaths,
            changedContentDigest: markerMatches
              ? proposal.changedContentDigest
              : "0".repeat(64),
            idempotencyKey: markerMatches
              ? proposal.idempotencyKey
              : "0".repeat(64),
          };
        }
      } catch {
        throw new Error("github-request-failed");
      }
      const pulls = await github({
        path: `/repos/${encodeURIComponent(proposal.owner)}/${encodeURIComponent(proposal.name)}/pulls?state=open&head=${encodeURIComponent(`${proposal.owner}:${proposal.branchName}`)}&base=${encodeURIComponent(proposal.baseBranch)}&per_page=2`,
        authorization: accessToken,
        expected: [200],
      });
      if (!Array.isArray(pulls.body)) throw new Error("invalid-response");
      const candidates = pulls.body;
      if (candidates.length > 1) throw new Error("invalid-response");
      const pull = candidates[0];
      const exactPull =
        pull !== undefined &&
        stringProperty(pull, "title") === proposal.title &&
        stringProperty(pull, "body") ===
          `<!-- App-Builder-Idempotency: ${proposal.idempotencyKey} -->`;
      const pullRequest =
        pull === undefined
          ? { status: "absent" as const }
          : {
              status: "present" as const,
              pullRequestId: decimalProperty(pull, "id"),
              pullRequestNumber: Number(decimalProperty(pull, "number")),
              draft: booleanProperty(pull, "draft"),
              headRepositoryId: decimalProperty(
                property(property(pull, "head"), "repo"),
                "id",
              ),
              headBranch: stringProperty(property(pull, "head"), "ref"),
              headSha: objectId.parse(
                stringProperty(property(pull, "head"), "sha"),
              ),
              baseRepositoryId: decimalProperty(
                property(property(pull, "base"), "repo"),
                "id",
              ),
              baseBranch: stringProperty(property(pull, "base"), "ref"),
              baseSha: objectId.parse(
                stringProperty(property(pull, "base"), "sha"),
              ),
              changeSetDigest: exactPull
                ? proposal.changeSetDigest
                : "0".repeat(64),
              idempotencyKey: exactPull
                ? proposal.idempotencyKey
                : "0".repeat(64),
            };
      return {
        idempotencyKey: proposal.idempotencyKey,
        repository: snapshot,
        changedPathsSinceBase,
        branch,
        pullRequest,
      };
    },

    async publishDraftPullRequest(proposal, content) {
      assertExactDraftPullRequestProposal(proposal);
      let changes: readonly {
        path: string;
        kind: "added" | "modified" | "deleted";
        before?: { mode: string; digest: string };
        after?: GitHubPublicationFile;
      }[];
      try {
        assertExactGitHubDraftPullRequestContent({ proposal, content });
        changes = content.changes.map((change) => ({
          path: change.path,
          kind: change.kind,
          ...(change.kind === "added" ? {} : { before: change.before }),
          ...(change.kind === "deleted"
            ? {}
            : {
                after: {
                  path: change.path,
                  mode: change.after.mode === "755" ? "100755" : "100644",
                  content: change.after.bytes,
                },
              }),
        }));
        if (
          changes.length === 0 ||
          changes.length > MAX_FILES ||
          changes.some((change) => !safeSourcePath(change.path))
        )
          throw new Error("invalid-material");
        const paths = changes
          .map(({ path }) => path)
          .toSorted(compareOverlayPaths);
        if (JSON.stringify(paths) !== JSON.stringify(proposal.approvedPaths))
          throw new Error("invalid-material");
        let totalBytes = 0;
        const receiptChanges = changes
          .map((change) => {
            if (change.after !== undefined) validateFile(change.after);
            totalBytes += change.after?.content.byteLength ?? 0;
            if (change.after !== undefined && change.after.path !== change.path)
              throw new Error("invalid-material");
            const after =
              change.after === undefined
                ? undefined
                : {
                    mode: change.after.mode === "100755" ? "755" : "644",
                    digest: sha256(change.after.content),
                  };
            if (
              (change.kind === "added" &&
                (change.before !== undefined || after === undefined)) ||
              (change.kind === "deleted" &&
                (change.before === undefined || after !== undefined)) ||
              (change.kind === "modified" &&
                (change.before === undefined || after === undefined))
            )
              throw new Error("invalid-material");
            return {
              path: change.path,
              kind: change.kind,
              ...(change.before === undefined ? {} : { before: change.before }),
              ...(after === undefined ? {} : { after }),
            };
          })
          .toSorted((left, right) =>
            compareOverlayPaths(left.path, right.path),
          );
        if (totalBytes > MAX_TOTAL_MATERIAL_BYTES)
          throw new Error("invalid-material");
        if (
          sha256(JSON.stringify(receiptChanges)) !==
          proposal.changedContentDigest
        )
          throw new Error("invalid-material");
      } catch {
        return {
          status: "rejected",
          code: "invalid-publication-material",
        };
      }
      const permissions: PermissionSnapshot = {
        metadata: "read",
        contents: "write",
        workflows: "write",
        pullRequests: "write",
        administration: "none",
        variables: "read",
      };
      const { snapshot, accessToken } = await repositorySnapshotForProposal(
        proposal,
        permissions,
      );
      const files = changes.flatMap((change) =>
        change.after === undefined ? [] : [change.after],
      );
      const deletions = changes.flatMap((change) =>
        change.kind === "deleted" ? [change.path] : [],
      );
      const tree = await createTree({
        owner: proposal.owner,
        repositoryName: proposal.name,
        accessToken,
        files,
        deletions,
        baseTree: proposal.baseTree,
      });
      const marker = `App-Builder-Idempotency: ${proposal.idempotencyKey}`;
      const commit = await github({
        method: "POST",
        path: `/repos/${encodeURIComponent(proposal.owner)}/${encodeURIComponent(proposal.name)}/git/commits`,
        authorization: accessToken,
        body: {
          message: `${proposal.title}\n\n${marker}`,
          tree,
          parents: [proposal.baseSha],
        },
        expected: [201],
      });
      const commitSha = objectId.parse(stringProperty(commit.body, "sha"));
      const reference = await github({
        method: "POST",
        path: `/repos/${encodeURIComponent(proposal.owner)}/${encodeURIComponent(proposal.name)}/git/refs`,
        authorization: accessToken,
        body: { ref: `refs/heads/${proposal.branchName}`, sha: commitSha },
        expected: [201],
      });
      await github({
        method: "POST",
        path: `/repos/${encodeURIComponent(proposal.owner)}/${encodeURIComponent(proposal.name)}/pulls`,
        authorization: accessToken,
        body: {
          title: proposal.title,
          head: proposal.branchName,
          base: proposal.baseBranch,
          body: `<!-- ${marker} -->`,
          draft: true,
        },
        expected: [201],
      });
      return { status: "accepted", requestId: reference.requestId };
    },
  };
}
