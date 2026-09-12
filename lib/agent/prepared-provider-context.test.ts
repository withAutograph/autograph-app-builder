import { describe, expect, it, vi } from "vitest";
import type { BuilderHandoffIntent } from "../handoff/contracts";
import {
  createPreparedAppContextReader,
  readPreparedVercelAccess,
  withPreparedGitHubSelection,
} from "./prepared-provider-context";

const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  ownerUserId: "user-1",
  workspaceId: "workspace-1",
};
const intent = {
  appName: "Stock",
  appId: "stock",
  brief: "Manage stock exceptions",
  modelId: "openai/gpt-5.6-terra",
  repository: {
    requestedName: "stock",
    private: true,
    resolvedFullName: "acme/stock",
  },
  connections: ["github", "vercel"],
  providers: { githubInstallationId: "10", vercelInstallationId: "icfg_1" },
  provisioning: {
    version: 1,
    requestId: "f1184eeb-0c49-4db2-8f20-15ddfae12236",
    requestDigest: "a".repeat(64),
    appId: "stock",
    status: "settled",
    updatedAt: "2026-09-01T12:00:00.000Z",
    github: { status: "skipped", code: "not_selected", retryable: false },
    vercel: {
      status: "succeeded",
      installationId: "icfg_1",
      projectId: "prj_1",
      name: "apps-stock",
      dashboardUrl: "https://vercel.com/acme/apps-stock",
      scope: { id: "team_1", type: "team", slug: "acme" },
      framework: "nextjs",
      rootDirectory: "apps/stock",
    },
  },
} satisfies BuilderHandoffIntent & {
  providers: { githubInstallationId: string; vercelInstallationId: string };
};
const credential = {
  binding: {
    installationId: "icfg_1",
    scopeId: "team_1",
    scopeType: "team" as const,
    slug: "acme",
    displayName: "Acme",
    plan: "pro",
    active: true,
    updatedAt: new Date(),
  },
  token: "credential-sentinel-never-output",
};

