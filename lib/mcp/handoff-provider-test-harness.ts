import { generateKeyPairSync } from "node:crypto";

import { expect, vi } from "vitest";

import { createPreparedHandoffReader } from "../agent/handoff-context";
import {
  createPreparedAppContextReader,
  readPreparedVercelAccess,
} from "../agent/prepared-provider-context";
import type { HostedPrincipal } from "../eve/hosted-auth";
import type { BuilderHandoffStore } from "../handoff/service";
import { exactForwardedSessionAuthority } from "../hosted/session-authority";
import type { HostedSessionTenantAuthority } from "../hosted/session-authority";
import { classifyGitHubRepositoryAccess } from "../integrations/repository-access";
import { initialBuilderProvisionJournalRecord } from "../provisioning/journal";
import type { BuilderProvisionJournalRow } from "../provisioning/journal";
import { createGitHubAppHttpProvider } from "../repository/github-app-http-provider";

export function preparedJournal(
  authority: HostedSessionTenantAuthority,
  requestId: string
): BuilderProvisionJournalRow {
  const now = new Date();
  const record = initialBuilderProvisionJournalRecord(
    {
      appName: "Prepared Vendor Review",
      operation: "github",
      providers: {
        githubInstallationId: "10",
        vercelInstallationId: "icfg_prepared",
      },
      repository: { name: "prepared-vendor-review", private: true },
      requestId,
      version: 1,
    },
    now
  );
  record.response.status = "settled";
  record.response.github = {
    defaultBranch: "main",
    fullName: "acme/prepared-vendor-review",
    headSha: "a".repeat(40),
    headTree: "b".repeat(40),
    installationId: "10",
    name: "prepared-vendor-review",
    owner: "acme",
    repositoryId: "100",
    scope: { id: "110", login: "acme", type: "organization" },
    starter: { sourceSha: "c".repeat(40), sourceTree: "d".repeat(40) },
    status: "succeeded",
    url: "https://github.com/acme/prepared-vendor-review",
    visibility: "private",
  };
  record.response.vercel = {
    dashboardUrl: "https://vercel.com/acme/prepared-vendor-review",
    framework: "nextjs",
    installationId: "icfg_prepared",
    linkedGitHubRepository: "acme/prepared-vendor-review",
    name: "prepared-vendor-review",
    projectId: "prj_prepared",
    rootDirectory: "apps/prepared-vendor-review",
    scope: { id: "team_prepared", slug: "acme", type: "team" },
    status: "succeeded",
  };
  record.operations.github.attempted = true;
  record.operations.vercel.attempted = true;
  return {
    authority,
    createdAt: now,
    record,
    requestDigest: record.response.requestDigest,
    requestId,
    revision: 2,
    state: "settled",
    updatedAt: now,
  };
}

/** Reconstruct the trusted engine envelope from the verified MCP transport input. */
export function sessionEnvelope(
  principal: HostedPrincipal,
  sourceHandoffId: string
) {
  const current = {
    attributes: {
      "autograph:source-handoff-id": sourceHandoffId,
      "mcp:audience": principal.audience,
      "mcp:scopes": principal.scopes,
      "mcp:workspace-id": principal.workspaceId,
    },
    authenticator: "mcp-oauth-jwks",
    issuer: principal.issuer,
    principalId: principal.ownerUserId,
    principalType: "user",
    subject: principal.ownerUserId,
  };
  return { current, initiator: structuredClone(current) };
}

