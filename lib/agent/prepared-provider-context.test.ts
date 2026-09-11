import { describe, expect, it, vi } from "vitest";

import type { BuilderHandoffIntent } from "../handoff/contracts";
import {
  createPreparedAppContextReader,
  readPreparedVercelAccess,
  withPreparedGitHubSelection,
} from "./prepared-provider-context";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "user-1",
  workspaceId: "workspace-1",
};
const intent = {
  appId: "stock",
  appName: "Stock",
  brief: "Manage stock exceptions",
  connections: ["github", "vercel"],
  modelId: "openai/gpt-5.6-terra",
  providers: { githubInstallationId: "10", vercelInstallationId: "icfg_1" },
  provisioning: {
    appId: "stock",
    github: { code: "not_selected", retryable: false, status: "skipped" },
    requestDigest: "a".repeat(64),
    requestId: "f1184eeb-0c49-4db2-8f20-15ddfae12236",
    status: "settled",
    updatedAt: "2026-09-01T12:00:00.000Z",
    vercel: {
      dashboardUrl: "https://vercel.com/acme/apps-stock",
      framework: "nextjs",
      installationId: "icfg_1",
      name: "apps-stock",
      projectId: "prj_1",
      rootDirectory: "apps/stock",
      scope: { id: "team_1", slug: "acme", type: "team" },
      status: "succeeded",
    },
    version: 1,
  },
  repository: {
    private: true,
    requestedName: "stock",
    resolvedFullName: "acme/stock",
  },
} satisfies BuilderHandoffIntent & {
  providers: { githubInstallationId: string; vercelInstallationId: string };
};
const credential = {
  binding: {
    active: true,
    displayName: "Acme",
    installationId: "icfg_1",
    plan: "pro",
    scopeId: "team_1",
    scopeType: "team" as const,
    slug: "acme",
    updatedAt: new Date(),
  },
  token: "credential-sentinel-never-output",
};

