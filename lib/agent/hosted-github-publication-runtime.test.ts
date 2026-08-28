import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type {
  GitHubPublicationAdapter,
  GitHubPublicationReceiptStore,
} from "../repository/github-publication";
import type { HostedGitHubInstallationStore } from "../repository/postgres-github-installation-store";
import type { GitHubPublicationProposalStore } from "../repository/postgres-github-publication-store";
import {
  createHostedGitHubPublicationRuntimeResolver,
  type HostedGitHubPublicationProviderFactory,
} from "./hosted-github-publication-runtime";

const authority = {
  issuer: "https://builder.example.test/api/auth",
  audience: "https://builder.example.test/mcp",
  workspaceId: "workspace_one",
  ownerUserId: "user_one",
};

const forwarded = {
  attributes: {
    "eve:forwarded-by": "owner:autographing:project:app-builder",
    "mcp:audience": authority.audience,
    "mcp:scopes": ["autograph:session", "autograph:start"],
    "mcp:workspace-id": authority.workspaceId,
  },
  authenticator: "mcp-oauth-jwks",
  issuer: authority.issuer,
  principalId: authority.ownerUserId,
  principalType: "user",
  subject: authority.ownerUserId,
} as const;

function sessionAuth() {
  return {
    current: structuredClone(forwarded),
    initiator: structuredClone(forwarded),
  };
}

const installation = {
  installationId: "123",
  accountId: "456",
  accountLogin: "withAutograph",
  accountType: "Organization" as const,
  active: true,
  updatedAt: new Date("2026-08-28T00:00:00.000Z"),
};

const proposals: GitHubPublicationProposalStore = {
  async read() {
    return undefined;
  },
  async save() {},
};

const receipts: GitHubPublicationReceiptStore = {
  async read() {
    return undefined;
  },
  async compareAndSet() {
    return true;
  },
};

const adapter = {} as GitHubPublicationAdapter;

function dependencies(input?: {
  activeMember?: boolean;
  boundInstallation?: typeof installation | null;
}) {
  const membership = vi.fn(() => ({
    isMember: vi.fn(async () => input?.activeMember ?? true),
  }));
  const installationStore: HostedGitHubInstallationStore = {
    read: vi.fn(async () =>
      input !== undefined && "boundInstallation" in input
        ? (input.boundInstallation ?? undefined)
        : installation,
    ),
    bind: vi.fn(),
  };
  const installations = vi.fn(() => installationStore);
  const publicationStores = vi.fn(() => ({ proposals, receipts }));
  return {
    dependencies: { membership, installations, publicationStores },
    installationStore,
    membership,
    installations,
    publicationStores,
  };
}

