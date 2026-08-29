import { createHmac, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createVercelInstallationAuthorization,
  decryptVercelToken,
  encryptVercelToken,
  verifyVercelWebhook,
} from "./vercel-installation";

describe("Vercel integration security", () => {
  it("encrypts tokens with version-independent AES-256-GCM material and bound associated data", () => {
    const key = randomBytes(32);
    const encrypted = encryptVercelToken({
      token: "vercel-token-sentinel",
      key,
      associatedData: "workspace/install-1",
    });
    expect(encrypted.encryptedToken).not.toContain("vercel-token-sentinel");
    expect(
      decryptVercelToken({
        ...encrypted,
        key,
        associatedData: "workspace/install-1",
      }),
    ).toBe("vercel-token-sentinel");
    expect(() =>
      decryptVercelToken({ ...encrypted, key, associatedData: "other-tenant" }),
    ).toThrow();
  });

  it("verifies the exact raw Vercel webhook body", () => {
    const body = JSON.stringify({ type: "integration-configuration.removed" });
    const secret = "client-secret";
    const signature = createHmac("sha1", secret).update(body).digest("hex");
    expect(verifyVercelWebhook({ body, signature, secret })).toBe(true);
    expect(verifyVercelWebhook({ body: `${body} `, signature, secret })).toBe(
      false,
    );
  });

  it("binds one tenant-scoped team after a single-use state and bounded server exchange", async () => {
    const authority = {
      issuer: "https://builder.example/api/auth",
      audience: "https://builder.example/mcp",
      workspaceId: "workspace_one",
      ownerUserId: "user_one",
    };
    let consumed = false;
    const binds: unknown[] = [];
    const authorization = createVercelInstallationAuthorization({
      config: {
        issuer: authority.issuer,
        resource: authority.audience,
        slug: "autograph-app-builder",
        clientId: "client-id",
        clientSecret: "client-secret",
        tokenKey: randomBytes(32),
        tokenKeyVersion: "v1",
      },
      states: {
        async create() {},
        async consume() {
          if (consumed) return undefined;
          consumed = true;
          return { returnTo: "/" };
        },
      },
      installations: {
        async list() {
          return [];
        },
        async bind(input) {
          binds.push(input);
          return { ...input.binding, active: true, updatedAt: input.now };
        },
        async deactivate() {
          return 0;
        },
      },
      membership: {
        async isActiveMember() {
          return true;
        },
      },
      nonce: () => "n".repeat(43),
      now: () => 1_800_000_000_000,
      fetch: (async (url) => {
        if (String(url).endsWith("/v2/oauth/access_token"))
          return Response.json({ access_token: "provider-token-sentinel" });
        return Response.json({
          id: "team_1",
          name: "Autograph",
          slug: "autograph",
          billing: { plan: "pro" },
        });
      }) as typeof fetch,
    });
    const redirect = await authorization.begin(authority);
    const state = new URL(redirect).searchParams.get("state");
    const callback = new URL(
      "https://builder.example/vercel/installations/callback",
    );
    callback.searchParams.set("code", "one-time-code");
    callback.searchParams.set("state", state!);
    callback.searchParams.set("configurationId", "icfg_1");
    callback.searchParams.set("teamId", "team_1");
    const result = await authorization.complete(callback.toString(), authority);
    expect(result.binding).toMatchObject({
      installationId: "icfg_1",
      slug: "autograph",
    });
    expect(binds).toHaveLength(1);
    expect(JSON.stringify(binds)).toContain("provider-token-sentinel");
    await expect(
      authorization.complete(callback.toString(), authority),
    ).rejects.toThrow("state-invalid");
  });
});
