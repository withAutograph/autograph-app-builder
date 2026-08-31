import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ARRUSTED_TEMPLATE_REPOSITORY_ID,
  createArrustedTemplateReader,
  readDeploymentArrustedTemplateReaderConfig,
} from "./arrusted-template-reader";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();

function json(value: unknown, status = 200) {
  return Response.json(value, { status });
}

function readerFetch(input?: {
  permissions?: Record<string, string>;
  repositorySelection?: "all" | "selected";
  tokenRepositoryIds?: number[];
  repository?: Record<string, unknown>;
  totalCount?: number;
  status?: number;
}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const implementation: typeof fetch = async (request, init = {}) => {
    const url = String(request);
    calls.push({ url, init });
    if (url.endsWith("/app/installations/456/access_tokens"))
      return json(
        {
          token: "ghs_reader_token_that_is_only_for_this_acquisition",
          expires_at: "2026-08-31T18:00:00Z",
          permissions: input?.permissions ?? {
            metadata: "read",
            contents: "read",
            checks: "read",
          },
          repository_selection: input?.repositorySelection ?? "all",
          repositories: (
            input?.tokenRepositoryIds ?? [ARRUSTED_TEMPLATE_REPOSITORY_ID]
          ).map((id) => ({ id })),
        },
        input?.status ?? 201,
      );
    if (url.includes("/installation/repositories?"))
      return json({
        total_count: input?.totalCount ?? 1,
        repositories: [
          input?.repository ?? {
            id: 100,
            full_name: "withAutograph/arrusted-development",
            private: true,
          },
        ],
      });
    throw new Error(`Unexpected GitHub request: ${url}`);
  };
  return { calls, implementation };
}

function reader(fetch: typeof globalThis.fetch) {
  return createArrustedTemplateReader({
    config: {
      appId: "123",
      privateKey: privateKeyPem,
      installationId: "456",
    },
    fetch,
  });
}

describe("Arrusted private template reader", () => {
  it("mints an exact read-only, one-repository token from the fixed installation", async () => {
    const mock = readerFetch();
    await expect(reader(mock.implementation).acquire()).resolves.toEqual({
      token: "ghs_reader_token_that_is_only_for_this_acquisition",
    });

    const tokenCall = mock.calls.find(({ url }) =>
      url.endsWith("/app/installations/456/access_tokens"),
    );
    expect(JSON.parse(String(tokenCall?.init.body))).toEqual({
      permissions: { contents: "read", checks: "read" },
      repository_ids: [ARRUSTED_TEMPLATE_REPOSITORY_ID],
    });
    expect(
      mock.calls.filter(({ url }) =>
        url.includes("/installation/repositories?"),
      ),
    ).toHaveLength(1);
  });

  it.each([
    {
      permissions: {
        metadata: "read",
        contents: "read",
        checks: "read",
        issues: "read",
      },
    },
    { tokenRepositoryIds: [101] },
    {
      repository: {
        id: 101,
        full_name: "withAutograph/another-private-repository",
        private: true,
      },
    },
    { totalCount: 2 },
  ])("rejects a broader token or mismatched repository %#", async (input) => {
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
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: privateKeyPem,
        APP_BUILDER_TEMPLATE_READER_INSTALLATION_ID: "456",
        GITHUB_TOKEN: "forbidden-ambient-token",
      }),
    ).not.toThrow();
  });
});
