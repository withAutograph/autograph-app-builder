import { createHash, generateKeyPairSync } from "node:crypto";

import { decodeJwt, decodeProtectedHeader } from "jose";
import { describe, expect, it } from "vitest";

import {
  createGitHubAppPublicationAdapter,
  createGitHubTargetAccessAdapter,
} from "./github-app-adapter";
import {
  createGitHubAppHttpProvider,
  parseGitHubAppHttpProviderCredentials,
  parseGitHubAppHttpProviderConfig,
} from "./github-app-http-provider";
import {
  GITHUB_PUBLICATION_VERSION,
  createDraftPullRequestProposal,
  createGitHubInstallationIdentity,
  createRepositoryObservation,
  githubPermissionsFor,
} from "./github-publication";
import type { GitHubDraftPullRequestContent, FreshRepositoryProposal } from "./github-publication";
import { createReviewedChangeSetReceipt } from "./reviewed-change-set";
import type { NormalizedChangeSet } from "./reviewed-change-set";
import { compareOverlayPaths } from "./target-apply";
import type { ExistingDraftObservation, ExistingDraftUpdateProposal } from "./github-draft-update";
import type {
  ExistingDraftReconciliationProposal,
  ReconciliationContent,
} from "./github-draft-reconciliation";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const sourceSha = "1".repeat(40);
const sourceTree = "2".repeat(40);

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function unicodeDraftMaterial(
  preserveOverlayOrder = false,
  includePreimages = false,
  inputPaths?: readonly string[],
  contentBytes = new TextEncoder().encode("export default null;\n"),
) {
  const bytes = contentBytes;
  const digest = createHash("sha256").update(bytes).digest("hex");
  const changes = (
    inputPaths ?? [
      ".codex/skills/example/agents/openai.yaml",
      ".codex/skills/example/SKILL.md",
      "apps/demo/\u{E000}.tsx",
      "apps/demo/\u{10000}.tsx",
    ]
  )
    .map((path) => {
      const change = {
        after: { digest, mode: "644" },
        ...(includePreimages
          ? {
              before: {
                digest: createHash("sha256").update("reviewed original").digest("hex"),
                mode: "644",
              },
            }
          : {}),
        kind: includePreimages ? ("modified" as const) : ("added" as const),
        path,
      };
      return preserveOverlayOrder
        ? change
        : (Object.fromEntries([
            ["path", change.path],
            ["kind", change.kind],
            ...(change.before === undefined ? [] : [["before", change.before]]),
            [
              "after",
              Object.fromEntries([
                ["mode", change.after.mode],
                ["digest", change.after.digest],
              ]),
            ],
          ]) as typeof change);
    })
    .toSorted((left, right) => compareOverlayPaths(left.path, right.path));
  const unsigned = {
    appSpecDigest: "a".repeat(64),
    appSpecPath: "prototype/demo/app-spec.md",
    applyDigest: "4".repeat(64),
    approvedPaths: changes.map(({ path }) => path),
    artifactRevision: "b".repeat(64),
    changedContentDigest: hash(changes),
    changes,
    contractDigest: "6".repeat(64),
    dependencyCacheContentDigest: "0".repeat(64),
    dependencyCacheDigest: "f".repeat(64),
    dependencyReceiptDigest: "c".repeat(64),
    eligibilityDigest: "8".repeat(64),
    identityDigest: "d".repeat(64),
    imageDigest: `sha256:${"e".repeat(64)}`,
    postTreeDigest: "4".repeat(64),
    preTreeDigest: "3".repeat(64),
    proposalDigest: "5".repeat(64),
    repositoryContractDigest: "7".repeat(64),
    sourceReceiptDigest: "7".repeat(64),
    sourceSha,
    sourceTree,
    targetReceipt: {
      contractPath: ".config/repository-template.json",
      topology: {
        newDigest: "2".repeat(64),
        oldDigest: "1".repeat(64),
        path: "apps.json",
      },
      version: 1 as const,
    },
    validationDigest: "3".repeat(64),
    version: 2 as const,
    workspaceDigest: "9".repeat(64),
  };
  const changeSet: NormalizedChangeSet = {
    ...unsigned,
    digest: hash(unsigned),
  };
  const review = createReviewedChangeSetReceipt(changeSet, "review-call");
  const installation = createGitHubInstallationIdentity({
    accountId: "789",
    accountLogin: "withAutograph",
    accountType: "Organization",
    installationId: "456",
    operation: "publish-draft-pull-request",
    repositorySelection: "selected",
    selectedRepositoryIds: ["100"],
  });
  const repository = createRepositoryObservation({
    defaultBranch: "main",
    headSha: sourceSha,
    headTree: sourceTree,
    installationIdentityDigest: installation.digest,
    name: "example-app",
    owner: "withAutograph",
    releaseGate: {
      configured: false,
      name: "REPOSITORY_RELEASE_ENABLED",
    },
    repositoryId: "100",
    visibility: "private",
  });
  const proposal = createDraftPullRequestProposal({
    changedPathsSinceBase: [],
    installation,
    repository,
    review,
    title: "Add demo",
  });
  const content: GitHubDraftPullRequestContent = {
    approvedPaths: review.approvedPaths,
    changeSetDigest: review.changeSetDigest,
    changedContentDigest: review.changedContentDigest,
    changes: changes.map((change) => ({
      ...change,
      after: { ...change.after, bytes },
    })) as GitHubDraftPullRequestContent["changes"],
    kind: "draft-reviewed-change-set",
    reviewDigest: review.digest,
    version: 1,
  };
  return { content, proposal };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function freshProposal(): FreshRepositoryProposal {
  const installationIdentityDigest = "1".repeat(64);
  const sourceReceiptDigest = "2".repeat(64);
  const reviewDigest = "3".repeat(64);
  const idempotencyKey = hash({
    destinationName: "new-app",
    destinationOwner: "withAutograph",
    installationIdentityDigest,
    reviewDigest,
    sourceReceiptDigest,
  });
  const unsigned = {
    changeSetDigest: "8".repeat(64),
    contractDigest: "6".repeat(64),
    defaultBranch: "main" as const,
    destinationName: "new-app",
    destinationOwner: "withAutograph",
    eligibilityDigest: "7".repeat(64),
    idempotencyKey,
    initialCommitMessage: "Initialize repository from supported template" as const,
    installationIdentityDigest,
    intendedOutcome: "create-private-fresh-history-repository" as const,
    releaseGate: {
      configured: false as const,
      name: "REPOSITORY_RELEASE_ENABLED" as const,
    },
    reviewDigest,
    sourceReceiptDigest,
    sourceSha: "4".repeat(40),
    sourceTree: "5".repeat(40),
    version: GITHUB_PUBLICATION_VERSION,
    visibility: "private" as const,
  };
  return { ...unsigned, digest: hash(unsigned) };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function json(value: unknown, status = 200, requestId = "REQUEST_1") {
  return Response.json(value, {
    headers: {
      "content-type": "application/json",
      "x-github-request-id": requestId,
    },
    status,
  });
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function providerFetch(input?: {
  extraPermission?: boolean;
  fail?: boolean;
  repositorySelection?: "all" | "selected";
  repositoryPages?: (number | string)[][];
  targetRepositoryId?: string;
}) {
  const calls: { url: string; init: RequestInit; body: unknown }[] = [];
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  const implementation: typeof fetch = async (request, init = {}) => {
    const url = String(request);
    let body;
    if (typeof init.body === "string") {
      body = JSON.parse(init.body) as unknown;
    }
    calls.push({ body, init, url });
    if (input?.fail) {
      return json({ message: "private-key-material" }, 500);
    }
    if (url.endsWith("/app/installations/456")) {
      return json({
        account: { id: 789, login: "withAutograph", type: "Organization" },
        id: 456,
        repository_selection: input?.repositorySelection ?? "selected",
      });
    }
    if (url.endsWith("/app/installations/456/access_tokens")) {
      const requested = (body as { permissions: Record<string, string> }).permissions;
      return json(
        {
          permissions: {
            ...requested,
            ...(input?.extraPermission ? { issues: "write" } : {}),
          },
          token: "ghs_operation_scoped_installation_token",
        },
        201,
      );
    }
    if (url.includes("/installation/repositories?")) {
      const page = Number(new URL(url).searchParams.get("page"));
      const repositoryIds = input?.repositoryPages?.[page - 1] ?? [100, 200];
      return json({ repositories: repositoryIds.map((id) => ({ id })) });
    }
    if (url.endsWith("/repositories/100") && input?.targetRepositoryId) {
      return json({ id: Number(input.targetRepositoryId), private: true });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  return { calls, implementation };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function createProvider(fetchImplementation: typeof fetch) {
  return createGitHubAppHttpProvider({
    config: {
      appId: "123",
      installationId: "456",
      privateKey: privateKeyPem,
    },
    fetch: fetchImplementation,
    now: () => Date.UTC(2026, 7, 28, 12, 0, 0),
  });
}

describe("GitHub App fixed-origin HTTP provider", () => {
  it("proves target repository access without enumerating installation repositories", async () => {
    const mock = providerFetch({
      repositoryPages: Array.from({ length: 101 }, (_unusedPage, page) =>
        Array.from({ length: 100 }, (_unusedIndex, index) => page * 100 + index + 1),
      ),
      targetRepositoryId: "100",
    });
    const provider = createProvider(mock.implementation);
    const adapter = createGitHubTargetAccessAdapter(provider, {
      audience: "https://builder.example/mcp",
      issuer: "https://builder.example/api/auth",
      ownerUserId: "user-1",
      workspaceId: "workspace-1",
    });
    const proof = await adapter.inspectTargetAccess("resolve-existing-source", "100");
    expect(proof.repositoryId).toBe("100");
    expect(proof.version).toBe(3);
    expect(mock.calls.some(({ url }) => url.includes("/installation/repositories?"))).toBe(false);
    expect(mock.calls.some(({ url }) => url.endsWith("/repositories/100"))).toBe(true);
  });

  it("rejects a provider repository ID mismatch in target proof", async () => {
    const mock = providerFetch({ targetRepositoryId: "101" });
    const provider = createProvider(mock.implementation);
    await expect(
      provider.inspectTargetAccess({
        operation: "resolve-existing-source",
        repositoryId: "100",
        requestedPermissions: githubPermissionsFor("resolve-existing-source"),
      }),
    ).rejects.toThrow("github-target-repository-mismatch");
  });
  it("parses only the closed credential contract and rejects endpoint or token overrides", () => {
    expect(
      parseGitHubAppHttpProviderCredentials({
        appId: "123",
        privateKey: privateKeyPem,
      }),
    ).toEqual({ appId: "123", privateKey: privateKeyPem });
    expect(
      parseGitHubAppHttpProviderConfig({
        appId: "123",
        installationId: "456",
        privateKey: privateKeyPem,
      }),
    ).toEqual({
      appId: "123",
      installationId: "456",
      privateKey: privateKeyPem,
    });
    expect(() =>
      parseGitHubAppHttpProviderConfig({
        apiOrigin: "https://example.invalid",
        appId: "123",
        installationId: "456",
        privateKey: privateKeyPem,
      }),
    ).toThrow("configuration is invalid");
    expect(() =>
      parseGitHubAppHttpProviderCredentials({
        GITHUB_API_URL: "https://example.invalid",
        GITHUB_APP_ID: "123",
        GITHUB_APP_INSTALLATION_ID: "456",
        GITHUB_APP_PRIVATE_KEY: privateKeyPem,
      }),
    ).toThrow("configuration is invalid");
    expect(() =>
      parseGitHubAppHttpProviderCredentials({
        appId: "123",
        privateKey: "not-a-key",
      }),
    ).toThrow("configuration is invalid");
  });

  it.each([
    ["resolve-existing-source", "read", "none", undefined, undefined],
    ["create-fresh-repository", "write", "write", undefined, "write"],
    ["publish-draft-pull-request", "write", "write", "write", undefined],
  ] as const)(
    "mints an exact operation-scoped installation token for %s",
    async (operation, contents, workflows, pullRequests, administration) => {
      const mock = providerFetch();
      const adapter = createGitHubAppPublicationAdapter(createProvider(mock.implementation));
      const identity = await adapter.inspectInstallation(operation);
      expect(identity.selectedRepositoryIds).toEqual(["100", "200"]);
      expect(identity.permissions).toMatchObject({ contents, workflows });

      const appCall = mock.calls.find(({ url }) => url.endsWith("/app/installations/456"));
      const tokenCall = mock.calls.find(({ url }) =>
        url.endsWith("/app/installations/456/access_tokens"),
      );
      expect(mock.calls.every(({ url }) => url.startsWith("https://api.github.com/"))).toBe(true);
      expect(appCall).toBeDefined();
      if (!appCall) {
        throw new Error("Expected an app installation request");
      }
      expect(appCall.init.redirect).toBe("error");
      const authorization = new Headers(appCall.init.headers).get("authorization");
      expect(authorization).not.toBeNull();
      if (authorization === null) {
        throw new Error("Expected app installation request authorization");
      }
      const jwt = authorization.replace(/^bearer /iu, "");
      expect(decodeProtectedHeader(jwt)).toEqual({ alg: "RS256", typ: "JWT" });
      expect(decodeJwt(jwt)).toMatchObject({ iss: "123" });
      const claims = decodeJwt(jwt);
      expect(claims.exp).toBeDefined();
      expect(claims.iat).toBeDefined();
      if (claims.exp === undefined || claims.iat === undefined) {
        throw new Error("Expected JWT expiration and issued-at claims");
      }
      expect(claims.exp - claims.iat).toBe(600);
      expect(tokenCall?.body).toEqual({
        permissions: {
          actions_variables: "read",
          ...(administration === undefined ? {} : { administration }),
          contents,
          metadata: "read",
          ...(pullRequests === undefined ? {} : { pull_requests: pullRequests }),
          ...(workflows === "write" ? { workflows } : {}),
        },
      });
      const publicRequestSurface = mock.calls.map(({ url, body }) => ({
        body,
        url,
      }));
      expect(JSON.stringify(publicRequestSurface)).not.toContain(privateKeyPem);
      expect(JSON.stringify(publicRequestSurface)).not.toContain(
        "ghs_operation_scoped_installation_token",
      );
    },
  );

  it("mints only a contents-read credential for the exact source repository", async () => {
    const mock = providerFetch();
    const provider = createProvider(mock.implementation);

    await expect(
      provider.acquireRepositoryReadCredential({ repositoryId: "200" }),
    ).resolves.toEqual({
      token: "ghs_operation_scoped_installation_token",
    });
    expect(
      mock.calls.find(({ url }) => url.endsWith("/app/installations/456/access_tokens"))?.body,
    ).toEqual({
      permissions: { contents: "read" },
      repository_ids: [200],
    });

    let message = "";
    try {
      await createProvider(
        providerFetch({ extraPermission: true }).implementation,
      ).acquireRepositoryReadCredential({ repositoryId: "200" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(
      "GitHub could not acquire read access to the selected repository. Check that the GitHub App installation includes this repository and grants contents read access, then reconnect GitHub and retry.",
    );
    expect(message).not.toContain("ghs_operation_scoped_installation_token");
    expect(message).not.toContain(privateKeyPem);
  });

  it("preserves an all-repositories installation through the adapter", async () => {
    const adapter = createGitHubAppPublicationAdapter(
      createProvider(providerFetch({ repositorySelection: "all" }).implementation),
    );

    await expect(adapter.inspectInstallation("resolve-existing-source")).resolves.toMatchObject({
      repositorySelection: "all",
      selectedRepositoryIds: ["100", "200"],
    });
  });

  it("continues all-repository pagination beyond five full pages", async () => {
    const pages = Array.from({ length: 5 }, (_unusedPage, page) =>
      Array.from({ length: 100 }, (_unusedItem, index) => page * 100 + index + 1),
    );
    pages.push([501]);
    const mock = providerFetch({
      repositoryPages: pages,
      repositorySelection: "all",
    });
    const adapter = createGitHubAppPublicationAdapter(createProvider(mock.implementation));

    await expect(adapter.inspectInstallation("resolve-existing-source")).resolves.toMatchObject({
      repositorySelection: "all",
      selectedRepositoryIds: expect.arrayContaining(["1", "500", "501"]),
    });
    expect(
      mock.calls.filter(({ url }) => url.includes("/installation/repositories?")),
    ).toHaveLength(6);
  });

  it("reads more than 10,000 installation repositories through the final page", async () => {
    const pages = Array.from({ length: 100 }, (_unusedPage, page) =>
      Array.from({ length: 100 }, (_unusedItem, index) => page * 100 + index + 1),
    );
    pages.push([10_001]);
    const mock = providerFetch({ repositoryPages: pages });
    const adapter = createGitHubAppPublicationAdapter(createProvider(mock.implementation));

    const identity = await adapter.inspectInstallation("resolve-existing-source");
    expect(identity.selectedRepositoryIds).toHaveLength(10_001);
    expect(identity.selectedRepositoryIds).toContain("10001");
    expect(
      mock.calls.filter(({ url }) => url.includes("/installation/repositories?")),
    ).toHaveLength(101);
  });

  it("rejects repository IDs that cannot round-trip as safe JSON integers", async () => {
    const provider = createProvider(providerFetch().implementation);

    await expect(
      provider.inspectRepository({
        ref: "main",
        repositoryId: "9007199254740993",
      }),
    ).rejects.toThrow("invalid-response");
  });

  it("rejects an escalated token response and sanitizes transport bodies", async () => {
    const escalated = createGitHubAppPublicationAdapter(
      createProvider(providerFetch({ extraPermission: true }).implementation),
    );
    await expect(escalated.inspectInstallation("resolve-existing-source")).rejects.toThrow(
      "GitHub could not inspect the GitHub App installation.",
    );

    const failed = createGitHubAppPublicationAdapter(
      createProvider(providerFetch({ fail: true }).implementation),
    );
    let message = "";
    try {
      await failed.inspectInstallation("resolve-existing-source");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(
      "GitHub could not inspect the GitHub App installation (HTTP 500). GitHub is unavailable. Retry after the service recovers; inspect the current state before repeating a write.",
    );
    expect(message).not.toContain("private-key-material");
  });

  it.each([
    [401, "Reconnect GitHub access"],
    [403, "required repository permission"],
    [404, "repository and PR still exist"],
    [409, "rebuild and review the proposal"],
    [429, "Wait for the limit to reset"],
    [503, "GitHub is unavailable"],
  ])("reports a safe recovery for target access HTTP %i", async (status, guidance) => {
    const adapter = createGitHubTargetAccessAdapter(
      {
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        async inspectTargetAccess() {
          throw Object.assign(new Error("secret-token https://github.example/private"), {
            status,
          });
        },
      },
      {
        audience: "https://builder.example/mcp",
        issuer: "https://builder.example/api/auth",
        ownerUserId: "user-1",
        workspaceId: "workspace-1",
      },
    );

    await expect(adapter.inspectTargetAccess("resolve-existing-source", "100")).rejects.toThrow(
      `GitHub could not verify the selected repository's GitHub installation access (HTTP ${status}).`,
    );
    await expect(adapter.inspectTargetAccess("resolve-existing-source", "100")).rejects.toThrow(
      guidance,
    );
    await expect(adapter.inspectTargetAccess("resolve-existing-source", "100")).rejects.not.toThrow(
      /secret-token|github\.example/u,
    );
  });

  it("names an existing draft update failure without exposing provider details", async () => {
    const provider = {
      ...createProvider(providerFetch().implementation),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      async updateExistingDraft() {
        throw Object.assign(new Error("secret-token https://github.example/private"), {
          status: 409,
        });
      },
    };
    const adapter = createGitHubAppPublicationAdapter(provider);
    const { content } = unicodeDraftMaterial();
    let message = "unexpected success";
    try {
      await adapter.updateExistingDraft({} as ExistingDraftUpdateProposal, content);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("GitHub could not update the existing draft PR (HTTP 409).");
    expect(message).toContain("rebuild and review the proposal");
    expect(message).not.toMatch(/secret-token|github\.example/u);
  });

  it("rejects stale full-template bytes before any GitHub mutation", async () => {
    const mock = providerFetch();
    const provider = createGitHubAppHttpProvider({
      config: {
        appId: "123",
        installationId: "456",
        privateKey: privateKeyPem,
      },
      fetch: mock.implementation,
    });
    const bytes = new TextEncoder().encode("name: CI\n");
    await expect(
      provider.createPrivateFreshHistoryRepository(freshProposal(), {
        files: [
          {
            bytes,
            digest: createHash("sha256").update(bytes).digest("hex"),
            mode: "100644",
            objectId: "0".repeat(40),
            path: ".github/workflows/ci.yml",
          },
        ],
        kind: "fresh-repository-source-tree",
        sourceSha: "4".repeat(40),
        sourceTree: "5".repeat(40),
        version: 1,
      }),
    ).resolves.toEqual({
      code: "invalid-publication-material",
      status: "rejected",
    });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.init.method ?? "GET").toBe("GET");
  });

  it("round-trips UTF-8 ordered draft material through the HTTP provider", async () => {
    const calls: string[] = [];
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const implementation: typeof fetch = async (request, init = {}) => {
      const url = String(request);
      calls.push(url);
      if (url.endsWith("/app/installations/456/access_tokens")) {
        const body = JSON.parse(String(init.body)) as {
          permissions: Record<string, string>;
        };
        return json(
          {
            permissions: body.permissions,
            token: "ghs_operation_scoped_installation_token",
          },
          201,
        );
      }
      if (url.endsWith("/repositories/100")) {
        return json({
          default_branch: "main",
          id: 100,
          name: "example-app",
          owner: { login: "withAutograph" },
          private: true,
        });
      }
      if (url.endsWith("/repos/withAutograph/example-app/commits/main")) {
        return json({
          commit: { tree: { sha: "b".repeat(40) } },
          sha: "a".repeat(40),
        });
      }
      if (url.endsWith("/repos/withAutograph/example-app/actions/variables?per_page=100&page=1")) {
        return json({ variables: [] });
      }
      if (url.endsWith(`/compare/${sourceSha}...${"a".repeat(40)}`)) {
        return json({ files: [{ filename: ".codex/skills/example/SKILL.md" }] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const provider = createProvider(implementation);
    const { proposal, content } = unicodeDraftMaterial(true);

    await expect(provider.publishDraftPullRequest(proposal, content)).resolves.toEqual({
      code: "reviewed-path-changed",
      path: ".codex/skills/example/SKILL.md",
      status: "rejected",
    });
    expect(calls).toHaveLength(5);
  });

  it("accepts a reviewed draft file larger than the former 10 MiB Builder cap", async () => {
    const filePath = "apps/demo/large.tsx";
    const mock = providerFetch();
    const provider = createGitHubAppHttpProvider({
      config: {
        appId: "123",
        installationId: "456",
        privateKey: privateKeyPem,
      },
      // oxlint-disable-next-line eslint/require-await -- this callback implements fetch with synchronous fixtures.
      fetch: async (request, init = {}) => {
        const url = String(request);
        if (url.endsWith("/repositories/100")) {
          return json({
            default_branch: "main",
            id: 100,
            name: "example-app",
            owner: { login: "withAutograph" },
            private: true,
          });
        }
        if (url.endsWith("/repos/withAutograph/example-app/commits/main")) {
          return json({ commit: { tree: { sha: "b".repeat(40) } }, sha: "a".repeat(40) });
        }
        if (
          url.endsWith("/repos/withAutograph/example-app/actions/variables?per_page=100&page=1")
        ) {
          return json({ variables: [] });
        }
        if (url.endsWith(`/compare/${sourceSha}...${"a".repeat(40)}`)) {
          return json({ files: [{ filename: filePath }] });
        }
        return await mock.implementation(request, init);
      },
    });
    const bytes = new Uint8Array(10 * 1024 * 1024 + 1);
    const { proposal, content } = unicodeDraftMaterial(false, false, [filePath], bytes);

    await expect(provider.publishDraftPullRequest(proposal, content)).resolves.toEqual({
      code: "reviewed-path-changed",
      path: filePath,
      status: "rejected",
    });
  });

  it("accepts a draft change set larger than the former 10,000-file Builder cap", async () => {
    const filePaths = Array.from(
      { length: 10_001 },
      (_unused, index) => `apps/demo/file-${String(index).padStart(5, "0")}.tsx`,
    );
    const mock = providerFetch();
    const provider = createGitHubAppHttpProvider({
      config: {
        appId: "123",
        installationId: "456",
        privateKey: privateKeyPem,
      },
      // oxlint-disable-next-line eslint/require-await -- this callback implements fetch with synchronous fixtures.
      fetch: async (request, init = {}) => {
        const url = String(request);
        if (url.endsWith("/repositories/100")) {
          return json({
            default_branch: "main",
            id: 100,
            name: "example-app",
            owner: { login: "withAutograph" },
            private: true,
          });
        }
        if (url.endsWith("/repos/withAutograph/example-app/commits/main")) {
          return json({ commit: { tree: { sha: "b".repeat(40) } }, sha: "a".repeat(40) });
        }
        if (
          url.endsWith("/repos/withAutograph/example-app/actions/variables?per_page=100&page=1")
        ) {
          return json({ variables: [] });
        }
        if (url.endsWith(`/compare/${sourceSha}...${"a".repeat(40)}`)) {
          return json({ files: [{ filename: filePaths[0] }] });
        }
        return await mock.implementation(request, init);
      },
    });
    const { proposal, content } = unicodeDraftMaterial(false, false, filePaths);

    await expect(provider.publishDraftPullRequest(proposal, content)).resolves.toEqual({
      code: "reviewed-path-changed",
      path: filePaths[0],
      status: "rejected",
    });
  });

  it("reports a GitHub blob rejection with the reviewed path and byte count", async () => {
    const filePath = "apps/demo/limited.tsx";
    // oxlint-disable-next-line eslint/require-await -- this callback implements fetch with synchronous fixtures.
    const provider = createProvider(async (request, init = {}) => {
      const url = String(request);
      if (url.endsWith("/app/installations/456/access_tokens")) {
        const body = JSON.parse(String(init.body)) as { permissions: Record<string, string> };
        return json(
          { permissions: body.permissions, token: "ghs_operation_scoped_token_value" },
          201,
        );
      }
      if (url.endsWith("/repositories/100")) {
        return json({
          default_branch: "main",
          id: 100,
          name: "example-app",
          owner: { login: "withAutograph" },
          private: true,
        });
      }
      if (url.endsWith("/repos/withAutograph/example-app/commits/main")) {
        return json({ commit: { tree: { sha: "b".repeat(40) } }, sha: sourceSha });
      }
      if (url.endsWith("/repos/withAutograph/example-app/actions/variables?per_page=100&page=1")) {
        return json({ variables: [] });
      }
      if (url.endsWith(`/compare/${sourceSha}...${sourceSha}`)) {
        return json({ files: [] });
      }
      if (url.includes("/git/trees/")) {
        return json({ tree: [], truncated: false });
      }
      if (url.endsWith("/git/blobs") && init.method === "POST") {
        return json({ message: "private provider response body" }, 413);
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const { proposal, content } = unicodeDraftMaterial(false, false, [filePath]);
    const adapter = createGitHubAppPublicationAdapter(provider);

    await expect(adapter.publishDraftPullRequest(proposal, content)).resolves.toEqual({
      bytes: new TextEncoder().encode("export default null;\n").byteLength,
      code: "github-file-write-failed",
      operation: "create-blob",
      path: filePath,
      providerStatus: 413,
      status: "rejected",
    });
  });

  it.each(["modified", "added"] as const)(
    "rejects a changed reviewed %s path before creating any GitHub object",
    async (scenario) => {
      const calls: { url: string; method: string }[] = [];
      const { proposal, content } = unicodeDraftMaterial(false, scenario === "modified");
      const [firstChange] = content.changes;
      if (firstChange === undefined) throw new Error("Expected a reviewed change.");
      const pathSegments = firstChange.path.split("/");
      let treeDepth = 0;
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      const implementation: typeof fetch = async (request, init = {}) => {
        const url = String(request);
        calls.push({ method: init.method ?? "GET", url });
        if (url.endsWith("/app/installations/456/access_tokens")) {
          const body = JSON.parse(String(init.body)) as { permissions: Record<string, string> };
          return json(
            { permissions: body.permissions, token: "ghs_operation_scoped_installation_token" },
            201,
          );
        }
        if (url.endsWith("/repositories/100")) {
          return json({
            default_branch: "main",
            id: 100,
            name: "example-app",
            owner: { login: "withAutograph" },
            private: true,
          });
        }
        if (url.endsWith("/repos/withAutograph/example-app/commits/main")) {
          return json({ commit: { tree: { sha: "b".repeat(40) } }, sha: sourceSha });
        }
        if (
          url.endsWith("/repos/withAutograph/example-app/actions/variables?per_page=100&page=1")
        ) {
          return json({ variables: [] });
        }
        if (url.endsWith(`/compare/${sourceSha}...${sourceSha}`)) {
          return json({ files: [] });
        }
        if (url.includes("/git/trees/")) {
          const segment = pathSegments[treeDepth] ?? "";
          const final = treeDepth === pathSegments.length - 1;
          treeDepth += 1;
          return json({
            tree: [
              {
                mode: final ? "100644" : "040000",
                path: segment,
                sha: final ? "c".repeat(40) : `${treeDepth}`.repeat(40),
                type: final ? "blob" : "tree",
              },
            ],
            truncated: false,
          });
        }
        if (url.endsWith(`/git/blobs/${"c".repeat(40)}`)) {
          return json({
            content: Buffer.from("intervening edit").toString("base64"),
            encoding: "base64",
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      };
      const provider = createProvider(implementation);

      await expect(provider.publishDraftPullRequest(proposal, content)).resolves.toEqual({
        code: "reviewed-path-changed",
        path: content.changes[0]?.path,
        status: "rejected",
      });
      expect(
        calls
          .filter(({ method }) => method === "POST")
          .every(({ url }) => url.endsWith("/access_tokens")),
      ).toBe(true);
      expect(calls.some(({ url }) => url.includes("/git/blobs/"))).toBe(scenario === "modified");
    },
  );

  it("publishes over an unrelated upstream commit using the current head and tree", async () => {
    const currentHead = "a".repeat(40);
    const currentTree = "d".repeat(40);
    const calls: { body: unknown; method: string; url: string }[] = [];
    let createdTreeBody: { base_tree?: string } | undefined;
    let createdCommitBody: { parents: string[]; tree: string } | undefined;
    const { proposal, content } = unicodeDraftMaterial(false, true, ["README.md"]);
    const [changedFile] = content.changes;
    if (changedFile?.kind !== "modified") {
      throw new Error("Expected the reviewed file to be modified.");
    }
    expect(changedFile.before).toEqual({
      digest: createHash("sha256").update("reviewed original").digest("hex"),
      mode: "644",
    });
    const beforeMode = changedFile.before.mode;
    // oxlint-disable-next-line eslint/complexity, eslint/require-await -- one focused HTTP test double
    const implementation: typeof fetch = async (request, init = {}) => {
      const url = String(request);
      const method = init.method ?? "GET";
      const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ body, method, url });
      if (url.endsWith("/app/installations/456/access_tokens")) {
        const tokenRequest = body as { permissions: Record<string, string> };
        return json(
          {
            permissions: tokenRequest.permissions,
            token: "ghs_operation_scoped_installation_token",
          },
          201,
        );
      }
      if (url.endsWith("/repositories/100")) {
        return json({
          default_branch: "main",
          id: 100,
          name: "example-app",
          owner: { login: "withAutograph" },
          private: true,
        });
      }
      if (url.endsWith("/repos/withAutograph/example-app/commits/main")) {
        return json({ commit: { tree: { sha: currentTree } }, sha: currentHead });
      }
      if (url.endsWith("/repos/withAutograph/example-app/actions/variables?per_page=100&page=1")) {
        return json({ variables: [] });
      }
      if (url.endsWith(`/compare/${sourceSha}...${currentHead}`)) {
        return json({ files: [{ filename: "CHANGELOG.md" }] });
      }
      if (url.endsWith(`/git/trees/${currentTree}`) && method === "GET") {
        return json({
          tree: [
            { mode: `100${beforeMode}`, path: changedFile.path, sha: "c".repeat(40), type: "blob" },
          ],
          truncated: false,
        });
      }
      if (url.endsWith(`/git/blobs/${"c".repeat(40)}`) && method === "GET") {
        return json({
          content: Buffer.from("reviewed original").toString("base64"),
          encoding: "base64",
        });
      }
      if (url.endsWith("/git/blobs") && method === "POST") {
        return json({ sha: "f".repeat(40) }, 201);
      }
      if (url.endsWith("/git/trees") && method === "POST") {
        createdTreeBody = body as { base_tree?: string };
        return json({ sha: "e".repeat(40) }, 201);
      }
      if (url.endsWith("/git/commits") && method === "POST") {
        createdCommitBody = body as { parents: string[]; tree: string };
        return json({ sha: "9".repeat(40) }, 201);
      }
      if (url.endsWith("/git/refs") && method === "POST") {
        return json({ ref: `refs/heads/${proposal.branchName}` }, 201);
      }
      if (url.endsWith("/pulls") && method === "POST") {
        return json({ number: 1 }, 201);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const provider = createProvider(implementation);

    const publication = await provider.publishDraftPullRequest(proposal, content);
    expect(calls.some(({ url }) => url.endsWith(`/git/trees/${currentTree}`))).toBe(true);
    expect(calls.some(({ url }) => url.endsWith(`/git/trees/${currentTree}`))).toBe(true);
    expect(calls.some(({ url }) => url.endsWith(`/git/blobs/${"c".repeat(40)}`))).toBe(true);
    expect(publication).toEqual({
      requestId: "REQUEST_1",
      status: "accepted",
    });
    expect(createdTreeBody?.base_tree).toBe(currentTree);
    expect(createdCommitBody?.parents).toEqual([currentHead]);
    expect(createdCommitBody?.tree).toBe("e".repeat(40));
    expect(calls.some(({ url }) => url.endsWith(`/compare/${sourceSha}...${currentHead}`))).toBe(
      true,
    );
  });

  it("reads back only the approved multi-path branch delta after an unrelated base advance", async () => {
    const currentHead = "a".repeat(40);
    const branchSha = "c".repeat(40);
    const currentTree = "d".repeat(40);
    const branchTree = "e".repeat(40);
    const calls: string[] = [];
    const { proposal, content } = unicodeDraftMaterial();
    const branchPaths = content.approvedPaths.toReversed();
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const implementation: typeof fetch = async (request, init = {}) => {
      const url = String(request);
      calls.push(url);
      const method = init.method ?? "GET";
      if (url.endsWith("/app/installations/456/access_tokens")) {
        const body = JSON.parse(String(init.body)) as { permissions: Record<string, string> };
        return json(
          { permissions: body.permissions, token: "ghs_operation_scoped_installation_token" },
          201,
        );
      }
      if (url.endsWith("/repositories/100")) {
        return json({
          default_branch: "main",
          id: 100,
          name: "example-app",
          owner: { login: "withAutograph" },
          private: true,
        });
      }
      if (url.endsWith("/repos/withAutograph/example-app/commits/main")) {
        return json({ commit: { tree: { sha: currentTree } }, sha: currentHead });
      }
      if (url.endsWith("/repos/withAutograph/example-app/actions/variables?per_page=100&page=1")) {
        return json({ variables: [] });
      }
      if (url.endsWith(`/compare/${sourceSha}...${currentHead}`)) {
        return json({ files: [{ filename: "README.md" }] });
      }
      if (url.includes("/branches/")) {
        return json({ commit: { sha: branchSha } });
      }
      if (url.endsWith(`/commits/${branchSha}`)) {
        return json({
          commit: {
            message: `Add demo\n\nApp-Builder-Idempotency: ${proposal.idempotencyKey}`,
            tree: { sha: branchTree },
          },
          parents: [{ sha: sourceSha }],
          sha: branchSha,
        });
      }
      if (url.endsWith(`/compare/${sourceSha}...${branchSha}`)) {
        return json({ files: branchPaths.map((filename) => ({ filename })) });
      }
      if (url.includes("/pulls?state=open&")) {
        return json([]);
      }
      throw new Error(`Unexpected ${method} URL: ${url}`);
    };
    const provider = createProvider(implementation);

    const result = await provider.inspectDraftPublication(proposal);
    expect(result).toMatchObject({
      branch: {
        branchSha,
        branchTree,
        normalizedChangedPaths: content.approvedPaths,
        status: "present",
      },
      changedPathsSinceBase: ["README.md"],
      repository: { headSha: currentHead, headTree: currentTree },
    });
    expect(calls.some((url) => url.endsWith(`/compare/${sourceSha}...${branchSha}`))).toBe(true);
    expect(calls.some((url) => url.endsWith(`/compare/${currentHead}...${branchSha}`))).toBe(false);
  });
});

describe("existing draft update provider", () => {
  it("uses an exact expected branch OID in GitHub's atomic updateRefs mutation", async () => {
    const head = "3".repeat(40);
    const headTree = "4".repeat(40);
    const newCommit = "5".repeat(40);
    let observedHead = head;
    let recoveredMessage = `Update draft pull request #1500\n\nApp-Builder-Idempotency: ${"b".repeat(64)}\nApp-Builder-Origin: ${"d".repeat(64)}`;
    const { content } = unicodeDraftMaterial(false, false, ["apps/demo/page.tsx"]);
    const proposal = {
      approvedPaths: content.approvedPaths,
      baseBranch: "main",
      branchName: `app-builder/review-${"d".repeat(20)}`,
      changeSetDigest: content.changeSetDigest,
      changedContentDigest: content.changedContentDigest,
      digest: "a".repeat(64),
      expectedHeadSha: head,
      expectedHeadTree: headTree,
      idempotencyKey: "b".repeat(64),
      installationIdentityDigest: "c".repeat(64),
      intendedOutcome: "update-existing-draft-pull-request" as const,
      name: "example-app",
      originMarker: "d".repeat(64),
      owner: "withAutograph",
      priorPublicationDigest: "d".repeat(64),
      pullRequestId: "150000",
      pullRequestNumber: 1500,
      repositoryId: "100",
      reviewDigest: content.reviewDigest,
      version: 1 as const,
    } satisfies ExistingDraftUpdateProposal;
    const calls: { url: string; body: unknown }[] = [];
    // oxlint-disable-next-line eslint/complexity, eslint/require-await, sonarjs/cognitive-complexity -- focused GitHub HTTP double
    const implementation: typeof fetch = async (request, init = {}) => {
      const url = String(request);
      const method = init.method ?? "GET";
      const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ body, url });
      if (url.endsWith("/app")) {
        return json({ id: 123, slug: "autograph-app-builder" });
      }
      if (url.endsWith("/app/installations/456/access_tokens")) {
        return json(
          {
            permissions: (body as { permissions: unknown }).permissions,
            token: "ghs_operation_scoped_installation_token",
          },
          201,
        );
      }
      if (url.endsWith("/repositories/100")) {
        return json({
          default_branch: "main",
          id: 100,
          name: "example-app",
          owner: { login: "withAutograph" },
          private: true,
        });
      }
      if (url.endsWith("/repos/withAutograph/example-app/commits/HEAD")) {
        return json({ commit: { tree: { sha: sourceTree } }, sha: sourceSha });
      }
      if (url.endsWith("/repos/withAutograph/example-app/actions/variables?per_page=100&page=1")) {
        return json({ variables: [] });
      }
      if (url.endsWith("/repos/withAutograph/example-app/pulls/1500")) {
        return json({
          base: { ref: "main", repo: { id: 100 } },
          body: `<!-- App-Builder-Idempotency: ${"d".repeat(64)} -->`,
          draft: true,
          head: { ref: proposal.branchName, repo: { id: 100 }, sha: observedHead },
          id: 150_000,
          number: 1500,
          state: "open",
          user: { id: 900, login: "autograph-app-builder[bot]", type: "Bot" },
        });
      }
      if (url.endsWith(`/git/ref/heads/${proposal.branchName}`)) {
        return json({ node_id: "REF_NODE", object: { sha: observedHead } });
      }
      if (url.endsWith(`/commits/${head}`)) {
        return json({
          commit: {
            message: `Add demo\n\nApp-Builder-Idempotency: ${"d".repeat(64)}`,
            tree: { sha: headTree },
          },
          sha: head,
        });
      }
      if (url.endsWith(`/git/commits/${newCommit}`)) {
        return json({
          message: recoveredMessage,
          parents: [{ sha: head }],
          tree: { sha: "7".repeat(40) },
        });
      }
      if (url.endsWith(`/commits/${newCommit}`)) {
        return json({
          commit: { message: recoveredMessage, tree: { sha: "7".repeat(40) } },
          sha: newCommit,
        });
      }
      if (url.endsWith(`/git/trees/${headTree}`) && method === "GET") {
        return json({ tree: [], truncated: false });
      }
      if (url.endsWith("/git/blobs") && method === "POST") {
        return json({ sha: "6".repeat(40) }, 201);
      }
      if (url.endsWith("/git/trees") && method === "POST") {
        return json({ sha: "7".repeat(40) }, 201);
      }
      if (url.endsWith("/git/commits") && method === "POST") {
        return json({ sha: newCommit }, 201);
      }
      if (url.endsWith("/repos/withAutograph/example-app") && method === "GET") {
        return json({ id: 100, node_id: "REPO_NODE" });
      }
      if (url.endsWith("/graphql") && method === "POST") {
        return json({ data: { updateRefs: { clientMutationId: null } } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const provider = createProvider(implementation);
    await expect(provider.updateExistingDraft(proposal, content)).resolves.toEqual({
      requestId: "REQUEST_1",
      status: "accepted",
    });
    const graphql = calls.find(({ url }) => url.endsWith("/graphql"))?.body as {
      query: string;
      variables: Record<string, string>;
    };
    expect(graphql.query).toContain("updateRefs");
    expect(graphql.variables).toEqual({
      afterOid: newCommit,
      beforeOid: head,
      name: `refs/heads/${proposal.branchName}`,
      repositoryId: "REPO_NODE",
    });
    observedHead = newCommit;
    const observed = (await provider.inspectExistingDraft({
      name: proposal.name,
      number: proposal.pullRequestNumber,
      owner: proposal.owner,
      repositoryId: proposal.repositoryId,
    })) as ExistingDraftObservation;
    expect(observed.verifiedBuilderOrigin).toEqual({
      appId: "123",
      authorId: "900",
      marker: "d".repeat(64),
    });
    await expect(provider.inspectAppliedDraftUpdate(proposal, content, observed)).resolves.toBe(
      true,
    );
    recoveredMessage = "A same-content commit from elsewhere";
    await expect(provider.inspectAppliedDraftUpdate(proposal, content, observed)).resolves.toBe(
      false,
    );
  });
});

describe("existing draft reconciliation provider", () => {
  it("creates a reviewed two-parent merge commit and advances the draft by exact head CAS", async () => {
    const head = "3".repeat(40);
    const headTree = "4".repeat(40);
    const base = "8".repeat(40);
    const baseTree = "9".repeat(40);
    const resolvedTree = "7".repeat(40);
    const mergeCommit = "5".repeat(40);
    const branchName = `app-builder/review-${"d".repeat(20)}`;
    const filePath = "apps/demo/page.tsx";
    const bytes = new TextEncoder().encode("export default null;\n");
    const fileDigest = createHash("sha256").update(bytes).digest("hex");
    const changes = [
      { after: { digest: fileDigest, mode: "644" }, bytes, kind: "added" as const, path: filePath },
    ];
    const metadata = changes.map(({ bytes: _bytes, ...change }) => change);
    const proposal: ExistingDraftReconciliationProposal = {
      approvedPaths: [filePath],
      baseBranch: "main",
      baseChangesDigest: hash(metadata),
      branchName,
      digest: "a".repeat(64),
      expectedBaseSha: base,
      expectedBaseTree: baseTree,
      expectedHeadSha: head,
      expectedHeadTree: headTree,
      headChangesDigest: "b".repeat(64),
      idempotencyKey: "c".repeat(64),
      installationIdentityDigest: "e".repeat(64),
      intendedOutcome: "reconcile-existing-draft-pull-request",
      name: "example-app",
      originMarker: "d".repeat(64),
      owner: "withAutograph",
      priorPublicationDigest: "f".repeat(64),
      pullRequestId: "150000",
      pullRequestNumber: 1500,
      repositoryId: "100",
      resolvedTree,
      reviewDigest: "0".repeat(64),
      version: 1,
    };
    const content: ReconciliationContent = {
      changes,
      kind: "draft-reconciliation",
      reviewDigest: proposal.reviewDigest,
      version: 1,
    };
    const calls: { url: string; body: unknown }[] = [];
    let observedHead = head;
    // oxlint-disable-next-line eslint/complexity, eslint/require-await, sonarjs/cognitive-complexity -- focused GitHub HTTP double
    const implementation: typeof fetch = async (request, init = {}) => {
      const url = String(request);
      const method = init.method ?? "GET";
      const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ body, url });
      if (url.endsWith("/app")) return json({ id: 123, slug: "autograph-app-builder" });
      if (url.endsWith("/app/installations/456/access_tokens"))
        return json(
          {
            permissions: (body as { permissions: unknown }).permissions,
            token: "ghs_operation_scoped_installation_token",
          },
          201,
        );
      if (url.endsWith("/repositories/100"))
        return json({
          default_branch: "main",
          id: 100,
          name: "example-app",
          owner: { login: "withAutograph" },
          private: true,
        });
      if (url.endsWith("/repos/withAutograph/example-app/actions/variables?per_page=100&page=1"))
        return json({ variables: [] });
      if (url.endsWith("/repos/withAutograph/example-app/pulls/1500"))
        return json({
          base: { ref: "main", repo: { id: 100 } },
          body: `<!-- App-Builder-Idempotency: ${"d".repeat(64)} -->`,
          draft: true,
          head: { ref: branchName, repo: { id: 100 }, sha: observedHead },
          id: 150_000,
          number: 1500,
          state: "open",
          user: { id: 900, login: "autograph-app-builder[bot]", type: "Bot" },
        });
      if (url.endsWith(`/git/ref/heads/${branchName}`))
        return json({ node_id: "REF_NODE", object: { sha: observedHead } });
      if (url.endsWith(`/commits/${head}`))
        return json({
          commit: {
            message: `Add demo\n\nApp-Builder-Idempotency: ${"d".repeat(64)}`,
            tree: { sha: headTree },
          },
          sha: head,
        });
      if (url.endsWith("/commits/HEAD"))
        return json({ commit: { tree: { sha: baseTree } }, sha: base });
      if (url.endsWith(`/commits/${base}`) || url.endsWith("/commits/refs/heads/main"))
        return json({ commit: { tree: { sha: baseTree } }, sha: base });
      if (url.endsWith(`/git/commits/${mergeCommit}`))
        return json({
          message: `Reconcile draft pull request #1500 with main\n\nApp-Builder-Idempotency: ${proposal.idempotencyKey}\nApp-Builder-Origin: ${proposal.originMarker}`,
          parents: [{ sha: head }, { sha: base }],
          tree: { sha: resolvedTree },
        });
      if (url.endsWith(`/commits/${mergeCommit}`))
        return json({
          commit: {
            message: `Reconcile draft pull request #1500 with main\n\nApp-Builder-Idempotency: ${proposal.idempotencyKey}\nApp-Builder-Origin: ${proposal.originMarker}`,
            tree: { sha: resolvedTree },
          },
          sha: mergeCommit,
        });
      if (url.endsWith(`/git/trees/${baseTree}`) && method === "GET")
        return json({ tree: [], truncated: false });
      if (url.endsWith("/git/blobs") && method === "POST")
        return json({ sha: "6".repeat(40) }, 201);
      if (url.endsWith("/git/trees") && method === "POST") return json({ sha: resolvedTree }, 201);
      if (url.endsWith("/git/commits") && method === "POST") return json({ sha: mergeCommit }, 201);
      if (url.endsWith("/repos/withAutograph/example-app") && method === "GET")
        return json({ id: 100, node_id: "REPO_NODE" });
      if (url.endsWith("/graphql") && method === "POST") {
        observedHead = mergeCommit;
        return json({ data: { updateRefs: { clientMutationId: null } } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const provider = createProvider(implementation);
    await expect(provider.reconcileExistingDraft(proposal, content)).resolves.toEqual({
      requestId: "REQUEST_1",
      status: "accepted",
    });
    const mergeBody = calls.find(({ url }) => url.endsWith("/git/commits"))?.body as {
      parents: string[];
      tree: string;
    };
    expect(mergeBody).toMatchObject({ parents: [head, base], tree: resolvedTree });
    const graphql = calls.find(({ url }) => url.endsWith("/graphql"))?.body as {
      query: string;
      variables: Record<string, string>;
    };
    expect(graphql.query).toContain("force: false");
    expect(graphql.variables).toMatchObject({
      afterOid: mergeCommit,
      beforeOid: head,
      name: `refs/heads/${branchName}`,
    });
    const observed = (await provider.inspectExistingDraft({
      name: proposal.name,
      number: proposal.pullRequestNumber,
      owner: proposal.owner,
      repositoryId: proposal.repositoryId,
    })) as ExistingDraftObservation;
    await expect(provider.inspectAppliedDraftReconciliation(proposal, observed)).resolves.toBe(
      true,
    );
  });
});