describe("prepared provider continuity", () => {
  it("preserves a deleted project for review instead of asking for authorization", async () => {
    const result = await readPreparedVercelAccess({
      authority,
      intent,
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
      readCredential: async () => credential,
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
      fetch: async () => new Response(null, { status: 404 }),
    });
    expect(result).toEqual({
      status: "resource-unavailable",
      action: "review-selection",
    });
    expect(intent.provisioning.vercel.projectId).toBe("prj_1");
  });
  it("retries rate-limited 403s and rejects a project readback for another account", async () => {
    await Promise.all(
      [
        new Response(null, { status: 403, headers: { "retry-after": "30" } }),
        Response.json({ id: "prj_1", name: "stock", accountId: "team_other" }),
      ].map(async (response) => {
        expect(
          await readPreparedVercelAccess({
            authority,
            intent,
            // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
            readCredential: async () => credential,
            // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
            fetch: async () => response,
          }),
        ).toEqual({
          status: "provider-unavailable",
          action: "retry",
          retryable: true,
        });
      }),
    );
    expect(
      await readPreparedVercelAccess({
        authority,
        intent,
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
        readCredential: async () => credential,
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
        fetch: async () => Response.json({ id: "prj_1", name: "stock", accountId: "team_1" }),
      }),
    ).toMatchObject({ status: "ready", project: { id: "prj_1" } });
  });
  it("returns a reconnect link to the same handoff and fresh ready access after reconnection", async () => {
    const handoffId = "ed5bc83d-a08f-42be-9635-4677fa7bdb32";
    const sessionAuth = {
      initiator: {
        issuer: authority.issuer,
        attributes: { "autograph:source-handoff-id": handoffId },
      },
    };
    let connected = false;
    const read = createPreparedAppContextReader({
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
      readHandoff: async () => intent,
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
      github: async () => ({
        status: "provider-unavailable",
        repository: { owner: "acme", name: "stock", fullName: "acme/stock" },
      }),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
      vercel: async () =>
        readPreparedVercelAccess({
          intent,
          authority,
          // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
          readCredential: async () => credential,
          // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
          fetch: async () =>
            connected
              ? Response.json({ id: "prj_1", name: "apps-stock" })
              : new Response(null, { status: 401 }),
        }),
    });
    const first = await read(sessionAuth);
    expect(first).toMatchObject({
      access: {
        vercel: {
          status: "authorization-required",
          reconnectUrl: `https://builder.example/vercel/installations?returnTo=%2Fhandoff%2F${handoffId}`,
        },
      },
    });
    connected = true;
    const second = await read(sessionAuth);
    expect(second).toMatchObject({
      access: { vercel: { status: "ready" } },
      resources: first.status === "prepared" ? first.resources : {},
    });
    expect(second.status === "prepared" && second.access.vercel).not.toHaveProperty("reconnectUrl");
  });
  it("uses the saved installation only for the matching repository, respecting explicit choices", () => {
    expect(withPreparedGitHubSelection({ repository: "ACME/Stock" }, intent)).toEqual({
      repository: "ACME/Stock",
      selectedInstallationId: "10",
    });
    expect(withPreparedGitHubSelection({ repository: "other/stock" }, intent)).toEqual({
      repository: "other/stock",
    });
    expect(
      withPreparedGitHubSelection(
        { repository: "acme/stock", selectedInstallationId: "20" },
        intent,
      ),
    ).toEqual({ repository: "acme/stock", selectedInstallationId: "20" });
    expect(withPreparedGitHubSelection({ repository: "acme/stock" }, undefined)).toEqual({
      repository: "acme/stock",
    });
  });

  it("reads the selected installation under the full tenant and returns only observed project metadata", async () => {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
    const readCredential = vi.fn(async () => credential);
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        id: "prj_1",
        name: "renamed-stock",
        env: [credential.token],
        token: credential.token,
      }),
    );
    const result = await readPreparedVercelAccess({
      authority,
      intent,
      readCredential,
      fetch: request,
    });
    expect(readCredential).toHaveBeenCalledWith({
      authority,
      installationId: "icfg_1",
    });
    expect(request.mock.calls[0]?.[0].toString()).toBe(
      "https://api.vercel.com/v9/projects/prj_1?teamId=team_1",
    );
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      redirect: "error",
      cache: "no-store",
      headers: { Authorization: `Bearer ${credential.token}` },
    });
    expect(result).toEqual({
      status: "ready",
      scope: {
        installationId: "icfg_1",
        id: "team_1",
        type: "team",
        slug: "acme",
      },
      project: { id: "prj_1", name: "renamed-stock" },
    });
    expect(JSON.stringify(result)).not.toContain(credential.token);
  });

  it.each([401, 403])(
    "requests reconnection on provider denial %s without exposing its body",
    async (status) => {
      const result = await readPreparedVercelAccess({
        authority,
        intent,
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
        readCredential: async () => credential,
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
        fetch: async () => new Response(credential.token, { status }),
      });
      expect(result).toEqual({
        status: "authorization-required",
        action: "reconnect",
      });
    },
  );

  it.each([429, 500, 502, 503])(
    "retries provider outage %s without reconnection",
    async (status) => {
      expect(
        // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
        await readPreparedVercelAccess({
          authority,
          intent,
          // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
          readCredential: async () => credential,
          // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
          fetch: async () => new Response(credential.token, { status }),
        }),
      ).toEqual({
        status: "provider-unavailable",
        action: "retry",
        retryable: true,
      });
    },
  );

  it("does not use another tenant or a different selected scope when credentials are unavailable", async () => {
    const request = vi.fn<typeof fetch>();
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
    const readCredential = vi.fn(async (input: { authority: typeof authority }) =>
      input.authority.ownerUserId === authority.ownerUserId ? credential : undefined,
    );
    expect(
      await readPreparedVercelAccess({
        authority: { ...authority, ownerUserId: "user-2" },
        intent,
        readCredential,
        fetch: request,
      }),
    ).toMatchObject({ status: "authorization-required" });
    expect(
      await readPreparedVercelAccess({
        authority,
        intent,
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
        readCredential: async () => ({
          ...credential,
          binding: { ...credential.binding, scopeId: "team_other" },
        }),
        fetch: request,
      }),
    ).toMatchObject({
      status: "resource-unavailable",
      action: "review-selection",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("treats transport, storage, malformed responses, and incorrect readbacks as retryable", async () => {
    await Promise.all(
      [
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
        async () => {
          throw new Error(credential.token);
        },
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
        async () => new Response("invalid-json"),
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
        async () => Response.json({ id: "another-project", name: "wrong" }),
      ].map(async (request) => {
        expect(
          await readPreparedVercelAccess({
            authority,
            intent,
            // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
            readCredential: async () => credential,
            fetch: request,
          }),
        ).toMatchObject({ status: "provider-unavailable", action: "retry" });
      }),
    );
    expect(
      await readPreparedVercelAccess({
        authority,
        intent,
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
        readCredential: async () => {
          throw new Error(credential.token);
        },
      }),
    ).toMatchObject({ status: "provider-unavailable" });
  });

  it("uses emulated GET scope readback when provisioning did not create a project", async () => {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ id: "team_1", secret: credential.token }),
    );
    expect(
      await readPreparedVercelAccess({
        authority,
        intent: { ...intent, provisioning: undefined },
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
        readCredential: async () => credential,
        fetch: request,
        apiOrigin: "https://preview.vercel.app/api/emulate/vercel",
      }),
    ).toMatchObject({ status: "ready" });
    expect(request.mock.calls[0]?.[0].toString()).toBe(
      "https://preview.vercel.app/api/emulate/vercel/v2/teams/team_1",
    );
  });

  it("does no provider work before the trusted handoff lookup, and reloads context on every call", async () => {
    const auth = { trusted: true };
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
    const github = vi.fn(async () => ({
      status: "provider-unavailable" as const,
      repository: { owner: "acme", name: "stock", fullName: "acme/stock" },
    }));
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
    const vercel = vi.fn(async () => ({
      status: "ready" as const,
      scope: {
        installationId: "icfg_1",
        id: "team_1",
        type: "team" as const,
        slug: "acme",
      },
    }));
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
    const readHandoff = vi.fn(async () => intent);
    const read = createPreparedAppContextReader({
      readHandoff,
      github,
      vercel,
    });
    const result = await read(auth);
    await read(auth);
    expect(readHandoff).toHaveBeenCalledTimes(2);
    expect(readHandoff).toHaveBeenCalledWith(auth);
    expect(github).toHaveBeenCalledWith(auth, {
      repository: "acme/stock",
      selectedInstallationId: "10",
    });
    expect(result).toMatchObject({
      status: "prepared",
      app: { brief: intent.brief },
      resources: { vercel: { projectId: "prj_1" } },
      access: { github: { action: "retry" } },
    });
    github.mockClear();
    vercel.mockClear();
    await expect(
      createPreparedAppContextReader({
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
        readHandoff: async () => {
          throw new Error("Handoff unavailable");
        },
        github,
        vercel,
      })(auth),
    ).rejects.toThrow("Handoff unavailable");
    expect(github).not.toHaveBeenCalled();
    expect(vercel).not.toHaveBeenCalled();
    expect(
      await createPreparedAppContextReader({
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test contract
        readHandoff: async () => undefined,
        github,
        vercel,
      })(auth),
    ).toEqual({ status: "not-prepared" });
  });
});