describe("prepared provider continuity", () => {
  it("preserves a deleted project for review instead of asking for authorization", async () => {
    const result = await readPreparedVercelAccess({
      authority,
      fetch: async () => new Response(null, { status: 404 }),
      intent,
      readCredential: async () => credential,
    });
    expect(result).toEqual({
      action: "review-selection",
      status: "resource-unavailable",
    });
    expect(intent.provisioning.vercel.projectId).toBe("prj_1");
  });
  it("retries rate-limited 403s and rejects a project readback for another account", async () => {
    for (const response of [
      new Response(null, { headers: { "retry-after": "30" }, status: 403 }),
      Response.json({ accountId: "team_other", id: "prj_1", name: "stock" }),
    ]) {
      expect(
        await readPreparedVercelAccess({
          authority,
          intent,
          readCredential: async () => credential,
          fetch: async () => response,
        })
      ).toEqual({
        status: "provider-unavailable",
        action: "retry",
        retryable: true,
      });
    }
    expect(
      await readPreparedVercelAccess({
        authority,
        fetch: async () =>
          Response.json({ id: "prj_1", name: "stock", accountId: "team_1" }),
        intent,
        readCredential: async () => credential,
      })
    ).toMatchObject({ project: { id: "prj_1" }, status: "ready" });
  });
  it("returns a reconnect link to the same handoff and fresh ready access after reconnection", async () => {
    const handoffId = "ed5bc83d-a08f-42be-9635-4677fa7bdb32";
    const sessionAuth = {
      initiator: {
        attributes: { "autograph:source-handoff-id": handoffId },
        issuer: authority.issuer,
      },
    };
    let connected = false;
    const read = createPreparedAppContextReader({
      github: async () => ({
        status: "provider-unavailable",
        repository: { owner: "acme", name: "stock", fullName: "acme/stock" },
      }),
      readHandoff: async () => intent,
      vercel: async () =>
        readPreparedVercelAccess({
          intent,
          authority,
          readCredential: async () => credential,
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
          reconnectUrl: `https://builder.example/vercel/installations?returnTo=%2Fhandoff%2F${handoffId}`,
          status: "authorization-required",
        },
      },
    });
    connected = true;
    const second = await read(sessionAuth);
    expect(second).toMatchObject({
      access: { vercel: { status: "ready" } },
      resources: first.status === "prepared" ? first.resources : {},
    });
    expect(
      second.status === "prepared" && second.access.vercel
    ).not.toHaveProperty("reconnectUrl");
  });
  it("uses the saved installation only for the matching repository, respecting explicit choices", () => {
    expect(
      withPreparedGitHubSelection({ repository: "ACME/Stock" }, intent)
    ).toEqual({ repository: "ACME/Stock", selectedInstallationId: "10" });
    expect(
      withPreparedGitHubSelection({ repository: "other/stock" }, intent)
    ).toEqual({ repository: "other/stock" });
    expect(
      withPreparedGitHubSelection(
        { repository: "acme/stock", selectedInstallationId: "20" },
        intent
      )
    ).toEqual({ repository: "acme/stock", selectedInstallationId: "20" });
    expect(withPreparedGitHubSelection({ repository: "acme/stock" })).toEqual({
      repository: "acme/stock",
    });
  });

  it("reads the selected installation under the full tenant and returns only observed project metadata", async () => {
    const readCredential = vi.fn(async () => credential);
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        env: [credential.token],
        id: "prj_1",
        name: "renamed-stock",
        token: credential.token,
      })
    );
    const result = await readPreparedVercelAccess({
      authority,
      fetch: request,
      intent,
      readCredential,
    });
    expect(readCredential).toHaveBeenCalledWith({
      authority,
      installationId: "icfg_1",
    });
    expect(request.mock.calls[0]?.[0].toString()).toBe(
      "https://api.vercel.com/v9/projects/prj_1?teamId=team_1"
    );
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      cache: "no-store",
      headers: { Authorization: `Bearer ${credential.token}` },
      method: "GET",
      redirect: "error",
    });
    expect(result).toEqual({
      project: { id: "prj_1", name: "renamed-stock" },
      scope: {
        id: "team_1",
        installationId: "icfg_1",
        slug: "acme",
        type: "team",
      },
      status: "ready",
    });
    expect(JSON.stringify(result)).not.toContain(credential.token);
  });

  it.each([401, 403])(
    "requests reconnection on provider denial %s without exposing its body",
    async (status) => {
      const result = await readPreparedVercelAccess({
        authority,
        fetch: async () => new Response(credential.token, { status }),
        intent,
        readCredential: async () => credential,
      });
      expect(result).toEqual({
        action: "reconnect",
        status: "authorization-required",
      });
    }
  );

  it.each([429, 500, 502, 503])(
    "retries provider outage %s without reconnection",
    async (status) => {
      expect(
        await readPreparedVercelAccess({
          authority,
          fetch: async () => new Response(credential.token, { status }),
          intent,
          readCredential: async () => credential,
        })
      ).toEqual({
        action: "retry",
        retryable: true,
        status: "provider-unavailable",
      });
    }
  );

  it("does not use another tenant or a different selected scope when credentials are unavailable", async () => {
    const request = vi.fn<typeof fetch>();
    const readCredential = vi.fn(
      async (input: { authority: typeof authority }) =>
        input.authority.ownerUserId === authority.ownerUserId
          ? credential
          : undefined
    );
    expect(
      await readPreparedVercelAccess({
        authority: { ...authority, ownerUserId: "user-2" },
        fetch: request,
        intent,
        readCredential,
      })
    ).toMatchObject({ status: "authorization-required" });
    expect(
      await readPreparedVercelAccess({
        authority,
        fetch: request,
        intent,
        readCredential: async () => ({
          ...credential,
          binding: { ...credential.binding, scopeId: "team_other" },
        }),
      })
    ).toMatchObject({
      action: "review-selection",
      status: "resource-unavailable",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("treats transport, storage, malformed responses, and incorrect readbacks as retryable", async () => {
    for (const request of [
      async () => {
        throw new Error(credential.token);
      },
      async () => new Response("invalid-json"),
      async () => Response.json({ id: "another-project", name: "wrong" }),
    ]) {
      expect(
        await readPreparedVercelAccess({
          authority,
          fetch: request,
          intent,
          readCredential: async () => credential,
        })
      ).toMatchObject({ action: "retry", status: "provider-unavailable" });
    }
    expect(
      await readPreparedVercelAccess({
        authority,
        intent,
        readCredential: async () => {
          throw new Error(credential.token);
        },
      })
    ).toMatchObject({ status: "provider-unavailable" });
  });

  it("uses emulated GET scope readback when provisioning did not create a project", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ id: "team_1", secret: credential.token })
    );
    expect(
      await readPreparedVercelAccess({
        apiOrigin: "https://preview.vercel.app/api/emulate/vercel",
        authority,
        fetch: request,
        intent: { ...intent, provisioning: undefined },
        readCredential: async () => credential,
      })
    ).toMatchObject({ status: "ready" });
    expect(request.mock.calls[0]?.[0].toString()).toBe(
      "https://preview.vercel.app/api/emulate/vercel/v2/teams/team_1"
    );
  });

  it("does no provider work before the trusted handoff lookup, and reloads context on every call", async () => {
    const auth = { trusted: true };
    const github = vi.fn(async () => ({
      repository: { fullName: "acme/stock", name: "stock", owner: "acme" },
      status: "provider-unavailable" as const,
    }));
    const vercel = vi.fn(async () => ({
      scope: {
        id: "team_1",
        installationId: "icfg_1",
        slug: "acme",
        type: "team" as const,
      },
      status: "ready" as const,
    }));
    const readHandoff = vi.fn(async () => intent);
    const read = createPreparedAppContextReader({
      github,
      readHandoff,
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
      access: { github: { action: "retry" } },
      app: { brief: intent.brief },
      resources: { vercel: { projectId: "prj_1" } },
      status: "prepared",
    });
    github.mockClear();
    vercel.mockClear();
    await expect(
      createPreparedAppContextReader({
        github,
        readHandoff: async () => {
          throw new Error("Handoff unavailable");
        },
        vercel,
      })(auth)
    ).rejects.toThrow("Handoff unavailable");
    expect(github).not.toHaveBeenCalled();
    expect(vercel).not.toHaveBeenCalled();
    expect(
      await createPreparedAppContextReader({
        github,
        readHandoff: async () => undefined,
        vercel,
      })(auth)
    ).toEqual({ status: "not-prepared" });
  });
});
