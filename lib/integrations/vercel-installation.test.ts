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
      associatedData: "workspace/install-1",
      key,
      token: "vercel-token-sentinel",
    });
    expect(encrypted.encryptedToken).not.toContain("vercel-token-sentinel");
    expect(
      decryptVercelToken({
        ...encrypted,
        associatedData: "workspace/install-1",
        key,
      })
    ).toBe("vercel-token-sentinel");
    expect(() =>
      decryptVercelToken({ ...encrypted, associatedData: "other-tenant", key })
    ).toThrow();
  });

  it("verifies the exact raw Vercel webhook body", () => {
    const body = JSON.stringify({ type: "integration-configuration.removed" });
    const secret = "client-secret";
    const signature = createHmac("sha1", secret).update(body).digest("hex");
    expect(verifyVercelWebhook({ body, secret, signature })).toBe(true);
    expect(verifyVercelWebhook({ body: `${body} `, secret, signature })).toBe(
      false
    );
  });

  it.each(["/", "/handoff/ed5bc83d-a08f-42be-9635-4677fa7bdb32"] as const)(
    "binds a tenant-scoped team and preserves %s through callback and replay recovery",
    async (returnTo) => {
      const authority = {
        audience: "https://builder.example/mcp",
        issuer: "https://builder.example/api/auth",
        ownerUserId: "user_one",
        workspaceId: "workspace_one",
      };
      let consumed = false;
      const recoveredReturnState = {
        resumeKey: "1c7ed773-0aa9-4e32-9e65-6eb36e7b5cc0",
        returnTo,
      };
      const binds: unknown[] = [];
      const authorization = createVercelInstallationAuthorization({
        config: {
          clientId: "client-id",
          clientSecret: "client-secret",
          issuer: authority.issuer,
          resource: authority.audience,
          slug: "autograph-app-builder",
          tokenKey: randomBytes(32),
          tokenKeyVersion: "v1",
        },
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
        installations: {
          async bind(input) {
            binds.push(input);
            return { ...input.binding, active: true, updatedAt: input.now };
          },
          async deactivate() {
            return 0;
          },
          async list() {
            return [];
          },
        },
        membership: {
          async isActiveMember() {
            return true;
          },
        },
        nonce: () => "n".repeat(43),
        now: () => 1_800_000_000_000,
        states: {
          async consume() {
            if (consumed) return undefined;
            consumed = true;
            return recoveredReturnState;
          },
          async create() {},
          async recover() {
            return recoveredReturnState;
          },
        },
      });
      const redirect = await authorization.begin(authority);
      const state = new URL(redirect).searchParams.get("state");
      const callback = new URL(
        "https://builder.example/vercel/installations/callback"
      );
      callback.searchParams.set("code", "one-time-code");
      callback.searchParams.set("state", state!);
      callback.searchParams.set("configurationId", "icfg_1");
      callback.searchParams.set("teamId", "team_1");
      const result = await authorization.complete(
        callback.toString(),
        authority
      );
      expect(result.binding).toMatchObject({
        installationId: "icfg_1",
        slug: "autograph",
      });
      expect(result.returnState).toEqual(recoveredReturnState);
      expect(binds).toHaveLength(1);
      expect(JSON.stringify(binds)).toContain("provider-token-sentinel");
      await expect(
        authorization.complete(callback.toString(), authority)
      ).rejects.toMatchObject({
        message: "state-invalid",
        returnState: recoveredReturnState,
      });
    }
  );
});