describe("hosted tenant GitHub publication runtime resolver", () => {
  it("stays disabled without configuration and touches no authority or pool", async () => {
    const resolver = createHostedGitHubPublicationRuntimeResolver({
      enabled: false,
    });

    await expect(
      resolver.resolve(null).then((runtime) => runtime.status()),
    ).resolves.toMatchObject({
      enabled: false,
      adapterConfigured: false,
      durableStoreConfigured: false,
      liveGitHubCallsAvailable: false,
    });
  });

  it("composes a fresh tenant runtime while caching only the database pool", async () => {
    const database = {} as never;
    const openDatabase = vi.fn(async () => database);
    const providerFactory = vi.fn<HostedGitHubPublicationProviderFactory>(
      async () => adapter,
    );
    const injected = dependencies();
    const resolver = createHostedGitHubPublicationRuntimeResolver({
      enabled: true,
      openDatabase,
      providerFactory,
      dependencies: injected.dependencies,
    });

    const first = await resolver.resolve(sessionAuth());
    const second = await resolver.resolve(sessionAuth());

    await expect(first.status()).resolves.toMatchObject({ enabled: true });
    await expect(second.status()).resolves.toMatchObject({ enabled: true });
    expect(first).not.toBe(second);
    expect(openDatabase).toHaveBeenCalledTimes(1);
    expect(injected.membership).toHaveBeenCalledTimes(2);
    expect(injected.installations).toHaveBeenCalledTimes(2);
    expect(injected.publicationStores).toHaveBeenCalledTimes(2);
    expect(providerFactory).toHaveBeenCalledTimes(2);
    expect(providerFactory).toHaveBeenNthCalledWith(1, {
      authority,
      installation,
    });
    expect(injected.publicationStores).toHaveBeenNthCalledWith(
      1,
      database,
      authority,
    );
  });

  it("accepts the live forwarded-by shape and independently validates both scope sets", async () => {
    const providerFactory = vi.fn(async () => adapter);
    const injected = dependencies();
    const auth = {
      ...sessionAuth(),
      initiator: {
        ...forwarded,
        attributes: {
          ...forwarded.attributes,
          "mcp:scopes": ["autograph:session"],
        },
      },
    };
    const resolver = createHostedGitHubPublicationRuntimeResolver({
      enabled: true,
      openDatabase: async () => ({}) as never,
      providerFactory,
      dependencies: injected.dependencies,
    });

    await expect(
      resolver.resolve(auth).then((runtime) => runtime.status()),
    ).resolves.toMatchObject({ enabled: true });
    expect(providerFactory).toHaveBeenCalledWith({ authority, installation });
  });

  it.each([
    ["missing", null],
    [
      "local",
      {
        current: {
          ...forwarded,
          authenticator: "local-dev",
          principalId: "local-dev",
          principalType: "local-dev",
          subject: undefined,
        },
        initiator: forwarded,
      },
    ],
    [
      "service",
      {
        current: { ...forwarded, principalType: "service" },
        initiator: { ...forwarded, principalType: "service" },
      },
    ],
    [
      "ambient-extra-field",
      {
        current: { ...forwarded, credential: "forbidden" },
        initiator: { ...forwarded, credential: "forbidden" },
      },
    ],
    [
      "invalid-forwarder",
      {
        current: {
          ...forwarded,
          attributes: {
            ...forwarded.attributes,
            "eve:forwarded-by": "invalid forwarder",
          },
        },
        initiator: {
          ...forwarded,
          attributes: {
            ...forwarded.attributes,
            "eve:forwarded-by": "invalid forwarder",
          },
        },
      },
    ],
  ])("rejects %s authority before opening the pool", async (_name, auth) => {
    const openDatabase = vi.fn(async () => ({}) as never);
    const providerFactory = vi.fn(async () => adapter);
    const resolver = createHostedGitHubPublicationRuntimeResolver({
      enabled: true,
      openDatabase,
      providerFactory,
    });

    await expect(resolver.resolve(auth)).rejects.toThrow(
      "exact forwarded user authority",
    );
    expect(openDatabase).not.toHaveBeenCalled();
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it.each([
    [
      "workspace",
      {
        ...forwarded,
        attributes: {
          ...forwarded.attributes,
          "mcp:workspace-id": "workspace_other",
        },
      },
    ],
    [
      "audience",
      {
        ...forwarded,
        attributes: {
          ...forwarded.attributes,
          "mcp:audience": "https://other.example.test/mcp",
        },
      },
    ],
    [
      "owner",
      {
        ...forwarded,
        principalId: "user_other",
        subject: "user_other",
      },
    ],
  ])(
    "rejects current and initiator %s drift before opening the pool",
    async (_name, current) => {
      const openDatabase = vi.fn(async () => ({}) as never);
      const providerFactory = vi.fn(async () => adapter);
      const auth = {
        ...sessionAuth(),
        current,
      };
      const resolver = createHostedGitHubPublicationRuntimeResolver({
        enabled: true,
        openDatabase,
        providerFactory,
      });

      await expect(resolver.resolve(auth)).rejects.toThrow(
        "matching current and initiating authority",
      );
      expect(openDatabase).not.toHaveBeenCalled();
      expect(providerFactory).not.toHaveBeenCalled();
    },
  );

  it("requires live membership before reading an installation", async () => {
    const providerFactory = vi.fn(async () => adapter);
    const injected = dependencies({ activeMember: false });
    const resolver = createHostedGitHubPublicationRuntimeResolver({
      enabled: true,
      openDatabase: async () => ({}) as never,
      providerFactory,
      dependencies: injected.dependencies,
    });

    await expect(resolver.resolve(sessionAuth())).rejects.toThrow(
      "membership is not active",
    );
    expect(injected.installationStore.read).not.toHaveBeenCalled();
    expect(injected.publicationStores).not.toHaveBeenCalled();
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it("requires an active tenant installation before store or provider composition", async () => {
    const providerFactory = vi.fn(async () => adapter);
    const injected = dependencies({
      boundInstallation: { ...installation, active: false },
    });
    const resolver = createHostedGitHubPublicationRuntimeResolver({
      enabled: true,
      openDatabase: async () => ({}) as never,
      providerFactory,
      dependencies: injected.dependencies,
    });

    await expect(resolver.resolve(sessionAuth())).rejects.toThrow(
      "installation is inactive or unavailable",
    );
    expect(injected.installationStore.read).toHaveBeenCalledWith(authority);
    expect(injected.publicationStores).not.toHaveBeenCalled();
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it("normalizes a missing tenant installation to the unavailable boundary", async () => {
    const providerFactory = vi.fn(async () => adapter);
    const injected = dependencies({ boundInstallation: null });
    const resolver = createHostedGitHubPublicationRuntimeResolver({
      enabled: true,
      openDatabase: async () => ({}) as never,
      providerFactory,
      dependencies: injected.dependencies,
    });

    await expect(resolver.resolve(sessionAuth())).rejects.toThrow(
      "installation is inactive or unavailable",
    );
    expect(injected.publicationStores).not.toHaveBeenCalled();
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it("contains no ambient installation-id authority", async () => {
    const source = await readFile(
      "lib/agent/hosted-github-publication-runtime.ts",
      "utf8",
    );
    expect(source).not.toContain("GITHUB_APP_INSTALLATION_ID");
    expect(source).not.toContain("process.env");
  });
});
