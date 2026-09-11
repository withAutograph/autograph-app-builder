import { createHash, generateKeyPairSync } from "node:crypto";

import { decodeJwt, decodeProtectedHeader } from "jose";
import { describe, expect, it } from "vitest";

import { createGitHubAppPublicationAdapter } from "./github-app-adapter";
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
} from "./github-publication";
import type {
  GitHubDraftPullRequestContent,
  FreshRepositoryProposal,
} from "./github-publication";
import { createReviewedChangeSetReceipt } from "./reviewed-change-set";
import type { NormalizedChangeSet } from "./reviewed-change-set";
import { compareOverlayPaths } from "./target-apply";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey
  .export({ format: "pem", type: "pkcs8" })
  .toString();
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const sourceSha = "1".repeat(40);
const sourceTree = "2".repeat(40);

function unicodeDraftMaterial() {
  const bytes = new TextEncoder().encode("export default null;\n");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const changes = [
    ".codex/skills/example/agents/openai.yaml",
    ".codex/skills/example/SKILL.md",
    "apps/demo/\u{E000}.tsx",
    "apps/demo/\u{10000}.tsx",
  ]
    .map((path) => ({
      after: { digest, mode: "644" },
      kind: "added" as const,
      path,
    }))
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
    })),
    kind: "draft-reviewed-change-set",
    reviewDigest: review.digest,
    version: 1,
  };
  return { content, proposal };
}

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
    initialCommitMessage:
      "Initialize repository from supported template" as const,
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

function json(value: unknown, status = 200, requestId = "REQUEST_1") {
  return new Response(JSON.stringify(value), {
    headers: {
      "content-type": "application/json",
      "x-github-request-id": requestId,
    },
    status,
  });
}

