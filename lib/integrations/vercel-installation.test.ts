import { createHmac, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createVercelInstallationAuthorization,
  decryptVercelToken,
  decryptVersionedVercelToken,
  encryptVercelToken,
  readVercelIntegrationEnvironment,
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
      }),
    ).toBe("vercel-token-sentinel");
    expect(() =>
      decryptVercelToken({ ...encrypted, associatedData: "other-tenant", key }),
    ).toThrow();
  });

  it("decrypts only exact retained key versions while new writes keep using the active key", () => {
    const oldKey = randomBytes(32);
    const activeKey = randomBytes(32);
    const associatedData = "workspace/install-rotation";
    const legacy = {
      ...encryptVercelToken({ associatedData, key: oldKey, token: "legacy-token" }),
      keyVersion: "previous_v1",
    };
    const config = {
      clientId: "client-id",
      clientSecret: "client-secret",
      issuer: "https://builder.example/api/auth",
      previousTokenKeys: [{ key: oldKey, version: "previous_v1" }],
      resource: "https://builder.example/mcp",
      slug: "autograph-app-builder",
      tokenKey: activeKey,
      tokenKeyVersion: "current_v2",
    };
    expect(decryptVersionedVercelToken({ ...legacy, associatedData, config })).toBe("legacy-token");

    const current = encryptVercelToken({
      associatedData,
      key: config.tokenKey,
      token: "new-token",
    });
    expect(
      decryptVersionedVercelToken({
        ...current,
        associatedData,
        config,
        keyVersion: config.tokenKeyVersion,
      }),
    ).toBe("new-token");
    expect(() =>
      decryptVersionedVercelToken({ ...legacy, associatedData: "other-workspace", config }),
    ).toThrow();
    expect(() =>
      decryptVersionedVercelToken({ ...legacy, associatedData, config, keyVersion: "removed_v0" }),
    ).toThrow("Vercel token decryption key is unavailable.");
  });

  it("validates optional previous key configuration without exposing key material", () => {
    const base = {
      BETTER_AUTH_URL: "https://builder.example/api/auth",
      MCP_RESOURCE_URL: "https://builder.example/mcp",
      VERCEL_INTEGRATION_CLIENT_ID: "client-id",
      VERCEL_INTEGRATION_CLIENT_SECRET: "client-secret",
      VERCEL_INTEGRATION_SLUG: "autograph-app-builder",
      VERCEL_INTEGRATION_TOKEN_KEY: Buffer.alloc(32, 1).toString("base64"),
      VERCEL_INTEGRATION_TOKEN_KEY_VERSION: "current_v2",
    };
    expect(readVercelIntegrationEnvironment(base).previousTokenKeys).toBeUndefined();
    expect(
      readVercelIntegrationEnvironment({
        ...base,
        VERCEL_INTEGRATION_TOKEN_PREVIOUS_KEYS: JSON.stringify([
          { key: Buffer.alloc(32, 2).toString("base64"), version: "previous_v1" },
        ]),
      }).previousTokenKeys?.map(({ version }) => version),
    ).toEqual(["previous_v1"]);

    const duplicate = JSON.stringify([
      { key: Buffer.alloc(32, 2).toString("base64"), version: "previous_v1" },
      { key: Buffer.alloc(32, 3).toString("base64"), version: "previous_v1" },
    ]);
    expect(() =>
      readVercelIntegrationEnvironment({
        ...base,
        VERCEL_INTEGRATION_TOKEN_PREVIOUS_KEYS: duplicate,
      }),
    ).toThrow(/unique/u);
    expect(() =>
      readVercelIntegrationEnvironment({
        ...base,
        VERCEL_INTEGRATION_TOKEN_PREVIOUS_KEYS: "not-json-secret",
      }),
    ).toThrow("Invalid Vercel token key rotation configuration.");
    expect(() =>
      readVercelIntegrationEnvironment({
        ...base,
        VERCEL_INTEGRATION_TOKEN_PREVIOUS_KEYS: JSON.stringify([
          { key: "malformed-key-material", version: "previous_v1" },
        ]),
      }),
    ).toThrow("Invalid Vercel token key rotation configuration.");
    expect(() =>
      readVercelIntegrationEnvironment({
        ...base,
        VERCEL_INTEGRATION_TOKEN_PREVIOUS_KEYS: JSON.stringify([
          { key: Buffer.alloc(32, 2).toString("base64"), version: "current_v2" },
        ]),
      }),
    ).toThrow(/active token key version/u);
  });

  it("verifies the exact raw Vercel webhook body", () => {
    const body = JSON.stringify({ type: "integration-configuration.removed" });
    const secret = "client-secret";
    const signature = createHmac("sha1", secret).update(body).digest("hex");
    expect(verifyVercelWebhook({ body, secret, signature })).toBe(true);
    expect(verifyVercelWebhook({ body: `${body} `, secret, signature })).toBe(false);
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
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        fetch: (async (url) => {
          if (String(url).endsWith("/v2/oauth/access_token")) {
            return Response.json({ access_token: "provider-token-sentinel" });
          }
          return Response.json({
            billing: { plan: "pro" },
            id: "team_1",
            name: "Autograph",
            slug: "autograph",
          });
        }) as typeof fetch,
        installations: {
          // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
          async bind(input) {
            binds.push(input);
            return { ...input.binding, active: true, updatedAt: input.now };
          },
          // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
          async deactivate() {
            return 0;
          },
          // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
          async list() {
            return [];
          },
        },
        membership: {
          // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
          async isActiveMember() {
            return true;
          },
        },
        nonce: () => "n".repeat(43),
        now: () => 1_800_000_000_000,
        states: {
          // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
          async consume() {
            if (consumed) {
              return;
            }
            consumed = true;
            return recoveredReturnState;
          },
          async create() {},
          // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
          async recover() {
            return recoveredReturnState;
          },
        },
      });
      const redirect = await authorization.begin(authority);
      const state = new URL(redirect).searchParams.get("state");
      expect(state).not.toBeNull();
      if (state === null) {
        throw new Error("Expected authorization redirect state");
      }
      const callback = new URL("https://builder.example/vercel/installations/callback");
      callback.searchParams.set("code", "one-time-code");
      callback.searchParams.set("state", state);
      callback.searchParams.set("configurationId", "icfg_1");
      callback.searchParams.set("teamId", "team_1");
      const result = await authorization.complete(callback.toString(), authority);
      expect(result.binding).toMatchObject({
        installationId: "icfg_1",
        slug: "autograph",
      });
      expect(result.returnState).toEqual(recoveredReturnState);
      expect(binds).toHaveLength(1);
      expect(JSON.stringify(binds)).toContain("provider-token-sentinel");
      await expect(authorization.complete(callback.toString(), authority)).rejects.toMatchObject({
        message: "state-invalid",
        returnState: recoveredReturnState,
      });
    },
  );
});
