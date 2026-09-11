import { generateKeyPairSync } from "node:crypto";
import { expect, vi } from "vitest";
import { createPreparedHandoffReader } from "../agent/handoff-context";
import {
  createPreparedAppContextReader,
  readPreparedVercelAccess,
} from "../agent/prepared-provider-context";
import {
  exactForwardedSessionAuthority,
  type HostedSessionTenantAuthority,
} from "../hosted/session-authority";
import type { HostedPrincipal } from "../eve/hosted-auth";
import type { BuilderHandoffStore } from "../handoff/service";
import { classifyGitHubRepositoryAccess } from "../integrations/repository-access";
import { createGitHubAppHttpProvider } from "../repository/github-app-http-provider";
import {
  initialBuilderProvisionJournalRecord,
  type BuilderProvisionJournalRow,
} from "../provisioning/journal";

export function preparedJournal(
  authority: HostedSessionTenantAuthority,
  requestId: string,
): BuilderProvisionJournalRow {
  const now = new Date();
  const record = initialBuilderProvisionJournalRecord(
    {
      version: 1,
      requestId,
      operation: "github",
      appName: "Prepared Vendor Review",
      repository: { name: "prepared-vendor-review", private: true },
      providers: {
        githubInstallationId: "10",
        vercelInstallationId: "icfg_prepared",
      },
    },
    now,
  );
  record.response.status = "settled";
  record.response.github = {
    status: "succeeded",
    installationId: "10",
    repositoryId: "100",
    owner: "acme",
    name: "prepared-vendor-review",
    fullName: "acme/prepared-vendor-review",
    url: "https://github.com/acme/prepared-vendor-review",
    scope: { type: "organization", id: "110", login: "acme" },
    visibility: "private",
    defaultBranch: "main",
    headSha: "a".repeat(40),
    headTree: "b".repeat(40),
    starter: { sourceSha: "c".repeat(40), sourceTree: "d".repeat(40) },
  };
  record.response.vercel = {
    status: "succeeded",
    installationId: "icfg_prepared",
    projectId: "prj_prepared",
    name: "prepared-vendor-review",
    dashboardUrl: "https://vercel.com/acme/prepared-vendor-review",
    scope: { type: "team", id: "team_prepared", slug: "acme" },
    framework: "nextjs",
    rootDirectory: "apps/prepared-vendor-review",
    linkedGitHubRepository: "acme/prepared-vendor-review",
  };
  record.operations.github.attempted = true;
  record.operations.vercel.attempted = true;
  return {
    authority,
    requestId,
    requestDigest: record.response.requestDigest,
    state: "settled",
    revision: 2,
    record,
    createdAt: now,
    updatedAt: now,
  };
}

/** Reconstruct the trusted engine envelope from the verified MCP transport input. */
export function sessionEnvelope(
  principal: HostedPrincipal,
  sourceHandoffId: string,
) {
  const current = {
    attributes: {
      "mcp:audience": principal.audience,
      "mcp:scopes": principal.scopes,
      "mcp:workspace-id": principal.workspaceId,
      "autograph:source-handoff-id": sourceHandoffId,
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
  isActiveMember: (authority: HostedSessionTenantAuthority) => Promise<boolean>;
}) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey
    .export({ type: "pkcs8", format: "pem" })
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
        /^\/app\/installations\/10(?:\/access_tokens)?$/u,
      );
      // App JWT is minted server-side; it must not be the user's MCP bearer.
      expect(headers.get("authorization")).toMatch(/^bearer ey/iu);
      if (url.pathname.endsWith("/access_tokens")) {
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body));
        expect(
          Object.values(body.permissions).every(
            (permission) => permission === "read",
          ),
        ).toBe(true);
        return Response.json(
          {
            token: githubToken(),
            permissions: body.permissions,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
          { status: 201 },
        );
      }
      return Response.json({
        id: 10,
        account: { id: 110, login: "acme", type: "Organization" },
        repository_selection: "selected",
      });
    }
    expect(init?.method ?? "GET").toBe("GET");
    expect(headers.get("authorization")).toBe(`token ${githubToken()}`);
    if (url.pathname === "/installation/repositories")
      return Response.json({ repositories: [{ id: 100 }] });
    if (
      ["/repositories/100", "/repos/acme/prepared-vendor-review"].includes(
        url.pathname,
      )
    )
      return Response.json({
        id: 100,
        owner: { login: "acme" },
        name: "prepared-vendor-review",
        private: true,
        archived: false,
        default_branch: "main",
      });
    if (url.pathname === "/repos/acme/prepared-vendor-review/commits/main")
      return Response.json({
        sha: "a".repeat(40),
        commit: { tree: { sha: "b".repeat(40) } },
      });
    if (url.pathname === "/repos/acme/prepared-vendor-review/actions/variables")
      return Response.json({ variables: [] });
    throw new Error("Unexpected mocked GitHub request.");
  });
  const vercelHttp = vi.fn<typeof fetch>(async (request, init) => {
    expect(String(request)).toBe(
      "https://api.vercel.com/v9/projects/prj_prepared?teamId=team_prepared",
    );
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${vercelToken()}`,
    );
    return vercelStatus === 200
      ? Response.json({
          id: "prj_prepared",
          name: "observed-project-name",
          accountId: "team_prepared",
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
        token: vercelToken(),
        binding: {
          installationId: "icfg_prepared",
          active: true,
          scopeId: "team_prepared",
          scopeType: "team" as const,
          slug: "acme",
          displayName: "Acme",
          plan: "pro",
          updatedAt: new Date(),
        },
      };
    },
  );
  const selectedInstallation = {
    installationId: "10",
    accountId: "110",
    accountLogin: "acme",
    accountType: "Organization" as const,
    active: true,
    updatedAt: new Date(),
  };
  const github = vi.fn(
    async (
      sessionAuth: unknown,
      selection: { repository: string; selectedInstallationId?: string },
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
          read: async (owner) => {
            expect(owner).toEqual(input.authority);
            return undefined;
          },
          list: async (owner) => {
            expect(owner).toEqual(input.authority);
            return [
              selectedInstallation,
              { ...selectedInstallation, installationId: "20" },
            ];
          },
          bind: vi.fn(),
        },
        providerFactory: ({ authority: owner, installation }) => {
          expect(owner).toEqual(input.authority);
          expect(installation.installationId).toBe("10");
          return createGitHubAppHttpProvider({
            config: {
              appId: "123",
              privateKey: privateKeyPem,
              installationId: installation.installationId,
            },
            fetch: githubHttp,
          });
        },
      });
    },
  );
  function createReader() {
    return createPreparedAppContextReader({
      readHandoff: createPreparedHandoffReader({
        read: input.handoffs.read,
        isActiveMember: input.isActiveMember,
      }),
      github,
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
    github,
    githubHttp,
    vercelHttp,
    credentialRead,
    rotateCredentials: () => {
      credentialRevision += 1;
    },
    setVercelStatus: (status: number) => {
      vercelStatus = status;
    },
  };
}
