import { createHash, createPrivateKey } from "node:crypto";

import { z } from "zod";

import { createGitHubApp, createGitHubTokenOctokit } from "../github/octokit";
import type {
  GitHubAppInstallationProvider,
  GitHubTargetAccessProvider,
} from "./github-app-adapter";
import {
  assertExactGitHubFreshRepositoryContent,
  assertExactGitHubDraftPullRequestContent,
  assertExactDraftPullRequestProposal,
  assertExactFreshRepositoryProposal,
  githubPermissionsFor,
} from "./github-publication";
import type {
  GitHubRepositoryObservation,
  DraftPullRequestProposal,
  GitHubDraftPullRequestContent,
  DraftPublicationReadBack,
  GitHubMutationAcknowledgement,
} from "./github-publication";
import { createGitHubPrDeliveryProvider, GitHubPrEffectRejectedError } from "./github-pr-delivery";
import type { GitHubPrDeliveryProvider } from "./github-pr-delivery";
import { safeSourcePath } from "./source-path";
import { compareOverlayPaths } from "./target-apply";
import type { ExistingDraftObservation, ExistingDraftUpdateProposal } from "./github-draft-update";
import { assertReconciliationContent } from "./github-draft-reconciliation";
import type {
  ExistingDraftInspectionRequest,
  OwnedDraftInspectionRecovery,
  ExistingDraftReconciliationProposal,
  ReconciliationContent,
} from "./github-draft-reconciliation";
import { historicalAppSourceSelectorSchema } from "./historical-app-source";
import type { HistoricalAppSourceObservation } from "./historical-app-source";

interface GitTreeBase {
  base_tree?: string;
}

interface GitHubInstallationAuthPrefix {
  installationId: string;
  permissions: GitHubPermissionRequest;
  repositoryIds?: number[];
}

const invalidProviderConfigurationMessage = "GitHub App provider configuration is invalid.";
const invalidResponseMessage = "invalid-response";
const invalidMaterialMessage = "invalid-material";
const githubRequestFailedMessage = "github-request-failed";
const repositoryIdentityChangedCode = "repository-identity-changed";
const invalidPublicationMaterialCode = "invalid-publication-material";
const reviewedPathChangedCode = "reviewed-path-changed";
const branchMovedCode = "branch-moved";
const pullRequestChangedCode = "pull-request-changed";

const reconciliationCommitMessage = (proposal: ExistingDraftReconciliationProposal): string =>
  `Reconcile draft pull request #${proposal.pullRequestNumber} with ${proposal.baseBranch}\n\nApp-Builder-Idempotency: ${proposal.idempotencyKey}\nApp-Builder-Origin: ${proposal.originMarker}`;

/** The ownership comment is one standalone line, independent of the PR description. */
const existingDraftOriginMarker = (body: string): string | undefined => {
  const markers = new Set(
    body.split(/\r\n?|\n/u).flatMap((line) => {
      const match = /^<!--\s*App-Builder-Idempotency:\s*(?<marker>[0-9a-f]{64})\s*-->$/u.exec(
        line.trim(),
      );
      return match?.groups?.marker === undefined ? [] : [match.groups.marker];
    }),
  );
  return markers.size === 1 ? markers.values().next().value : undefined;
};

class GitHubBlobWriteFailureError extends Error {
  readonly path: string;
  readonly bytes: number;
  readonly providerStatus?: number;

  constructor(path: string, bytes: number, providerStatus?: number) {
    super("github-blob-write-failed");
    this.name = "GitHubBlobWriteFailureError";
    this.path = path;
    this.bytes = bytes;
    this.providerStatus = providerStatus;
  }
}

const providerHttpStatus = (error: unknown): number | undefined => {
  if (!(error instanceof Error)) {
    return;
  }
  const cause: unknown = error.cause;
  if (cause === null || typeof cause !== "object" || !("status" in cause)) {
    return;
  }
  const { status } = cause;
  if (typeof status !== "number" || !Number.isInteger(status)) {
    return;
  }
  return status >= 400 && status <= 599 ? status : undefined;
};

const decimal = z.string().regex(/^[1-9]\d*$/u);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const name = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/u);

const configSchema = z.strictObject({
  appId: decimal,
  installationId: decimal,
  privateKey: z.string().min(1).max(32_768),
});

export type GitHubAppHttpProviderConfig = z.infer<typeof configSchema>;

const credentialsSchema = configSchema.omit({ installationId: true });
export type GitHubAppHttpProviderCredentials = z.infer<typeof credentialsSchema>;

export const parseGitHubAppHttpProviderCredentials = (
  input: unknown,
): GitHubAppHttpProviderCredentials => {
  const parsed = credentialsSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(invalidProviderConfigurationMessage);
  }
  try {
    const key = createPrivateKey(parsed.data.privateKey);
    if (key.asymmetricKeyType !== "rsa") {
      throw new Error("not-rsa");
    }
  } catch {
    throw new Error(invalidProviderConfigurationMessage);
  }
  return parsed.data;
};

export const parseGitHubAppHttpProviderConfig = (input: unknown): GitHubAppHttpProviderConfig => {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(invalidProviderConfigurationMessage);
  }
  const credentials = parseGitHubAppHttpProviderCredentials({
    appId: parsed.data.appId,
    privateKey: parsed.data.privateKey,
  });
  return { ...credentials, installationId: parsed.data.installationId };
};

export interface GitHubPublicationFile {
  path: string;
  mode: "100644" | "100755";
  content: Uint8Array;
}

export interface GitHubAppHttpProvider
  extends GitHubAppInstallationProvider, GitHubTargetAccessProvider {
  prDelivery: GitHubPrDeliveryProvider;
  inspectExistingDraft: (
    input: ExistingDraftInspectionRequest,
  ) => Promise<ExistingDraftObservation>;
  inspectRepositoryByName: (input: { owner: string; name: string }) => Promise<unknown>;
  inspectHistoricalAppSource: (input: {
    repositoryId: string;
    owner: string;
    name: string;
    source: unknown;
  }) => Promise<HistoricalAppSourceObservation>;
  acquireRepositoryReadCredential: (input: { repositoryId: string }) => Promise<{
    token: string;
  }>;
}

type Fetch = typeof fetch;
interface PermissionSnapshot {
  actions?: "read";
  metadata: "read";
  contents: "read" | "write";
  workflows: "none" | "write";
  pullRequests: "none" | "read" | "write";
  administration: "none" | "write";
  variables: "none" | "read";
}

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const property = (value: unknown, key: string): unknown => {
  if (!record(value) || !(key in value)) {
    throw new TypeError(invalidResponseMessage);
  }
  return value[key];
};

const stringProperty = (value: unknown, key: string): string => {
  const result = property(value, key);
  if (typeof result !== "string") {
    throw new TypeError(invalidResponseMessage);
  }
  return result;
};

const decimalProperty = (value: unknown, key: string): string => {
  const result = property(value, key);
  if (typeof result === "number") {
    if (!Number.isSafeInteger(result) || result < 1) {
      throw new TypeError(invalidResponseMessage);
    }
  } else if (typeof result !== "string" || !decimal.safeParse(result).success) {
    throw new TypeError(invalidResponseMessage);
  }
  return String(result);
};

const safeRepositoryIdNumber = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== value) {
    throw new TypeError(invalidResponseMessage);
  }
  return parsed;
};

const booleanProperty = (value: unknown, key: string): boolean => {
  const result = property(value, key);
  if (typeof result !== "boolean") {
    throw new TypeError(invalidResponseMessage);
  }
  return result;
};

const arrayProperty = (value: unknown, key: string): unknown[] => {
  const result = property(value, key);
  if (!Array.isArray(result)) {
    throw new TypeError(invalidResponseMessage);
  }
  return result;
};

const encodePath = (value: string): string => value.split("/").map(encodeURIComponent).join("/");

const validateFile = (file: GitHubPublicationFile): void => {
  if (
    !safeSourcePath(file.path) ||
    (file.mode !== "100644" && file.mode !== "100755") ||
    !(file.content instanceof Uint8Array)
  ) {
    throw new Error(invalidMaterialMessage);
  }
};

const canonicalFiles = (
  input: readonly GitHubPublicationFile[],
): readonly GitHubPublicationFile[] => {
  if (input.length === 0) {
    throw new Error(invalidMaterialMessage);
  }
  interface PathNode {
    children: Map<string, PathNode>;
    file: boolean;
  }
  const root: PathNode = {
    children: new Map(),
    file: false,
  };
  for (const file of input) {
    validateFile(file);
    let node = root;
    for (const segment of file.path.split("/")) {
      if (node.file) {
        throw new Error(invalidMaterialMessage);
      }
      let child = node.children.get(segment);
      if (child === undefined) {
        child = { children: new Map(), file: false };
        node.children.set(segment, child);
      }
      node = child;
    }
    if (node.file || node.children.size > 0) {
      throw new Error(invalidMaterialMessage);
    }
    node.file = true;
  }
  return [...input].toSorted((left, right) => compareOverlayPaths(left.path, right.path));
};

interface GitHubPermissionRequest {
  actions?: "read";
  actions_variables?: "read";
  contents: PermissionSnapshot["contents"];
  metadata: "read";
  workflows?: "write";
  pull_requests?: PermissionSnapshot["pullRequests"];
  administration?: "write";
}

const permissionRequest = (permission: PermissionSnapshot): GitHubPermissionRequest => {
  const optionalActions: Pick<GitHubPermissionRequest, "actions" | "actions_variables"> = {};
  if (permission.actions === "read") {
    optionalActions.actions = "read";
  }
  if (permission.variables === "read") {
    optionalActions.actions_variables = "read";
  }
  const request: GitHubPermissionRequest = {
    ...optionalActions,
    contents: permission.contents,
    metadata: "read",
  };
  if (permission.workflows === "write") {
    request.workflows = "write";
  }
  if (permission.pullRequests !== "none") {
    request.pull_requests = permission.pullRequests;
  }
  if (permission.administration === "write") {
    request.administration = "write";
  }
  return request;
};