function providerFetch(input?: {
  extraPermission?: boolean;
  fail?: boolean;
  repositorySelection?: "all" | "selected";
  repositoryPages?: Array<number | string>[];
}) {
  const calls: { url: string; init: RequestInit; body: unknown }[] = [];
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
      const requested = (body as { permissions: Record<string, string> })
        .permissions;
      return json(
        {
          permissions: {
            ...requested,
            ...(input?.extraPermission ? { issues: "write" } : {}),
          },
          token: "ghs_operation_scoped_installation_token",
        },
        201
      );
    }
    if (url.includes("/installation/repositories?")) {
      const page = Number(new URL(url).searchParams.get("page"));
      const repositoryIds = input?.repositoryPages?.[page - 1] ?? [100, 200];
      return json({ repositories: repositoryIds.map((id) => ({ id })) });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  return { calls, implementation };
}

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
  it("parses only the closed credential contract and rejects endpoint or token overrides", () => {
    expect(
      parseGitHubAppHttpProviderCredentials({
        appId: "123",
        privateKey: privateKeyPem,
      })
    ).toEqual({ appId: "123", privateKey: privateKeyPem });
    expect(
      parseGitHubAppHttpProviderConfig({
        appId: "123",
        installationId: "456",
        privateKey: privateKeyPem,
      })
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
      })
    ).toThrow("configuration is invalid");
    expect(() =>
      parseGitHubAppHttpProviderCredentials({
        GITHUB_API_URL: "https://example.invalid",
        GITHUB_APP_ID: "123",
        GITHUB_APP_INSTALLATION_ID: "456",
        GITHUB_APP_PRIVATE_KEY: privateKeyPem,
      })
    ).toThrow("configuration is invalid");
    expect(() =>
      parseGitHubAppHttpProviderCredentials({
        appId: "123",
        privateKey: "not-a-key",
      })
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
      const adapter = createGitHubAppPublicationAdapter(
        createProvider(mock.implementation)
      );
      const identity = await adapter.inspectInstallation(operation);
      expect(identity.selectedRepositoryIds).toEqual(["100", "200"]);
      expect(identity.permissions).toMatchObject({ contents, workflows });

      const appCall = mock.calls.find(({ url }) =>
        url.endsWith("/app/installations/456")
      );
      const tokenCall = mock.calls.find(({ url }) =>
        url.endsWith("/app/installations/456/access_tokens")
      );
      expect(
        mock.calls.every(({ url }) => url.startsWith("https://api.github.com/"))
      ).toBe(true);
      expect(appCall?.init.redirect).toBe("error");
      const authorization = new Headers(appCall?.init.headers).get(
        "authorization"
      )!;
      const jwt = authorization.replace(/^bearer /iu, "");
      expect(decodeProtectedHeader(jwt)).toEqual({ alg: "RS256", typ: "JWT" });
      expect(decodeJwt(jwt)).toMatchObject({ iss: "123" });
      expect(decodeJwt(jwt).exp! - decodeJwt(jwt).iat!).toBe(600);
      expect(tokenCall?.body).toEqual({
        permissions: {
          metadata: "read",
          contents,
          ...(workflows === "write" ? { workflows } : {}),
          actions_variables: "read",
          ...(pullRequests === undefined
            ? {}
            : { pull_requests: pullRequests }),
          ...(administration === undefined ? {} : { administration }),
        },
      });
      const publicRequestSurface = mock.calls.map(({ url, body }) => ({
        body,
        url,
      }));
      expect(JSON.stringify(publicRequestSurface)).not.toContain(privateKeyPem);
      expect(JSON.stringify(publicRequestSurface)).not.toContain(
        "ghs_operation_scoped_installation_token"
      );
    }
  );

  it("mints only a contents-read credential for the exact source repository", async () => {
    const mock = providerFetch();
    const provider = createProvider(mock.implementation);

    await expect(
      provider.acquireRepositoryReadCredential({ repositoryId: "200" })
    ).resolves.toEqual({
      token: "ghs_operation_scoped_installation_token",
    });
    expect(
      mock.calls.find(({ url }) =>
        url.endsWith("/app/installations/456/access_tokens")
      )?.body
    ).toEqual({
      permissions: { contents: "read" },
      repository_ids: [200],
    });

    let message = "";
    try {
      await createProvider(
        providerFetch({ extraPermission: true }).implementation
      ).acquireRepositoryReadCredential({ repositoryId: "200" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("GitHub provider operation failed.");
    expect(message).not.toContain("ghs_operation_scoped_installation_token");
    expect(message).not.toContain(privateKeyPem);
  });

  it("preserves an all-repositories installation through the adapter", async () => {
    const adapter = createGitHubAppPublicationAdapter(
      createProvider(
        providerFetch({ repositorySelection: "all" }).implementation
      )
    );

    await expect(
      adapter.inspectInstallation("resolve-existing-source")
    ).resolves.toMatchObject({
      repositorySelection: "all",
      selectedRepositoryIds: ["100", "200"],
    });
  });

  it("continues all-repository pagination beyond five full pages", async () => {
    const pages = Array.from({ length: 5 }, (_, page) =>
      Array.from({ length: 100 }, (_, index) => page * 100 + index + 1)
    );
    pages.push([501]);
    const mock = providerFetch({
      repositoryPages: pages,
      repositorySelection: "all",
    });
    const adapter = createGitHubAppPublicationAdapter(
      createProvider(mock.implementation)
    );

    await expect(
      adapter.inspectInstallation("resolve-existing-source")
    ).resolves.toMatchObject({
      repositorySelection: "all",
      selectedRepositoryIds: expect.arrayContaining(["1", "500", "501"]),
    });
    expect(
      mock.calls.filter(({ url }) =>
        url.includes("/installation/repositories?")
      )
    ).toHaveLength(6);
  });

  it("rejects repository IDs that cannot round-trip as safe JSON integers", async () => {
    const provider = createProvider(providerFetch().implementation);

    await expect(
      provider.inspectRepository({
        ref: "main",
        repositoryId: "9007199254740993",
      })
    ).rejects.toThrow("invalid-response");
  });

  it("rejects an escalated token response and sanitizes transport bodies", async () => {
    const escalated = createGitHubAppPublicationAdapter(
      createProvider(providerFetch({ extraPermission: true }).implementation)
    );
    await expect(
      escalated.inspectInstallation("resolve-existing-source")
    ).rejects.toThrow("GitHub provider operation failed.");

    const failed = createGitHubAppPublicationAdapter(
      createProvider(providerFetch({ fail: true }).implementation)
    );
    let message = "";
    try {
      await failed.inspectInstallation("resolve-existing-source");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("GitHub provider operation failed.");
    expect(message).not.toContain("private-key-material");
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
            path: ".github/workflows/ci.yml",
            mode: "100644",
            objectId: "0".repeat(40),
            digest: createHash("sha256").update(bytes).digest("hex"),
            bytes,
          },
        ],
        kind: "fresh-repository-source-tree",
        sourceSha: "4".repeat(40),
        sourceTree: "5".repeat(40),
        version: 1,
      })
    ).resolves.toEqual({
      code: "invalid-publication-material",
      status: "rejected",
    });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.init.method ?? "GET").toBe("GET");
  });

  it("round-trips UTF-8 ordered draft material through the HTTP provider", async () => {
    const calls: string[] = [];
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
          201
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
      if (
        url.endsWith(
          "/repos/withAutograph/example-app/actions/variables?per_page=100&page=1"
        )
      ) {
        return json({ variables: [] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const provider = createProvider(implementation);
    const { proposal, content } = unicodeDraftMaterial();

    await expect(
      provider.publishDraftPullRequest(proposal, content)
    ).resolves.toEqual({ code: "stale-base", status: "rejected" });
    expect(calls).toHaveLength(4);
  });
});
