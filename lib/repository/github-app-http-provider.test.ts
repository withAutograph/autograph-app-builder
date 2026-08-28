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
  type FreshRepositoryProposal,
} from "./github-publication";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function freshProposal(): FreshRepositoryProposal {
  const installationIdentityDigest = "1".repeat(64);
  const sourceReceiptDigest = "2".repeat(64);
  const reviewDigest = "3".repeat(64);
  const idempotencyKey = hash({
    installationIdentityDigest,
    destinationOwner: "withAutograph",
    destinationName: "new-app",
    sourceReceiptDigest,
    reviewDigest,
  });
  const unsigned = {
    version: GITHUB_PUBLICATION_VERSION,
    installationIdentityDigest,
    destinationOwner: "withAutograph",
    destinationName: "new-app",
    visibility: "private" as const,
    defaultBranch: "main" as const,
    sourceReceiptDigest,
    sourceSha: "4".repeat(40),
    sourceTree: "5".repeat(40),
    contractDigest: "6".repeat(64),
    eligibilityDigest: "7".repeat(64),
    reviewDigest,
    changeSetDigest: "8".repeat(64),
    releaseGate: {
      name: "REPOSITORY_RELEASE_ENABLED" as const,
      configured: false as const,
    },
    initialCommitMessage:
      "Initialize repository from supported template" as const,
    idempotencyKey,
    intendedOutcome: "create-private-fresh-history-repository" as const,
  };
  return { ...unsigned, digest: hash(unsigned) };
}

function json(value: unknown, status = 200, requestId = "REQUEST_1") {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "x-github-request-id": requestId,
    },
  });
}

function providerFetch(input?: { extraPermission?: boolean; fail?: boolean }) {
  const calls: Array<{ url: string; init: RequestInit; body: unknown }> = [];
  const implementation: typeof fetch = async (request, init = {}) => {
    const url = String(request);
    let body: unknown = undefined;
    if (typeof init.body === "string") body = JSON.parse(init.body) as unknown;
    calls.push({ url, init, body });
    if (input?.fail) return json({ message: "private-key-material" }, 500);
    if (url.endsWith("/app/installations/456")) {
      return json({
        id: 456,
        account: { id: 789, login: "withAutograph", type: "Organization" },
        repository_selection: "selected",
      });
    }
    if (url.endsWith("/app/installations/456/access_tokens")) {
      const requested = (body as { permissions: Record<string, string> })
        .permissions;
      return json(
        {
          token: "ghs_operation_scoped_installation_token",
          permissions: {
            ...requested,
            ...(input?.extraPermission ? { issues: "write" } : {}),
          },
        },
        201,
      );
    }
    if (url.includes("/installation/repositories?")) {
      return json({ repositories: [{ id: 100 }, { id: 200 }] });
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
        appId: "123",
        installationId: "456",
        privateKey: privateKeyPem,
        apiOrigin: "https://example.invalid",
      }),
    ).toThrow("configuration is invalid");
    expect(() =>
      parseGitHubAppHttpProviderCredentials({
        GITHUB_APP_ID: "123",
        GITHUB_APP_INSTALLATION_ID: "456",
        GITHUB_APP_PRIVATE_KEY: privateKeyPem,
        GITHUB_API_URL: "https://example.invalid",
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
      const adapter = createGitHubAppPublicationAdapter(
        createProvider(mock.implementation),
      );
      const identity = await adapter.inspectInstallation(operation);
      expect(identity.selectedRepositoryIds).toEqual(["100", "200"]);
      expect(identity.permissions).toMatchObject({ contents, workflows });

      const appCall = mock.calls.find(({ url }) =>
        url.endsWith("/app/installations/456"),
      );
      const tokenCall = mock.calls.find(({ url }) =>
        url.endsWith("/app/installations/456/access_tokens"),
      );
      expect(
        mock.calls.every(({ url }) =>
          url.startsWith("https://api.github.com/"),
        ),
      ).toBe(true);
      expect(appCall?.init.redirect).toBe("error");
      const authorization = (appCall?.init.headers as Record<string, string>)
        .Authorization;
      const jwt = authorization.replace(/^Bearer /u, "");
      expect(decodeProtectedHeader(jwt)).toEqual({ alg: "RS256", typ: "JWT" });
      expect(decodeJwt(jwt)).toMatchObject({ iss: "123" });
      expect(decodeJwt(jwt).exp! - decodeJwt(jwt).iat!).toBe(540);
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
        url,
        body,
      }));
      expect(JSON.stringify(publicRequestSurface)).not.toContain(privateKeyPem);
      expect(JSON.stringify(publicRequestSurface)).not.toContain(
        "ghs_operation_scoped_installation_token",
      );
    },
  );

  it("rejects an escalated token response and sanitizes transport bodies", async () => {
    const escalated = createGitHubAppPublicationAdapter(
      createProvider(providerFetch({ extraPermission: true }).implementation),
    );
    await expect(
      escalated.inspectInstallation("resolve-existing-source"),
    ).rejects.toThrow("GitHub provider operation failed.");

    const failed = createGitHubAppPublicationAdapter(
      createProvider(providerFetch({ fail: true }).implementation),
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
        version: 1,
        kind: "fresh-repository-source-tree",
        sourceSha: "4".repeat(40),
        sourceTree: "5".repeat(40),
        files: [
          {
            path: ".github/workflows/ci.yml",
            mode: "100644",
            objectId: "0".repeat(40),
            digest: createHash("sha256").update(bytes).digest("hex"),
            bytes,
          },
        ],
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "invalid-publication-material",
    });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.init.method ?? "GET").toBe("GET");
  });
});