const normalizedPermissions = (value: unknown): PermissionSnapshot => {
  if (!record(value)) {
    throw new Error(invalidResponseMessage);
  }
  const allowed = new Set([
    "actions",
    "metadata",
    "contents",
    "workflows",
    "pull_requests",
    "administration",
    "actions_variables",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(invalidResponseMessage);
  }
  const actions = z.literal("read").optional().parse(value.actions);
  const { metadata } = value;
  const { contents } = value;
  const workflows = value.workflows ?? "none";
  const pullRequests = z.enum(["none", "read", "write"]).parse(value.pull_requests ?? "none");
  const administration = value.administration ?? "none";
  const variables = z.enum(["none", "read"]).parse(value.actions_variables ?? "none");
  if (metadata !== "read" || (contents !== "read" && contents !== "write")) {
    throw new Error(invalidResponseMessage);
  }
  if (
    (workflows !== "none" && workflows !== "write") ||
    (administration !== "none" && administration !== "write")
  ) {
    throw new Error(invalidResponseMessage);
  }
  if (actions === "read") {
    return { actions, administration, contents, metadata, pullRequests, variables, workflows };
  }
  return { administration, contents, metadata, pullRequests, variables, workflows };
};

const requestId = (value: string): string =>
  /^[A-Za-z0-9_-]{1,128}$/u.test(value) ? value : sha256(value).slice(0, 32);

const reconciliationMatchesDraft = (
  proposal: ExistingDraftReconciliationProposal,
  draft: ExistingDraftObservation,
): boolean => {
  if (
    proposal.repositoryId !== draft.repositoryId ||
    proposal.owner !== draft.owner ||
    proposal.name !== draft.name ||
    proposal.pullRequestNumber !== draft.number
  ) {
    return false;
  }
  if (
    proposal.pullRequestId !== draft.pullRequestId ||
    draft.headRepositoryId !== proposal.repositoryId ||
    draft.baseRepositoryId !== proposal.repositoryId ||
    !draft.draft
  ) {
    return false;
  }
  if (
    draft.state !== "open" ||
    draft.headBranch !== proposal.branchName ||
    draft.baseBranch !== proposal.baseBranch
  ) {
    return false;
  }
  return draft.verifiedBuilderOrigin?.marker === proposal.originMarker;
};

// Keep provider helpers scoped to the provider factory's contract.
// oxlint-disable-next-line unicorn/consistent-function-scoping
const pullHead = (owner: string, branch: string) => encodeURIComponent(`${owner}:${branch}`);

export const createGitHubAppHttpProvider = (input: {
  config: GitHubAppHttpProviderConfig;
  fetch?: Fetch;
  now?: () => number;
}): GitHubAppHttpProvider => {
  const config = parseGitHubAppHttpProviderConfig(input.config);
  const request = input.fetch ?? fetch;
  const app = createGitHubApp({
    appId: config.appId,
    fetch: request,
    privateKey: config.privateKey,
  });

  const github = async (requestInput: {
    method?: "GET" | "POST" | "PUT";
    path: string;
    authorization: string;
    body?: unknown;
    expected: readonly number[];
  }): Promise<{ status: number; body: unknown; requestId: string }> => {
    try {
      const client = createGitHubTokenOctokit({
        fetch: request,
        token: requestInput.authorization,
      });
      const execute = client.request.bind(client);
      const route = `${requestInput.method ?? "GET"} ${requestInput.path}`;
      const body = record(requestInput.body) ? { ...requestInput.body } : {};
      const response = await execute(route, body);
      if (!requestInput.expected.includes(response.status)) {
        throw new Error(`github-status-${response.status}`);
      }
      return {
        body: response.data,
        requestId: requestId(response.headers["x-github-request-id"] ?? "github"),
        status: response.status,
      };
    } catch (error) {
      const status = record(error) ? error.status : undefined;
      const response = record(error) ? error.response : undefined;
      if (typeof status === "number" && requestInput.expected.includes(status)) {
        return {
          body: record(response) ? response.data : undefined,
          requestId: requestId(
            record(response) && record(response.headers)
              ? String(response.headers["x-github-request-id"] ?? "github")
              : "github",
          ),
          status,
        };
      }
      throw new Error(githubRequestFailedMessage, { cause: error });
    }
  };

  const installation = async () => {
    const { data } = await app.octokit.request("GET /app/installations/{installation_id}", {
      installation_id: Number(config.installationId),
    });
    const account = property(data, "account");
    const selection = stringProperty(data, "repository_selection");
    const accountType = stringProperty(account, "type");
    if (
      decimalProperty(data, "id") !== config.installationId ||
      (selection !== "all" && selection !== "selected")
    ) {
      throw new Error(invalidResponseMessage);
    }
    if (accountType !== "Organization" && accountType !== "User") {
      throw new Error(invalidResponseMessage);
    }
    return {
      accountId: decimalProperty(account, "id"),
      accountLogin: stringProperty(account, "login"),
      accountType,
      installationId: config.installationId,
      repositorySelection: selection,
    };
  };

  const token = async (permissions: PermissionSnapshot, repositoryIds?: readonly string[]) => {
    const { octokit } = app;
    const authenticate = octokit.auth.bind(octokit);
    const prefix: GitHubInstallationAuthPrefix = {
      installationId: config.installationId,
      permissions: permissionRequest(permissions),
    };
    if (repositoryIds !== undefined) {
      prefix.repositoryIds = repositoryIds.map(safeRepositoryIdNumber);
    }
    const authentication = await authenticate({
      ...prefix,
      refresh: true,
      type: "installation",
    });
    const value = stringProperty(authentication, "token");
    if (value.length < 20 || value.length > 512) {
      throw new Error(invalidResponseMessage);
    }
    const granted = normalizedPermissions(property(authentication, "permissions"));
    if (JSON.stringify(granted) !== JSON.stringify(permissions)) {
      throw new Error(invalidResponseMessage);
    }
    return value;
  };

  const repositoryReadToken = async (repositoryId: string) => {
    decimal.parse(repositoryId);
    const authentication = await app.octokit.auth({
      installationId: config.installationId,
      permissions: { contents: "read" },
      refresh: true,
      repositoryIds: [safeRepositoryIdNumber(repositoryId)],
      type: "installation",
    });
    const value = stringProperty(authentication, "token");
    if (value.length < 20 || value.length > 512) {
      throw new Error(invalidResponseMessage);
    }
    const permissions = property(authentication, "permissions");
    if (
      !record(permissions) ||
      permissions.contents !== "read" ||
      (permissions.metadata !== undefined && permissions.metadata !== "read")
    ) {
      throw new Error(invalidResponseMessage);
    }
    if (Object.keys(permissions).some((key) => key !== "contents" && key !== "metadata")) {
      throw new Error(invalidResponseMessage);
    }
    return value;
  };

  const selectedRepositories = async (
    permissions: PermissionSnapshot,
  ): Promise<readonly string[]> => {
    const accessToken = await token(permissions);
    // The v2 installation identity still includes every selected ID. Accumulate
    // one canonical set rather than retaining a page list and a second dedupe copy.
    const ids = new Set<string>();
    for (let page = 1; ; page += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      const response = await github({
        authorization: accessToken,
        expected: [200],
        path: `/installation/repositories?per_page=100&page=${page}`,
      });
      const repositories = arrayProperty(response.body, "repositories");
      for (const repository of repositories) {
        ids.add(decimalProperty(repository, "id"));
      }
      if (repositories.length < 100) {
        break;
      }
    }
    const canonicalIds = [...ids];
    // oxlint-disable-next-line unicorn/no-array-sort -- This fresh array is owned here; avoid a full duplicate inventory.
    canonicalIds.sort();
    return canonicalIds;
  };

  const repositoryById = async (
    repositoryId: string,
    ref: string,
    permissions: PermissionSnapshot,
  ) => {
    decimal.parse(repositoryId);
    const accessToken = await token(permissions, [repositoryId]);
    const repositoryResponse = await github({
      authorization: accessToken,
      expected: [200],
      path: `/repositories/${repositoryId}`,
    });
    const owner = property(repositoryResponse.body, "owner");
    const repositoryOwner = stringProperty(owner, "login");
    const repositoryName = stringProperty(repositoryResponse.body, "name");
    if (!name.safeParse(repositoryOwner).success || !name.safeParse(repositoryName).success) {
      throw new Error(invalidResponseMessage);
    }
    const commit = await github({
      authorization: accessToken,
      expected: [200],
      path: `/repos/${encodeURIComponent(repositoryOwner)}/${encodeURIComponent(repositoryName)}/commits/${encodePath(ref)}`,
    });
    const commitData = property(commit.body, "commit");
    const tree = property(commitData, "tree");
    const variableNames: string[] = [];
    for (let page = 1; ; page += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      const variables = await github({
        authorization: accessToken,
        expected: [200],
        path: `/repos/${encodeURIComponent(repositoryOwner)}/${encodeURIComponent(repositoryName)}/actions/variables?per_page=100&page=${page}`,
      });
      const pageVariables = arrayProperty(variables.body, "variables");
      variableNames.push(...pageVariables.map((value) => stringProperty(value, "name")));
      if (pageVariables.length < 100) {
        break;
      }
    }
    if (!booleanProperty(repositoryResponse.body, "private")) {
      throw new Error(invalidResponseMessage);
    }
    return {
      accessToken,
      defaultBranch: stringProperty(repositoryResponse.body, "default_branch"),
      headSha: objectId.parse(stringProperty(commit.body, "sha")),
      headTree: objectId.parse(stringProperty(tree, "sha")),
      name: repositoryName,
      owner: repositoryOwner,
      repositoryId,
      repositoryVariableNames: variableNames.toSorted(),
      visibility: "private" as const,
    };
  };

  const repositoryByName = async (
    owner: string,
    repositoryName: string,
    permissions: PermissionSnapshot,
  ) => {
    if (!name.safeParse(owner).success || !name.safeParse(repositoryName).success) {
      throw new Error("invalid-destination");
    }
    const accessToken = await token(permissions);
    let response;
    try {
      response = await github({
        authorization: accessToken,
        expected: [200, 404],
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}`,
      });
    } catch {
      throw new Error(githubRequestFailedMessage);
    }
    if (response.status === 404) {
      return;
    }
    const repositoryId = decimalProperty(response.body, "id");
    return await repositoryById(
      repositoryId,
      stringProperty(response.body, "default_branch"),
      permissions,
    );
  };

  const createBlob = async (
    owner: string,
    repositoryName: string,
    accessToken: string,
    file: GitHubPublicationFile,
  ): Promise<string> => {
    try {
      const response = await github({
        authorization: accessToken,
        body: {
          content: Buffer.from(file.content).toString("base64"),
          encoding: "base64",
        },
        expected: [201],
        method: "POST",
        path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}/git/blobs`,
      });
      return objectId.parse(stringProperty(response.body, "sha"));
    } catch (error) {
      throw new GitHubBlobWriteFailureError(
        file.path,
        file.content.byteLength,
        providerHttpStatus(error),
      );
    }
  };

  const createTree = async (treeInput: {
    owner: string;
    repositoryName: string;
    accessToken: string;
    files: readonly GitHubPublicationFile[];
    deletions?: readonly string[];
    baseTree?: string;
  }): Promise<string> => {
    const entries: {
      path: string;
      mode: "100644" | "100755";
      type: "blob";
      sha: string;
    }[] = [];
    for (const file of treeInput.files) {
      entries.push({
        mode: file.mode,
        path: file.path,
        // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
        sha: await createBlob(
          treeInput.owner,
          treeInput.repositoryName,
          treeInput.accessToken,
          file,
        ),
        type: "blob",
      });
    }
    const { accessToken: authorization } = treeInput;
    const treeBase: GitTreeBase = {};
    if (treeInput.baseTree !== undefined) {
      treeBase.base_tree = treeInput.baseTree;
    }
    const response = await github({
      authorization,
      body: {
        ...treeBase,
        tree: [
          ...entries,
          ...(treeInput.deletions ?? []).map((path) => ({
            mode: "100644",
            path,
            sha: null,
            type: "blob",
          })),
        ],
      },
      expected: [201],
      method: "POST",
      path: `/repos/${encodeURIComponent(treeInput.owner)}/${encodeURIComponent(treeInput.repositoryName)}/git/trees`,
    });
    return objectId.parse(stringProperty(response.body, "sha"));
  };

  const destinationSnapshot = async (repository: GitHubRepositoryObservation) => {
    decimal.parse(repository.repositoryId);
    objectId.parse(repository.headSha);
    objectId.parse(repository.headTree);
    const accessToken = await repositoryReadToken(repository.repositoryId);
    const observed = await github({
      authorization: accessToken,
      expected: [200],
      path: `/repositories/${repository.repositoryId}`,
    });
    if (
      String(property(observed.body, "id")) !== repository.repositoryId ||
      stringProperty(property(observed.body, "owner"), "login") !== repository.owner ||
      stringProperty(observed.body, "name") !== repository.name ||
      !booleanProperty(observed.body, "private")
    ) {
      throw new Error(invalidResponseMessage);
    }
    const commit = await github({
      authorization: accessToken,
      expected: [200],
      path: `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/commits/${repository.headSha}`,
    });
    if (
      stringProperty(commit.body, "sha") !== repository.headSha ||
      stringProperty(property(commit.body, "tree"), "sha") !== repository.headTree
    ) {
      throw new Error(invalidResponseMessage);
    }
    return accessToken;
  };

  const destinationTreeReader = (repository: GitHubRepositoryObservation, accessToken: string) => {
    const trees = new Map<string, unknown[]>();
    return async (treeSha: string): Promise<unknown[]> => {
      const existing = trees.get(treeSha);
      if (existing !== undefined) {
        return existing;
      }
      const tree = await github({
        authorization: accessToken,
        expected: [200],
        path: `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/trees/${treeSha}`,
      });
      if (booleanProperty(tree.body, "truncated")) {
        throw new Error(invalidResponseMessage);
      }
      const entries = arrayProperty(tree.body, "tree");
      trees.set(treeSha, entries);
      return entries;
    };
  };

  const readDestinationPath = async (
    repository: GitHubRepositoryObservation,
    path: string,
    accessToken: string,
    readTree: (treeSha: string) => Promise<unknown[]>,
  ) => {
    let treeSha = repository.headTree;
    const segments = path.split("/");
    for (const [index, segment] of segments.entries()) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- traverse immutable Git trees in path order
      const entries = await readTree(treeSha);
      const entry = entries.find((candidate) => stringProperty(candidate, "path") === segment);
      if (entry === undefined) {
        return null;
      }
      if (index < segments.length - 1) {
        if (stringProperty(entry, "type") !== "tree") {
          throw new Error(invalidResponseMessage);
        }
        treeSha = objectId.parse(stringProperty(entry, "sha"));
        continue;
      }
      const gitMode = z.enum(["100644", "100755"]).parse(stringProperty(entry, "mode"));
      if (stringProperty(entry, "type") !== "blob") {
        throw new Error(invalidResponseMessage);
      }
      const blobSha = objectId.parse(stringProperty(entry, "sha"));
      // oxlint-disable-next-line eslint/no-await-in-loop -- read the resolved immutable blob
      const blob = await github({
        authorization: accessToken,
        expected: [200],
        path: `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/blobs/${blobSha}`,
      });
      if (
        stringProperty(blob.body, "sha") !== blobSha ||
        stringProperty(blob.body, "encoding") !== "base64"
      ) {
        throw new Error(invalidResponseMessage);
      }
      const encoded = stringProperty(blob.body, "content").replaceAll(/\s/gu, "");
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded) {
        throw new Error(invalidResponseMessage);
      }
      return {
        bytes: new Uint8Array(bytes),
        digest: sha256(bytes),
        mode: gitMode === "100644" ? ("644" as const) : ("755" as const),
      };
    }
    throw new Error(invalidResponseMessage);
  };

  const reviewedPreimageMatches = async (preimage: {
    accessToken: string;
    owner: string;
    repositoryName: string;
    headSha: string;
    headTree: string;
    change: { path: string; before?: { mode: string; digest: string } };
  }): Promise<boolean> => {
    const segments = preimage.change.path.split("/");
    let treeSha = preimage.headTree;
    let entry: unknown;
    for (const [index, segment] of segments.entries()) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- walk the exact Git tree path before mutation
      const treeResponse = await github({
        authorization: preimage.accessToken,
        expected: [200],
        path: `/repos/${encodeURIComponent(preimage.owner)}/${encodeURIComponent(preimage.repositoryName)}/git/trees/${encodeURIComponent(treeSha)}`,
      });
      if (booleanProperty(treeResponse.body, "truncated")) {
        throw new Error(invalidResponseMessage);
      }
      const entries = arrayProperty(treeResponse.body, "tree");
      entry = entries.find((candidate) => stringProperty(candidate, "path") === segment);
      if (entry === undefined) {
        return preimage.change.before === undefined;
      }
      if (index < segments.length - 1) {
        if (stringProperty(entry, "type") !== "tree") {
          return false;
        }
        treeSha = objectId.parse(stringProperty(entry, "sha"));
      }
    }
    if (entry === undefined || stringProperty(entry, "type") !== "blob") {
      return false;
    }
    if (preimage.change.before === undefined) {
      return false;
    }
    const mode = stringProperty(entry, "mode");
    const blobSha = objectId.parse(stringProperty(entry, "sha"));
    const blobResponse = await github({
      authorization: preimage.accessToken,
      expected: [200],
      path: `/repos/${encodeURIComponent(preimage.owner)}/${encodeURIComponent(preimage.repositoryName)}/git/blobs/${encodeURIComponent(blobSha)}`,
    });
    if (stringProperty(blobResponse.body, "encoding") !== "base64") {
      throw new Error(invalidResponseMessage);
    }
    const encoded = stringProperty(blobResponse.body, "content").replaceAll(/\s/gu, "");
    const bytes = Buffer.from(encoded, "base64");
    return (
      mode === `100${preimage.change.before.mode}` &&
      sha256(bytes) === preimage.change.before.digest
    );
  };

  // Keep the repository projection local to this provider.
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const publicRepositorySnapshot = (snapshot: Awaited<ReturnType<typeof repositoryById>>) => ({
    defaultBranch: snapshot.defaultBranch,
    headSha: snapshot.headSha,
    headTree: snapshot.headTree,
    name: snapshot.name,
    owner: snapshot.owner,
    repositoryId: snapshot.repositoryId,
    repositoryVariableNames: snapshot.repositoryVariableNames,
    visibility: snapshot.visibility,
  });

  const repositorySnapshotForProposal = async (
    proposal: DraftPullRequestProposal,
    permissions: PermissionSnapshot,
  ) => {
    const snapshot = await repositoryById(proposal.repositoryId, proposal.baseBranch, permissions);
    return {
      accessToken: snapshot.accessToken,
      snapshot: publicRepositorySnapshot(snapshot),
    };
  };

  const draftPermissions: PermissionSnapshot = {
    administration: "none",
    contents: "write",
    metadata: "read",
    pullRequests: "write",
    variables: "read",
    workflows: "write",
  };

  const exactReconciliationHead = async (
    proposal: ExistingDraftReconciliationProposal,
    draft: ExistingDraftObservation,
    accessToken: string,
  ): Promise<boolean> => {
    if (!reconciliationMatchesDraft(proposal, draft) || draft.headTree !== proposal.resolvedTree) {
      return false;
    }
    const applied = await github({
      authorization: accessToken,
      expected: [200],
      path: `/repos/${encodeURIComponent(draft.owner)}/${encodeURIComponent(draft.name)}/git/commits/${draft.headSha}`,
    });
    const parents = property(applied.body, "parents");
    if (!Array.isArray(parents) || parents.length !== 2) {
      return false;
    }
    return (
      stringProperty(parents[0], "sha") === proposal.expectedHeadSha &&
      stringProperty(parents[1], "sha") === proposal.expectedBaseSha &&
      stringProperty(property(applied.body, "tree"), "sha") === proposal.resolvedTree &&
      stringProperty(applied.body, "message") === reconciliationCommitMessage(proposal)
    );
  };

  const ownedDraftHead = async (
    recovery: OwnedDraftInspectionRecovery | undefined,
    draft: ExistingDraftObservation,
    accessToken: string,
  ): Promise<boolean> => {
    if (
      recovery === undefined ||
      draft.verifiedBuilderOrigin === undefined ||
      !draft.draft ||
      draft.state !== "open"
    ) {
      return false;
    }
    if (
      draft.headRepositoryId !== draft.repositoryId ||
      draft.baseRepositoryId !== draft.repositoryId
    ) {
      return false;
    }
    // Only provider-verified published markers enter this list. An acknowledged current
    // result can support recording retries; an unacknowledged proposal must prove its parent.
    for (const proposal of recovery.reconciliations) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Stop at the first exact result; later GitHub reads are unnecessary once ownership is proven.
      const exact = await exactReconciliationHead(proposal, draft, accessToken);
      if (!exact) {
        continue;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- Verify tenant ownership only after this candidate's exact provider readback succeeds.
      if (await recovery.verifyOwnedHead(draft, proposal)) {
        return true;
      }
    }
    return await recovery.verifyOwnedHead(draft);
  };

  const provenDraftHead = async (
    draftRequest: ExistingDraftInspectionRequest,
    observed: ExistingDraftObservation,
    snapshotHeadSha: string,
    accessToken: string,
  ): Promise<boolean> => {
    const { reconciliation } = draftRequest;
    if (await ownedDraftHead(draftRequest.recovery, observed, accessToken)) {
      return true;
    }
    if (
      reconciliation === undefined ||
      !(await exactReconciliationHead(reconciliation, observed, accessToken))
    ) {
      return false;
    }
    // The original result readback can use its exact prior snapshot. A later operation
    // proves its actual approved parent independently when GitHub's snapshot is older.
    if (snapshotHeadSha === reconciliation.expectedHeadSha) {
      return true;
    }
    if (draftRequest.recovery === undefined) {
      return false;
    }
    const baselineCommit = await github({
      authorization: accessToken,
      expected: [200],
      path: `/repos/${encodeURIComponent(draftRequest.owner)}/${encodeURIComponent(draftRequest.name)}/commits/${reconciliation.expectedHeadSha}`,
    });
    const baselineTree = objectId.parse(
      stringProperty(property(property(baselineCommit.body, "commit"), "tree"), "sha"),
    );
    const message = stringProperty(property(baselineCommit.body, "commit"), "message");
    const marker = observed.verifiedBuilderOrigin?.marker;
    if (
      marker === undefined ||
      baselineTree !== reconciliation.expectedHeadTree ||
      !(
        message.includes(`App-Builder-Idempotency: ${marker}`) ||
        message.includes(`App-Builder-Origin: ${marker}`)
      )
    ) {
      return false;
    }
    return await ownedDraftHead(
      draftRequest.recovery,
      { ...observed, headSha: reconciliation.expectedHeadSha, headTree: baselineTree },
      accessToken,
    );
  };

  // oxlint-disable-next-line eslint/complexity -- verify the repository, PR, branch, and Builder-authored origin in one read
  const inspectExistingDraft = async (draftRequest: ExistingDraftInspectionRequest) => {
    if (!Number.isSafeInteger(draftRequest.number) || draftRequest.number < 1) {
      throw new Error("invalid-pull-request-number");
    }
    const repository = await repositoryById(draftRequest.repositoryId, "HEAD", draftPermissions);
    if (repository.owner !== draftRequest.owner || repository.name !== draftRequest.name) {
      throw new Error(repositoryIdentityChangedCode);
    }
    const pull = await github({
      authorization: repository.accessToken,
      expected: [200],
      path: `/repos/${encodeURIComponent(draftRequest.owner)}/${encodeURIComponent(draftRequest.name)}/pulls/${draftRequest.number}`,
    });
    const head = property(pull.body, "head");
    const base = property(pull.body, "base");
    const headBranch = stringProperty(head, "ref");
    const snapshotHeadSha = objectId.parse(stringProperty(head, "sha"));
    const readLiveHead = async () => {
      const reference = await github({
        authorization: repository.accessToken,
        expected: [200],
        path: `/repos/${encodeURIComponent(draftRequest.owner)}/${encodeURIComponent(draftRequest.name)}/git/ref/heads/${encodePath(headBranch)}`,
      });
      return objectId.parse(stringProperty(property(reference.body, "object"), "sha"));
    };
    // GitHub retains the merged pull's head even after deleting its branch.
    const mergedReconciliation =
      draftRequest.reconciliation !== undefined &&
      record(pull.body) &&
      pull.body.state === "closed" &&
      pull.body.merged === true;
    const headSha = mergedReconciliation ? snapshotHeadSha : await readLiveHead();
    const stalePull = headSha !== snapshotHeadSha;
    const commit = await github({
      authorization: repository.accessToken,
      expected: [200],
      path: `/repos/${encodeURIComponent(draftRequest.owner)}/${encodeURIComponent(draftRequest.name)}/commits/${headSha}`,
    });
    const marker = existingDraftOriginMarker(String(record(pull.body) ? pull.body.body : ""));
    let verifiedBuilderOrigin: { appId: string; authorId: string; marker: string } | undefined;
    if (marker !== undefined) {
      const appInfo = await app.octokit.request("GET /app");
      const appId = decimalProperty(appInfo.data, "id");
      const appSlug = stringProperty(appInfo.data, "slug");
      const author = property(pull.body, "user");
      const commitMessage = stringProperty(property(commit.body, "commit"), "message");
      const verifiedAuthor =
        appId === config.appId &&
        stringProperty(author, "type") === "Bot" &&
        stringProperty(author, "login") === `${appSlug}[bot]` &&
        headBranch === `app-builder/review-${marker.slice(0, 20)}`;
      if (
        verifiedAuthor &&
        (commitMessage.includes(`App-Builder-Idempotency: ${marker}`) ||
          commitMessage.includes(`App-Builder-Origin: ${marker}`))
      ) {
        verifiedBuilderOrigin = {
          appId,
          authorId: decimalProperty(author, "id"),
          marker,
        };
      }
    }
    const observed: ExistingDraftObservation = {
      baseBranch: stringProperty(base, "ref"),
      baseRepositoryId: decimalProperty(property(base, "repo"), "id"),
      draft: booleanProperty(pull.body, "draft"),
      headBranch,
      headRepositoryId: decimalProperty(property(head, "repo"), "id"),
      headSha,
      headTree: objectId.parse(
        stringProperty(property(property(commit.body, "commit"), "tree"), "sha"),
      ),
      name: repository.name,
      number: Number(decimalProperty(pull.body, "number")),
      owner: repository.owner,
      pullRequestId: decimalProperty(pull.body, "id"),
      repositoryId: repository.repositoryId,
      state: z.enum(["open", "closed"]).parse(stringProperty(pull.body, "state")),
    };
    if (verifiedBuilderOrigin !== undefined) {
      observed.verifiedBuilderOrigin = verifiedBuilderOrigin;
    }
    if (stalePull) {
      if (
        !(await provenDraftHead(draftRequest, observed, snapshotHeadSha, repository.accessToken))
      ) {
        throw new Error("pull-request-head-out-of-date");
      }
      const confirmed = await github({
        authorization: repository.accessToken,
        expected: [200],
        path: `/repos/${encodeURIComponent(draftRequest.owner)}/${encodeURIComponent(draftRequest.name)}/git/ref/heads/${encodePath(headBranch)}`,
      });
      if (objectId.parse(stringProperty(property(confirmed.body, "object"), "sha")) !== headSha) {
        throw new Error("pull-request-head-out-of-date");
      }
    }
    return observed;
  };

  const inspectHistoricalAppSource = async (sourceRequest: {
    repositoryId: string;
    owner: string;
    name: string;
    source: unknown;
  }): Promise<HistoricalAppSourceObservation> => {
    const source = historicalAppSourceSelectorSchema.parse(sourceRequest.source);
    const authorization = await repositoryReadToken(sourceRequest.repositoryId);
    const repositoryResponse = await github({
      authorization,
      expected: [200],
      path: `/repositories/${encodeURIComponent(sourceRequest.repositoryId)}`,
    });
    const repositoryId = decimalProperty(repositoryResponse.body, "id");
    const repositoryOwner = stringProperty(property(repositoryResponse.body, "owner"), "login");
    const repositoryName = stringProperty(repositoryResponse.body, "name");
    if (
      repositoryId !== sourceRequest.repositoryId ||
      repositoryOwner !== sourceRequest.owner ||
      repositoryName !== sourceRequest.name
    ) {
      throw new Error("historical-source-repository-mismatch");
    }

    let commitSha: string;
    let pullRequestNumber: number | undefined;
    if (source.kind === "commit") {
      const { commitSha: selectedCommitSha } = source;
      commitSha = selectedCommitSha;
    } else {
      const pull = await github({
        authorization,
        expected: [200],
        path: `/repos/${encodeURIComponent(repositoryOwner)}/${encodeURIComponent(repositoryName)}/pulls/${source.pullRequestNumber}`,
      });
      const base = property(pull.body, "base");
      const head = property(pull.body, "head");
      const baseRepository = property(base, "repo");
      const headRepository = property(head, "repo");
      const baseOwner = stringProperty(property(baseRepository, "owner"), "login");
      const headOwner = stringProperty(property(headRepository, "owner"), "login");
      const baseName = stringProperty(baseRepository, "name");
      const headName = stringProperty(headRepository, "name");
      const headSha = objectId.parse(stringProperty(head, "sha"));
      const invalidHistoricalPullRequest =
        "historical-source-pull-request-not-merged-in-repository";
      if (
        stringProperty(pull.body, "state") !== "closed" ||
        typeof property(pull.body, "merged_at") !== "string" ||
        decimalProperty(pull.body, "number") !== String(source.pullRequestNumber) ||
        decimalProperty(baseRepository, "id") !== repositoryId
      ) {
        throw new Error(invalidHistoricalPullRequest);
      }
      if (
        decimalProperty(headRepository, "id") !== repositoryId ||
        baseOwner !== repositoryOwner ||
        headOwner !== repositoryOwner ||
        baseName !== repositoryName
      ) {
        throw new Error(invalidHistoricalPullRequest);
      }
      if (headName !== repositoryName) {
        throw new Error(invalidHistoricalPullRequest);
      }
      commitSha = headSha;
      const { pullRequestNumber: selectedPullRequestNumber } = source;
      pullRequestNumber = selectedPullRequestNumber;
    }

    const commit = await github({
      authorization,
      expected: [200],
      path: `/repos/${encodeURIComponent(repositoryOwner)}/${encodeURIComponent(repositoryName)}/commits/${commitSha}`,
    });
    if (objectId.parse(stringProperty(commit.body, "sha")) !== commitSha) {
      throw new Error("historical-source-commit-mismatch");
    }
    const treeSha = objectId.parse(
      stringProperty(property(property(commit.body, "commit"), "tree"), "sha"),
    );
    const sourceObservation: Pick<
      HistoricalAppSourceObservation,
      "commitSha" | "name" | "owner" | "pullRequestNumber"
    > = { commitSha, name: repositoryName, owner: repositoryOwner };
    if (pullRequestNumber !== undefined) {
      sourceObservation.pullRequestNumber = pullRequestNumber;
    }
    return { ...sourceObservation, repositoryId, treeSha };
  };

  const inspectedUpdateTree = async (
    proposal: ExistingDraftUpdateProposal,
    content: GitHubDraftPullRequestContent,
    accessToken: string,
  ) => {
    const files = content.changes.flatMap((change) =>
      change.kind === "deleted"
        ? []
        : [
            {
              content: change.after.bytes,
              mode: change.after.mode === "755" ? ("100755" as const) : ("100644" as const),
              path: change.path,
            },
          ],
    );
    const deletions = content.changes.flatMap((change) =>
      change.kind === "deleted" ? [change.path] : [],
    );
    return await createTree({
      accessToken,
      baseTree: proposal.expectedHeadTree,
      deletions,
      files,
      owner: proposal.owner,
      repositoryName: proposal.name,
    });
  };

  return {
    prDelivery: createGitHubPrDeliveryProvider(async (ref, operation) => {
      decimal.parse(ref.repositoryId);
      name.parse(ref.owner);
      name.parse(ref.name);
      if (!Number.isSafeInteger(ref.pullRequestNumber) || ref.pullRequestNumber < 1) {
        throw new Error("invalid-pull-request-number");
      }
      objectId.parse(ref.headSha);
      const accessToken = await token(
        {
          actions: "read",
          administration: "none",
          contents: operation === "read" ? "read" : "write",
          metadata: "read",
          pullRequests: operation === "ready" ? "write" : "read",
          variables: "none",
          workflows: "none",
        },
        [ref.repositoryId],
      );
      const repository = await github({
        authorization: accessToken,
        expected: [200],
        path: `/repositories/${ref.repositoryId}`,
      });
      if (
        decimalProperty(repository.body, "id") !== ref.repositoryId ||
        stringProperty(property(repository.body, "owner"), "login") !== ref.owner ||
        stringProperty(repository.body, "name") !== ref.name
      ) {
        throw new Error(repositoryIdentityChangedCode);
      }
      return async ({ effect, ...requestInput }) => {
        try {
          const { body } = await github({
            ...requestInput,
            authorization: accessToken,
            expected: [200],
          });
          return body;
        } catch (error) {
          const status = providerHttpStatus(error);
          const accessRejected = status === 401 || status === 403 || status === 404;
          const mergeRejected =
            effect === "merge" && (status === 405 || status === 409 || status === 422);
          if (effect !== undefined && (accessRejected || mergeRejected)) {
            throw new GitHubPrEffectRejectedError("provider-rejected");
          }
          throw error;
        }
      };
    }),
    async acquireRepositoryReadCredential({ repositoryId }) {
      try {
        return { token: await repositoryReadToken(repositoryId) };
      } catch {
        throw new Error(
          "GitHub could not acquire read access to the selected repository. Check that the GitHub App installation includes this repository and grants contents read access, then reconnect GitHub and retry.",
        );
      }
    },
    async createPrivateFreshHistoryRepository(proposal, content) {
      assertExactFreshRepositoryProposal(proposal);
      const identity = await installation();
      if (identity.accountLogin !== proposal.destinationOwner) {
        return { code: "destination-owner", status: "rejected" };
      }
      let files: readonly GitHubPublicationFile[];
      try {
        assertExactGitHubFreshRepositoryContent({ content, proposal });
        files = canonicalFiles(
          content.files.map((file) => ({
            content: file.bytes,
            mode: file.mode,
            path: file.path,
          })),
        );
      } catch {
        return {
          code: invalidPublicationMaterialCode,
          status: "rejected",
        };
      }
      const permissions: PermissionSnapshot = {
        administration: "write",
        contents: "write",
        metadata: "read",
        pullRequests: "none",
        variables: "read",
        workflows: "write",
      };
      const accessToken = await token(permissions);
      const createPath =
        identity.accountType === "Organization"
          ? `/orgs/${encodeURIComponent(identity.accountLogin)}/repos`
          : "/user/repos";
      const created = await github({
        authorization: accessToken,
        body: {
          auto_init: false,
          name: proposal.destinationName,
          private: true,
        },
        expected: [201],
        method: "POST",
        path: createPath,
      });
      const repositoryId = decimalProperty(created.body, "id");
      const repositoryToken = await token(permissions, [repositoryId]);
      const tree = await createTree({
        accessToken: repositoryToken,
        files,
        owner: proposal.destinationOwner,
        repositoryName: proposal.destinationName,
      });
      if (tree !== proposal.sourceTree) {
        throw new Error("source-tree-mismatch");
      }
      const commit = await github({
        authorization: repositoryToken,
        body: {
          message: `${proposal.initialCommitMessage}\n\nApp-Builder-Idempotency: ${proposal.idempotencyKey}`,
          parents: [],
          tree,
        },
        expected: [201],
        method: "POST",
        path: `/repos/${encodeURIComponent(proposal.destinationOwner)}/${encodeURIComponent(proposal.destinationName)}/git/commits`,
      });
      const commitSha = objectId.parse(stringProperty(commit.body, "sha"));
      const reference = await github({
        authorization: repositoryToken,
        body: { ref: `refs/heads/${proposal.defaultBranch}`, sha: commitSha },
        expected: [201],
        method: "POST",
        path: `/repos/${encodeURIComponent(proposal.destinationOwner)}/${encodeURIComponent(proposal.destinationName)}/git/refs`,
      });
      return { requestId: reference.requestId, status: "accepted" };
    },
    async inspectAppliedDraftReconciliation(proposal, observed, recovery) {
      if (
        observed.headSha === proposal.expectedHeadSha ||
        observed.headTree !== proposal.resolvedTree ||
        observed.headRepositoryId !== proposal.repositoryId
      ) {
        return false;
      }
      const inspection: ExistingDraftInspectionRequest = {
        name: proposal.name,
        number: proposal.pullRequestNumber,
        owner: proposal.owner,
        repositoryId: proposal.repositoryId,
        reconciliation: proposal,
      };
      if (recovery !== undefined) {
        inspection.recovery = recovery;
      }
      const current = await inspectExistingDraft(inspection);
      if (current.headSha !== observed.headSha || current.headTree !== observed.headTree) {
        return false;
      }
      const accessToken = await token(draftPermissions, [proposal.repositoryId]);
      const response = await github({
        authorization: accessToken,
        expected: [200],
        path: `/repos/${encodeURIComponent(proposal.owner)}/${encodeURIComponent(proposal.name)}/git/commits/${observed.headSha}`,
      });
      const parents = property(response.body, "parents");
      if (!Array.isArray(parents) || parents.length !== 2) {
        return false;
      }
      return (
        stringProperty(parents[0], "sha") === proposal.expectedHeadSha &&
        stringProperty(parents[1], "sha") === proposal.expectedBaseSha &&
        stringProperty(property(response.body, "tree"), "sha") === proposal.resolvedTree &&
        stringProperty(response.body, "message") === reconciliationCommitMessage(proposal)
      );
    },
    async inspectAppliedDraftUpdate(proposal, content, observed) {
      try {
        assertExactGitHubDraftPullRequestContent({ content, proposal });
      } catch {
        return false;
      }
      if (
        observed.headSha === proposal.expectedHeadSha ||
        observed.headRepositoryId !== proposal.repositoryId
      ) {
        return false;
      }
      const current = await inspectExistingDraft({
        name: proposal.name,
        number: proposal.pullRequestNumber,
        owner: proposal.owner,
        repositoryId: proposal.repositoryId,
      });
      if (current.headSha !== observed.headSha || current.headTree !== observed.headTree) {
        return false;
      }
      const accessToken = await token(draftPermissions, [proposal.repositoryId]);
      const expectedTree = await inspectedUpdateTree(proposal, content, accessToken);
      if (observed.headTree !== expectedTree) {
        return false;
      }
      const response = await github({
        authorization: accessToken,
        expected: [200],
        path: `/repos/${encodeURIComponent(proposal.owner)}/${encodeURIComponent(proposal.name)}/git/commits/${observed.headSha}`,
      });
      const parents = property(response.body, "parents");
      const expectedMessage = `Update draft pull request #${proposal.pullRequestNumber}\n\nApp-Builder-Idempotency: ${proposal.idempotencyKey}\nApp-Builder-Origin: ${proposal.originMarker}`;
      if (!Array.isArray(parents) || parents.length !== 1) {
        return false;
      }
      return (
        stringProperty(parents[0], "sha") === proposal.expectedHeadSha &&
        stringProperty(property(response.body, "tree"), "sha") === expectedTree &&
        stringProperty(response.body, "message") === expectedMessage
      );
    },
    async inspectAppliedDraftRepair(proposal, resolvedTree, observed) {
      if (
        observed.headSha === proposal.expectedHeadSha ||
        observed.headTree !== resolvedTree ||
        observed.headRepositoryId !== proposal.repositoryId
      )
        return false;
      const current = await inspectExistingDraft({
        repositoryId: proposal.repositoryId,
        owner: proposal.owner,
        name: proposal.name,
        number: proposal.pullRequestNumber,
      });
      if (current.headSha !== observed.headSha || current.headTree !== observed.headTree)
        return false;
      const accessToken = await token(draftPermissions, [proposal.repositoryId]);
      const response = await github({
        authorization: accessToken,
        expected: [200],
        path: `/repos/${encodeURIComponent(proposal.owner)}/${encodeURIComponent(proposal.name)}/git/commits/${observed.headSha}`,
      });
      const parents = property(response.body, "parents");
      const message = `Update draft pull request #${proposal.pullRequestNumber}\n\nApp-Builder-Idempotency: ${proposal.idempotencyKey}\nApp-Builder-Origin: ${proposal.originMarker}`;
      if (!Array.isArray(parents) || parents.length !== 1) {
        return false;
      }
      return (
        stringProperty(parents[0], "sha") === proposal.expectedHeadSha &&
        stringProperty(property(response.body, "tree"), "sha") === resolvedTree &&
        stringProperty(response.body, "message") === message
      );
    },
    async inspectDestination({ owner, name: repositoryName }) {
      const permissions: PermissionSnapshot = {
        administration: "write",
        contents: "write",
        metadata: "read",
        pullRequests: "none",
        variables: "read",
        workflows: "write",
      };
      const snapshot = await repositoryByName(owner, repositoryName, permissions);
      if (snapshot === undefined) {
        return "absent";
      }
      return publicRepositorySnapshot(snapshot);
    },
    async inspectDestinationFiles({ repository, paths }) {
      if (paths.some((path) => !safeSourcePath(path))) {
        throw new Error(invalidResponseMessage);
      }
      const accessToken = await destinationSnapshot(repository);
      const files = [];
      const readTree = destinationTreeReader(repository, accessToken);
      for (const path of [...new Set(paths)].toSorted(compareOverlayPaths)) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- keep scoped destination reads sequential
        const file = await readDestinationPath(repository, path, accessToken, readTree);
        if (file !== null) {
          files.push({ digest: file.digest, mode: file.mode, path });
        }
      }
      return files;
    },
    async inspectDraftPublication(proposal) {
      assertExactDraftPullRequestProposal(proposal);
      const permissions: PermissionSnapshot = {
        administration: "none",
        contents: "write",
        metadata: "read",
        pullRequests: "write",
        variables: "read",
        workflows: "write",
      };
      const { snapshot, accessToken } = await repositorySnapshotForProposal(proposal, permissions);
      const compare = await github({
        authorization: accessToken,
        expected: [200],
        path: `/repos/${encodeURIComponent(proposal.owner)}/${encodeURIComponent(proposal.name)}/compare/${encodeURIComponent(proposal.baseSha)}...${encodeURIComponent(snapshot.headSha)}`,
      });
      const changedPathsSinceBase = arrayProperty(compare.body, "files")
        .map((file) => stringProperty(file, "filename"))
        .toSorted(compareOverlayPaths);
      let branch: DraftPublicationReadBack["branch"] = { status: "absent" };
      let branchSha: string | undefined;
      try {
        const branchResponse = await github({
          authorization: accessToken,
          expected: [200, 404],
          path: `/repos/${encodeURIComponent(proposal.owner)}/${encodeURIComponent(proposal.name)}/branches/${encodePath(proposal.branchName)}`,
        });
        if (branchResponse.status === 200) {
          const commit = property(branchResponse.body, "commit");
          branchSha = objectId.parse(stringProperty(commit, "sha"));
          const branchCommit = await github({
            authorization: accessToken,
            expected: [200],
            path: `/repos/${encodeURIComponent(proposal.owner)}/${encodeURIComponent(proposal.name)}/commits/${branchSha}`,
          });
          const firstParentSha = objectId.parse(
            stringProperty(arrayProperty(branchCommit.body, "parents")[0], "sha"),
          );
          const tree = property(property(branchCommit.body, "commit"), "tree");
          const markerMatches = stringProperty(
            property(branchCommit.body, "commit"),
            "message",
          ).includes(`App-Builder-Idempotency: ${proposal.idempotencyKey}`);
          const branchCompare = await github({
            authorization: accessToken,
            expected: [200],
            path: `/repos/${encodeURIComponent(proposal.owner)}/${encodeURIComponent(proposal.name)}/compare/${encodeURIComponent(firstParentSha)}...${encodeURIComponent(branchSha)}`,
          });
          const normalizedChangedPaths = arrayProperty(branchCompare.body, "files")
            .map((file) => stringProperty(file, "filename"))
            .toSorted(compareOverlayPaths);
          branch = {
            branchName: proposal.branchName,
            branchSha,
            branchTree: objectId.parse(stringProperty(tree, "sha")),
            changedContentDigest: markerMatches ? proposal.changedContentDigest : "0".repeat(64),
            idempotencyKey: markerMatches ? proposal.idempotencyKey : "0".repeat(64),
            normalizedChangedPaths,
            status: "present",
          };
        }
      } catch {
        throw new Error(githubRequestFailedMessage);
      }
      const pulls = await github({
        authorization: accessToken,
        expected: [200],
        path: `/repos/${encodeURIComponent(proposal.owner)}/${encodeURIComponent(proposal.name)}/pulls?state=open&head=${pullHead(proposal.owner, proposal.branchName)}&base=${encodeURIComponent(proposal.baseBranch)}&per_page=2`,
      });
      if (!Array.isArray(pulls.body)) {
        throw new TypeError(invalidResponseMessage);
      }
      const candidates: unknown[] = pulls.body;
      if (candidates.length > 1) {
        throw new Error(invalidResponseMessage);
      }
      const [pull] = candidates;
      const exactPull =
        pull !== undefined &&
        stringProperty(pull, "title") === proposal.title &&
        stringProperty(pull, "body") ===
          `<!-- App-Builder-Idempotency: ${proposal.idempotencyKey} -->`;
      const pullRequest =
        pull === undefined
          ? { status: "absent" as const }
          : {
              baseBranch: stringProperty(property(pull, "base"), "ref"),
              baseRepositoryId: decimalProperty(property(property(pull, "base"), "repo"), "id"),
              baseSha: objectId.parse(stringProperty(property(pull, "base"), "sha")),
              changeSetDigest: exactPull ? proposal.changeSetDigest : "0".repeat(64),
              draft: booleanProperty(pull, "draft"),
              headBranch: stringProperty(property(pull, "head"), "ref"),
              headRepositoryId: decimalProperty(property(property(pull, "head"), "repo"), "id"),
              headSha: objectId.parse(stringProperty(property(pull, "head"), "sha")),
              idempotencyKey: exactPull ? proposal.idempotencyKey : "0".repeat(64),
              pullRequestId: decimalProperty(pull, "id"),
              pullRequestNumber: Number(decimalProperty(pull, "number")),
              status: "present" as const,
            };
      return {
        branch,
        changedPathsSinceBase,
        idempotencyKey: proposal.idempotencyKey,
        pullRequest,
        repository: snapshot,
      };
    },
    inspectExistingDraft,
    async inspectFreshRepositoryOutcome(proposal) {
      assertExactFreshRepositoryProposal(proposal);
      const permissions: PermissionSnapshot = {
        administration: "write",
        contents: "write",
        metadata: "read",
        pullRequests: "none",
        variables: "read",
        workflows: "write",
      };
      const snapshot = await repositoryByName(
        proposal.destinationOwner,
        proposal.destinationName,
        permissions,
      );
      if (snapshot === undefined) {
        return;
      }
      const commit = await github({
        authorization: snapshot.accessToken,
        expected: [200],
        path: `/repos/${encodeURIComponent(proposal.destinationOwner)}/${encodeURIComponent(proposal.destinationName)}/commits/${encodeURIComponent(proposal.defaultBranch)}`,
      });
      const parents = arrayProperty(commit.body, "parents").map((parent) =>
        objectId.parse(stringProperty(parent, "sha")),
      );
      if (
        !stringProperty(property(commit.body, "commit"), "message").includes(
          `App-Builder-Idempotency: ${proposal.idempotencyKey}`,
        )
      ) {
        throw new Error("fresh-repository-marker-mismatch");
      }
      const repository = publicRepositorySnapshot(snapshot);
      return {
        idempotencyKey: proposal.idempotencyKey,
        initialCommit: {
          parents,
          sha: objectId.parse(stringProperty(commit.body, "sha")),
          tree: repository.headTree,
        },
        repository,
      };
    },
    inspectHistoricalAppSource,
    async inspectInstallation({ requestedPermissions }) {
      const identity = await installation();
      const selectedRepositoryIds = await selectedRepositories(requestedPermissions);
      return {
        ...identity,
        grantedPermissions: requestedPermissions,
        selectedRepositoryIds,
      };
    },
    async inspectRepository({ repositoryId, ref }) {
      const permissions: PermissionSnapshot = {
        administration: "none",
        contents: "read",
        metadata: "read",
        pullRequests: "none",
        variables: "read",
        workflows: "none",
      };
      const snapshot = await repositoryById(repositoryId, ref, permissions);
      return publicRepositorySnapshot(snapshot);
    },
    async inspectRepositoryByName({ owner, name: repositoryName }) {
      const permissions: PermissionSnapshot = {
        administration: "none",
        contents: "read",
        metadata: "read",
        pullRequests: "none",
        variables: "read",
        workflows: "none",
      };
      const snapshot = await repositoryByName(owner, repositoryName, permissions);
      if (snapshot === undefined) {
        return;
      }
      const response = await github({
        authorization: snapshot.accessToken,
        expected: [200],
        path: `/repositories/${snapshot.repositoryId}`,
      });
      return {
        ...publicRepositorySnapshot(snapshot),
        archived: booleanProperty(response.body, "archived"),
      };
    },
    async inspectTargetAccess({ operation, repositoryId, requestedPermissions }) {
      decimal.parse(repositoryId);
      const expectedPermissions = githubPermissionsFor(operation);
      if (JSON.stringify(requestedPermissions) !== JSON.stringify(expectedPermissions)) {
        throw new Error("github-target-permissions-mismatch");
      }
      const identity = await installation();
      const accessToken = await token(requestedPermissions, [repositoryId]);
      const response = await github({
        authorization: accessToken,
        expected: [200],
        path: `/repositories/${repositoryId}`,
      });
      if (
        decimalProperty(response.body, "id") !== repositoryId ||
        !booleanProperty(response.body, "private")
      ) {
        throw new Error("github-target-repository-mismatch");
      }
      return {
        accountId: identity.accountId,
        accountLogin: identity.accountLogin,
        accountType: identity.accountType,
        installationId: identity.installationId,
        permissions: requestedPermissions,
        repositoryId,
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
        assertExactGitHubDraftPullRequestContent({ content, proposal });
        changes = content.changes.map((change) => {
          const entry: (typeof changes)[number] = { kind: change.kind, path: change.path };
          if (change.kind !== "added") {
            entry.before = change.before;
          }
          if (change.kind !== "deleted") {
            entry.after = Object.fromEntries([
              ["path", change.path],
              ["mode", change.after.mode === "755" ? "100755" : "100644"],
              ["content", change.after.bytes],
            ]);
          }
          return entry;
        });
        if (changes.length === 0 || changes.some((change) => !safeSourcePath(change.path))) {
          throw new Error(invalidMaterialMessage);
        }
        const paths = changes.map(({ path }) => path).toSorted(compareOverlayPaths);
        if (JSON.stringify(paths) !== JSON.stringify(proposal.approvedPaths)) {
          throw new Error(invalidMaterialMessage);
        }
        changes = changes.map((change) => {
          if (change.after !== undefined) {
            validateFile(change.after);
          }
          if (change.after !== undefined && change.after.path !== change.path) {
            throw new Error(invalidMaterialMessage);
          }
          const after =
            change.after === undefined
              ? undefined
              : Object.fromEntries([
                  ["mode", change.after.mode === "100755" ? "755" : "644"],
                  ["digest", sha256(change.after.content)],
                ]);
          if (change.kind === "added" && (change.before !== undefined || after === undefined)) {
            throw new Error(invalidMaterialMessage);
          }
          if (change.kind === "deleted" && (change.before === undefined || after !== undefined)) {
            throw new Error(invalidMaterialMessage);
          }
          if (change.kind === "modified" && (change.before === undefined || after === undefined)) {
            throw new Error(invalidMaterialMessage);
          }
          return change;
        });
      } catch {
        return {
          code: invalidPublicationMaterialCode,
          status: "rejected",
        };
      }
      const permissions: PermissionSnapshot = {
        administration: "none",
        contents: "write",
        metadata: "read",
        pullRequests: "write",
        variables: "read",
        workflows: "write",
      };
      const { snapshot, accessToken } = await repositorySnapshotForProposal(proposal, permissions);
      if (
        snapshot.repositoryId !== proposal.repositoryId ||
        snapshot.owner !== proposal.owner ||
        snapshot.name !== proposal.name ||
        snapshot.visibility !== proposal.visibility
      ) {
        return { code: repositoryIdentityChangedCode, status: "rejected" };
      }
      if (snapshot.defaultBranch !== proposal.baseBranch) {
        return { code: repositoryIdentityChangedCode, status: "rejected" };
      }
      const upstreamCompare = await github({
        authorization: accessToken,
        expected: [200],
        path: `/repos/${encodeURIComponent(proposal.owner)}/${encodeURIComponent(proposal.name)}/compare/${encodeURIComponent(proposal.baseSha)}...${encodeURIComponent(snapshot.headSha)}`,
      });
      const upstreamPaths = arrayProperty(upstreamCompare.body, "files")
        .map((file) => stringProperty(file, "filename"))
        .toSorted(compareOverlayPaths);
      const conflicts = upstreamPaths.filter((path) =>
        proposal.approvedPaths.some(
          (approved) =>
            path === approved || path.startsWith(`${approved}/`) || approved.startsWith(`${path}/`),
        ),
      );
      if (conflicts.length > 0) {
        return { code: reviewedPathChangedCode, path: conflicts.at(0) ?? "", status: "rejected" };
      }
      for (const change of changes) {
        const preimage: Pick<Parameters<typeof reviewedPreimageMatches>[0]["change"], "before"> =
          {};
        if (change.before !== undefined) {
          preimage.before = change.before;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- each live preimage is checked before any mutation
        const matches = await reviewedPreimageMatches({
          accessToken,
          change: { ...preimage, path: change.path },
          headSha: snapshot.headSha,
          headTree: snapshot.headTree,
          owner: proposal.owner,
          repositoryName: proposal.name,
        });
        if (!matches) {
          return { code: reviewedPathChangedCode, path: change.path, status: "rejected" };
        }
      }
      const files = changes.flatMap((change) => (change.after === undefined ? [] : [change.after]));
      const deletions = changes.flatMap((change) =>
        change.kind === "deleted" ? [change.path] : [],
      );
      let tree: string;
      try {
        tree = await createTree({
          accessToken,
          baseTree: snapshot.headTree,
          deletions,
          files,
          owner: proposal.owner,
          repositoryName: proposal.name,
        });
      } catch (error) {
        if (error instanceof GitHubBlobWriteFailureError) {
          const failure: Pick<
            Extract<GitHubMutationAcknowledgement, { code: "github-file-write-failed" }>,
            "bytes" | "code" | "operation" | "path" | "providerStatus"
          > = {
            bytes: error.bytes,
            code: "github-file-write-failed",
            operation: "create-blob",
            path: error.path,
          };
          if (error.providerStatus !== undefined) {
            failure.providerStatus = error.providerStatus;
          }
          return { ...failure, status: "rejected" };
        }
        throw error;
      }
      const marker = `App-Builder-Idempotency: ${proposal.idempotencyKey}`;
      const commit = await github({
        authorization: accessToken,
        body: {
          message: `${proposal.title}\n\n${marker}`,
          parents: [snapshot.headSha],
          tree,
        },
        expected: [201],
        method: "POST",
        path: `/repos/${encodeURIComponent(proposal.owner)}/${encodeURIComponent(proposal.name)}/git/commits`,
      });
      const commitSha = objectId.parse(stringProperty(commit.body, "sha"));
      const reference = await github({
        authorization: accessToken,
        body: { ref: `refs/heads/${proposal.branchName}`, sha: commitSha },
        expected: [201],
        method: "POST",
        path: `/repos/${encodeURIComponent(proposal.owner)}/${encodeURIComponent(proposal.name)}/git/refs`,
      });
      await github({
        authorization: accessToken,
        body: {
          base: proposal.baseBranch,
          body: `<!-- ${marker} -->`,
          draft: true,
          head: proposal.branchName,
          title: proposal.title,
        },
        expected: [201],
        method: "POST",
        path: `/repos/${encodeURIComponent(proposal.owner)}/${encodeURIComponent(proposal.name)}/pulls`,
      });
      return { requestId: reference.requestId, status: "accepted" };
    },
    async readDestinationFile({ repository, path }) {
      if (!safeSourcePath(path)) {
        throw new Error(invalidResponseMessage);
      }
      const accessToken = await destinationSnapshot(repository);
      return await readDestinationPath(
        repository,
        path,
        accessToken,
        destinationTreeReader(repository, accessToken),
      );
    },
    // oxlint-disable-next-line eslint/complexity -- verifies identity, both refs, reviewed preimages, exact tree, and atomic ref update
    async reconcileExistingDraft(
      proposal: ExistingDraftReconciliationProposal,
      content: ReconciliationContent,
      recovery?: OwnedDraftInspectionRecovery,
    ) {
      try {
        assertReconciliationContent(proposal, content);
      } catch {
        return { code: invalidPublicationMaterialCode, status: "rejected" };
      }
      const inspection: ExistingDraftInspectionRequest = {
        name: proposal.name,
        number: proposal.pullRequestNumber,
        owner: proposal.owner,
        repositoryId: proposal.repositoryId,
      };
      if (recovery !== undefined) {
        inspection.recovery = recovery;
      }
      const current = await inspectExistingDraft(inspection);
      if (
        current.pullRequestId !== proposal.pullRequestId ||
        !current.draft ||
        current.state !== "open" ||
        current.repositoryId !== proposal.repositoryId
      ) {
        return { code: pullRequestChangedCode, status: "rejected" };
      }
      if (
        current.headRepositoryId !== proposal.repositoryId ||
        current.baseRepositoryId !== proposal.repositoryId ||
        current.headBranch !== proposal.branchName ||
        current.baseBranch !== proposal.baseBranch
      ) {
        return { code: pullRequestChangedCode, status: "rejected" };
      }
      if (
        current.headSha !== proposal.expectedHeadSha ||
        current.headTree !== proposal.expectedHeadTree
      ) {
        return { code: branchMovedCode, status: "rejected" };
      }
      const base = await repositoryById(
        proposal.repositoryId,
        `refs/heads/${proposal.baseBranch}`,
        draftPermissions,
      );
      if (
        base.repositoryId !== proposal.repositoryId ||
        base.owner !== proposal.owner ||
        base.name !== proposal.name ||
        base.headSha !== proposal.expectedBaseSha
      ) {
        return { code: branchMovedCode, status: "rejected" };
      }
      if (base.headTree !== proposal.expectedBaseTree) {
        return { code: branchMovedCode, status: "rejected" };
      }
      const accessToken = await token(draftPermissions, [proposal.repositoryId]);
      for (const change of content.changes) {
        const preimageChange: Parameters<typeof reviewedPreimageMatches>[0]["change"] = {
          path: change.path,
        };
        if (change.before !== undefined) {
          preimageChange.before = change.before;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- verify every base preimage before publishing a merge commit
        const matches = await reviewedPreimageMatches({
          accessToken,
          change: preimageChange,
          headSha: base.headSha,
          headTree: base.headTree,
          owner: proposal.owner,
          repositoryName: proposal.name,
        });
        if (!matches)
          return { code: reviewedPathChangedCode, path: change.path, status: "rejected" };
      }
      const tree = await createTree({
        accessToken,
        baseTree: base.headTree,
        deletions: content.changes.flatMap((change) =>
          change.kind === "deleted" ? [change.path] : [],
        ),
        files: content.changes.flatMap((change) => {
          if (change.kind === "deleted") return [];
          if (change.bytes === undefined) throw new Error("reviewed-reconciliation-bytes-missing");
          return [
            {
              content: change.bytes,
              mode: change.after?.mode === "755" ? ("100755" as const) : ("100644" as const),
              path: change.path,
            },
          ];
        }),
        owner: proposal.owner,
        repositoryName: proposal.name,
      });
      if (tree !== proposal.resolvedTree) {
        return { code: invalidPublicationMaterialCode, status: "rejected" };
      }
      const commit = await github({
        authorization: accessToken,
        body: {
          message: reconciliationCommitMessage(proposal),
          parents: [proposal.expectedHeadSha, proposal.expectedBaseSha],
          tree,
        },
        expected: [201],
        method: "POST",
        path: `/repos/${encodeURIComponent(proposal.owner)}/${encodeURIComponent(proposal.name)}/git/commits`,
      });
      const reference = await github({
        authorization: accessToken,
        expected: [200],
        path: `/repos/${encodeURIComponent(proposal.owner)}/${encodeURIComponent(proposal.name)}/git/ref/heads/${encodePath(proposal.branchName)}`,
      });
      if (
        objectId.parse(stringProperty(property(reference.body, "object"), "sha")) !==
        current.headSha
      ) {
        return { code: branchMovedCode, status: "rejected" };
      }
      const baseNow = await repositoryById(
        proposal.repositoryId,
        `refs/heads/${proposal.baseBranch}`,
        draftPermissions,
      );
      if (baseNow.headSha !== proposal.expectedBaseSha)
        return { code: branchMovedCode, status: "rejected" };
      const repositoryIdentity = await github({
        authorization: accessToken,
        expected: [200],
        path: `/repos/${encodeURIComponent(proposal.owner)}/${encodeURIComponent(proposal.name)}`,
      });
      if (decimalProperty(repositoryIdentity.body, "id") !== proposal.repositoryId) {
        return { code: repositoryIdentityChangedCode, status: "rejected" };
      }
      const result = await github({
        authorization: accessToken,
        body: {
          query:
            "mutation($repositoryId: ID!, $name: GitRefname!, $afterOid: GitObjectID!, $beforeOid: GitObjectID!) { updateRefs(input: {repositoryId: $repositoryId, refUpdates: [{name: $name, afterOid: $afterOid, beforeOid: $beforeOid, force: false}]}) { clientMutationId } }",
          variables: {
            afterOid: objectId.parse(stringProperty(commit.body, "sha")),
            beforeOid: current.headSha,
            name: `refs/heads/${proposal.branchName}`,
            repositoryId: stringProperty(repositoryIdentity.body, "node_id"),
          },
        },
        expected: [200],
        method: "POST",
        path: "/graphql",
      });
      if (
        record(result.body) &&
        Array.isArray(result.body.errors) &&
        result.body.errors.length > 0
      ) {
        return { code: branchMovedCode, status: "rejected" };
      }
      property(property(result.body, "data"), "updateRefs");
      return { requestId: result.requestId, status: "accepted" };
    },
    async updateExistingDraft(proposal: ExistingDraftUpdateProposal, content) {
      try {
        assertExactGitHubDraftPullRequestContent({ content, proposal });
      } catch {
        return { code: invalidPublicationMaterialCode, status: "rejected" };
      }
      const current = await inspectExistingDraft({
        name: proposal.name,
        number: proposal.pullRequestNumber,
        owner: proposal.owner,
        repositoryId: proposal.repositoryId,
      });
      if (
        current.pullRequestId !== proposal.pullRequestId ||
        !current.draft ||
        current.state !== "open" ||
        current.headRepositoryId !== proposal.repositoryId
      ) {
        return { code: pullRequestChangedCode, status: "rejected" };
      }
      if (
        current.baseRepositoryId !== proposal.repositoryId ||
        current.headBranch !== proposal.branchName ||
        current.baseBranch !== proposal.baseBranch
      ) {
        return { code: pullRequestChangedCode, status: "rejected" };
      }
      if (
        current.headSha !== proposal.expectedHeadSha ||
        current.headTree !== proposal.expectedHeadTree
      ) {
        return { code: branchMovedCode, status: "rejected" };
      }
      const accessToken = await token(draftPermissions, [proposal.repositoryId]);
      for (const change of content.changes) {
        const preimageChange: Parameters<typeof reviewedPreimageMatches>[0]["change"] = {
          path: change.path,
        };
        if (change.kind !== "added") {
          preimageChange.before = change.before;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- inspect every reviewed preimage before any ref mutation
        const matches = await reviewedPreimageMatches({
          accessToken,
          change: preimageChange,
          headSha: current.headSha,
          headTree: current.headTree,
          owner: proposal.owner,
          repositoryName: proposal.name,
        });
        if (!matches) {
          return { code: reviewedPathChangedCode, path: change.path, status: "rejected" };
        }
      }
      const files = content.changes.flatMap((change) =>
        change.kind === "deleted"
          ? []
          : [
              {
                content: change.after.bytes,
                mode: change.after.mode === "755" ? ("100755" as const) : ("100644" as const),
                path: change.path,
              },
            ],
      );
      const deletions = content.changes.flatMap((change) =>
        change.kind === "deleted" ? [change.path] : [],
      );
      const tree = await createTree({
        accessToken,
        baseTree: current.headTree,
        deletions,
        files,
        owner: proposal.owner,
        repositoryName: proposal.name,
      });
      const commit = await github({
        authorization: accessToken,
        body: {
          message: `Update draft pull request #${proposal.pullRequestNumber}\n\nApp-Builder-Idempotency: ${proposal.idempotencyKey}\nApp-Builder-Origin: ${proposal.originMarker}`,
          parents: [current.headSha],
          tree,
        },
        expected: [201],
        method: "POST",
        path: `/repos/${encodeURIComponent(proposal.owner)}/${encodeURIComponent(proposal.name)}/git/commits`,
      });
      const reference = await github({
        authorization: accessToken,
        expected: [200],
        path: `/repos/${encodeURIComponent(proposal.owner)}/${encodeURIComponent(proposal.name)}/git/ref/heads/${encodePath(proposal.branchName)}`,
      });
      if (
        objectId.parse(stringProperty(property(reference.body, "object"), "sha")) !==
        current.headSha
      ) {
        return { code: branchMovedCode, status: "rejected" };
      }
      const repositoryIdentity = await github({
        authorization: accessToken,
        expected: [200],
        path: `/repos/${encodeURIComponent(proposal.owner)}/${encodeURIComponent(proposal.name)}`,
      });
      if (decimalProperty(repositoryIdentity.body, "id") !== proposal.repositoryId) {
        return { code: repositoryIdentityChangedCode, status: "rejected" };
      }
      const result = await github({
        authorization: accessToken,
        body: {
          query:
            "mutation($repositoryId: ID!, $name: GitRefname!, $afterOid: GitObjectID!, $beforeOid: GitObjectID!) { updateRefs(input: {repositoryId: $repositoryId, refUpdates: [{name: $name, afterOid: $afterOid, beforeOid: $beforeOid, force: false}]}) { clientMutationId } }",
          variables: {
            afterOid: objectId.parse(stringProperty(commit.body, "sha")),
            beforeOid: current.headSha,
            name: `refs/heads/${proposal.branchName}`,
            repositoryId: stringProperty(repositoryIdentity.body, "node_id"),
          },
        },
        expected: [200],
        method: "POST",
        path: "/graphql",
      });
      if (
        record(result.body) &&
        Array.isArray(result.body.errors) &&
        result.body.errors.length > 0
      ) {
        return { code: branchMovedCode, status: "rejected" };
      }
      property(property(result.body, "data"), "updateRefs");
      return { requestId: result.requestId, status: "accepted" };
    },
  };
};
