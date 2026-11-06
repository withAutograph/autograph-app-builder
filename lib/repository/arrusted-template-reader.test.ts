import { generateKeyPairSync } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ARRUSTED_TEMPLATE_REPOSITORY_ID,
  createArrustedTemplateReader,
  readDeploymentArrustedTemplateReaderConfig,
} from "./arrusted-template-reader";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" });

afterEach(() => {
  vi.restoreAllMocks();
});

type ReaderJson =
  | {
      expires_at: string;
      permissions: Record<string, string>;
      repositories: { id: number }[];
      repository_selection: string;
      token: string;
    }
  | { repositories: { full_name: string; id: number; private: boolean }[]; total_count: number };

type ReaderPermission = "checks" | "contents" | "issues" | "metadata";
type ReaderPermissions = Partial<Record<ReaderPermission, "read" | "write">>;
type ReaderFetchRequest = string | URL | Request;

const json = (value: ReaderJson, status = 200): Response => Response.json(value, { status });

const readerFetch = (input?: {
  permissions?: ReaderPermissions;
  repositorySelection?: "all" | "selected";
  tokenRepositoryIds?: number[];
  repository?: { full_name: string; id: number; private: boolean };
  totalCount?: number;
  status?: number;
}) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const implementation: typeof fetch = async (request: ReaderFetchRequest, init = {}) => {
    const url = new URL(request instanceof Request ? request.url : request).href;
    calls.push({ init, url });
    if (url.endsWith("/app/installations/456/access_tokens")) {
      return json(
        {
          expires_at: "2026-08-31T18:00:00Z",
          permissions: input?.permissions ?? {
            contents: "read",
            metadata: "read",
          },
          repositories: (input?.tokenRepositoryIds ?? [ARRUSTED_TEMPLATE_REPOSITORY_ID]).map(
            (id) => ({ id }),
          ),
          repository_selection: input?.repositorySelection ?? "all",
          token: "ghs_reader_token_that_is_only_for_this_acquisition",
        },
        input?.status ?? 201,
      );
    }
    if (url.includes("/installation/repositories?")) {
      return json({
        repositories: [
          input?.repository ?? {
            full_name: "withAutograph/arrusted-development",
            id: ARRUSTED_TEMPLATE_REPOSITORY_ID,
            private: true,
          },
        ],
        total_count: input?.totalCount ?? 1,
      });
    }
    throw new Error(`Unexpected GitHub request: ${url}`);
  };
  return { calls, implementation };
};

const reader = (fetch: typeof globalThis.fetch) =>
  createArrustedTemplateReader({
    config: {
      appId: "123",
      installationId: "456",
      privateKey: privateKeyPem,
    },
    fetch,
  });

describe("Arrusted private template reader", () => {
  it("mints an exact read-only, one-repository token from the fixed installation", async () => {
    const mock = readerFetch();
    await expect(reader(mock.implementation).acquire()).resolves.toEqual({
      token: "ghs_reader_token_that_is_only_for_this_acquisition",
    });

    const tokenCall = mock.calls.find(({ url }) =>
      url.endsWith("/app/installations/456/access_tokens"),
    );
    if (tokenCall === undefined) {
      throw new Error("Expected the installation token request");
    }
    const parsedTokenBody: unknown = await new Response(tokenCall.init.body).json();
    expect(parsedTokenBody).toEqual({
      permissions: { contents: "read" },
      repository_ids: [ARRUSTED_TEMPLATE_REPOSITORY_ID],
    });
    expect(
      mock.calls.filter(({ url }) => url.includes("/installation/repositories?")),
    ).toHaveLength(1);
  });

  it("accepts additional read-only permissions on a repository-scoped token", async () => {
    const mock = readerFetch({
      permissions: {
        checks: "read",
        contents: "read",
        issues: "read",
        metadata: "read",
      },
    });

    await expect(reader(mock.implementation).acquire()).resolves.toEqual({
      token: "ghs_reader_token_that_is_only_for_this_acquisition",
    });
  });

  it("records only a sanitized failure stage when token minting fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mock = readerFetch({ status: 403 });

    await expect(reader(mock.implementation).acquire()).rejects.toThrow(
      "template reader is unavailable",
    );

    expect(warning).toHaveBeenCalledWith(
      JSON.stringify({
        event: "autograph.template-reader.failed",
        stage: "token_mint",
      }),
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain(privateKeyPem);
    expect(JSON.stringify(warning.mock.calls)).not.toContain("ghs_");
  });

  it.each([
    {
      permissions: {
        checks: "read",
        contents: "read",
        issues: "write",
        metadata: "read",
      },
    },
    { tokenRepositoryIds: [101] },
    {
      repository: {
        full_name: "withAutograph/another-private-repository",
        id: 101,
        private: true,
      },
    },
    {
      repository: {
        full_name: "withAutograph/arrusted-development",
        id: ARRUSTED_TEMPLATE_REPOSITORY_ID + 1,
        private: true,
      },
    },
    { totalCount: 2 },
  ])("rejects a write-capable token or mismatched repository %#", async (input) => {
    const mock = readerFetch(input);
    await expect(reader(mock.implementation).acquire()).rejects.toThrow(
      "template reader is unavailable",
    );
  });

  it("fails closed when the deployment-owned reader configuration is absent", () => {
    expect(() => readDeploymentArrustedTemplateReaderConfig({})).toThrow(
      "template reader is unavailable",
    );
    expect(() =>
      readDeploymentArrustedTemplateReaderConfig({
        APP_BUILDER_TEMPLATE_READER_INSTALLATION_ID: "456",
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: privateKeyPem,
        GITHUB_TOKEN: "forbidden-ambient-token",
      }),
    ).not.toThrow();
  });
});