/** Real provider adapters with injected HTTP mocks; no running emulators or live providers. */
export function preparedProviderFixture(input: {
  authority: HostedSessionTenantAuthority;
  handoffs: BuilderHandoffStore;
  isActiveMember(authority: HostedSessionTenantAuthority): Promise<boolean>;
}) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  let credentialRevision = 1;
  let vercelStatus = 200;
  const githubToken = () =>
    `ghs_mock_server_installation_token_${credentialRevision}`;
  const vercelToken = () => `mock_server_vercel_token_${credentialRevision}`;
  const githubHttp = vi.fn<typeof fetch>(async (request, init) => {
    const url = new URL(String(request));
    expect(url.origin).toBe("https://api.github.com");
    const headers = new Headers(init?.headers);
    if (url.pathname.startsWith("/app/installations/")) {
      expect(url.pathname).toMatch(
        /^\/app\/installations\/10(?:\/access_tokens)?$/u
      );
      // App JWT is minted server-side; it must not be the user's MCP bearer.
      expect(headers.get("authorization")).toMatch(/^bearer ey/iu);
      if (url.pathname.endsWith("/access_tokens")) {
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body));
        expect(
          Object.values(body.permissions).every(
            (permission) => permission === "read"
          )
        ).toBe(true);
        return Response.json(
          {
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            permissions: body.permissions,
            token: githubToken(),
          },
          { status: 201 }
        );
      }
      return Response.json({
        account: { id: 110, login: "acme", type: "Organization" },
        id: 10,
        repository_selection: "selected",
      });
    }
    expect(init?.method ?? "GET").toBe("GET");
    expect(headers.get("authorization")).toBe(`token ${githubToken()}`);
    if (url.pathname === "/installation/repositories") {
      return Response.json({ repositories: [{ id: 100 }] });
    }
    if (
      ["/repositories/100", "/repos/acme/prepared-vendor-review"].includes(
        url.pathname
      )
    ) {
      return Response.json({
        id: 100,
        owner: { login: "acme" },
        name: "prepared-vendor-review",
        private: true,
        archived: false,
        default_branch: "main",
      });
    }
    if (url.pathname === "/repos/acme/prepared-vendor-review/commits/main") {
      return Response.json({
        sha: "a".repeat(40),
        commit: { tree: { sha: "b".repeat(40) } },
      });
    }
    if (
      url.pathname === "/repos/acme/prepared-vendor-review/actions/variables"
    ) {
      return Response.json({ variables: [] });
    }
    throw new Error("Unexpected mocked GitHub request.");
  });
  const vercelHttp = vi.fn<typeof fetch>(async (request, init) => {
    expect(String(request)).toBe(
      "https://api.vercel.com/v9/projects/prj_prepared?teamId=team_prepared"
    );
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${vercelToken()}`
    );
    return vercelStatus === 200
      ? Response.json({
          accountId: "team_prepared",
          id: "prj_prepared",
          name: "observed-project-name",
          privateIgnoredField: vercelToken(),
        })
      : new Response(null, { status: vercelStatus });
  });
  const credentialRead = vi.fn(
    async (value: {
      authority: HostedSessionTenantAuthority;
      installationId: string;
    }) => {
      expect(value).toEqual({
        authority: input.authority,
        installationId: "icfg_prepared",
      });
      return {
        binding: {
          active: true,
          displayName: "Acme",
          installationId: "icfg_prepared",
          plan: "pro",
          scopeId: "team_prepared",
          scopeType: "team" as const,
          slug: "acme",
          updatedAt: new Date(),
        },
        token: vercelToken(),
      };
    }
  );
  const selectedInstallation = {
    accountId: "110",
    accountLogin: "acme",
    accountType: "Organization" as const,
    active: true,
    installationId: "10",
    updatedAt: new Date(),
  };
  const github = vi.fn(
    async (
      sessionAuth: unknown,
      selection: { repository: string; selectedInstallationId?: string }
    ) => {
      const { authority } = exactForwardedSessionAuthority(sessionAuth);
      expect(authority).toEqual(input.authority);
      expect(selection).toEqual({
        repository: "acme/prepared-vendor-review",
        selectedInstallationId: "10",
      });
      return classifyGitHubRepositoryAccess({
        authority,
        ...selection,
        installations: {
          bind: vi.fn(),
          list: async (owner) => {
            expect(owner).toEqual(input.authority);
            return [
              selectedInstallation,
              { ...selectedInstallation, installationId: "20" },
            ];
          },
          read: async (owner) => {
            expect(owner).toEqual(input.authority);
            return undefined;
          },
        },
        providerFactory: ({ authority: owner, installation }) => {
          expect(owner).toEqual(input.authority);
          expect(installation.installationId).toBe("10");
          return createGitHubAppHttpProvider({
            config: {
              appId: "123",
              installationId: installation.installationId,
              privateKey: privateKeyPem,
            },
            fetch: githubHttp,
          });
        },
      });
    }
  );
  function createReader() {
    return createPreparedAppContextReader({
      github,
      readHandoff: createPreparedHandoffReader({
        read: input.handoffs.read,
        isActiveMember: input.isActiveMember,
      }),
      vercel: async (sessionAuth, intent) =>
        readPreparedVercelAccess({
          intent,
          authority: exactForwardedSessionAuthority(sessionAuth).authority,
          readCredential: credentialRead,
          fetch: vercelHttp,
        }),
    });
  }
  return {
    createReader,
    credentialRead,
    github,
    githubHttp,
    rotateCredentials: () => {
      credentialRevision += 1;
    },
    setVercelStatus: (status: number) => {
      vercelStatus = status;
    },
    vercelHttp,
  };
}
