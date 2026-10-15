import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { encryptVercelToken } from "../integrations/vercel-installation";
import {
  createRealmContinuationServiceAuth,
  mintRealmContinuationAuthority,
  readRealmContinuationServiceIdentity,
  readVerifiedRealmContinuationAuthority,
  realmContinuationAuthorityAttribute,
  RealmContinuationAuthorityError,
} from "./realm-continuation-authority";
import type { RealmContinuationAuthority } from "./realm-continuation-authority";
import { exactForwardedSessionAuthority, sourceHandoffIdForSessionAuth } from "./session-authority";

const environment = {
  EVE_HOSTED_ADAPTER: "1",
  EVE_HOSTED_VERCEL_ENVIRONMENT: "preview",
  EVE_HOSTED_VERCEL_PROJECT_NAME: "autograph-app-builder",
  EVE_HOSTED_VERCEL_TEAM_SLUG: "withautograph",
  VERCEL_ENV: "preview",
};
const service = readRealmContinuationServiceIdentity(environment);
const config = { tokenKey: Buffer.alloc(32, 7), tokenKeyVersion: "v1" };
const options = { config, service };
const authorityOptions = {
  realmContinuation: { adapterSessionId: "adapter-session", verification: options },
};
const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "user_1",
  workspaceId: "workspace_1",
};
const initiator: RealmContinuationAuthority["initiator"] = {
  attributes: {
    "autograph:source-handoff-id": "123e4567-e89b-42d3-a456-426614174001",
    "eve:forwarded-by": service.forwardedBy,
    "mcp:audience": authority.audience,
    "mcp:scopes": ["autograph:get", "autograph:send"],
    "mcp:workspace-id": authority.workspaceId,
  },
  authenticator: "mcp-oauth-jwks",
  issuer: authority.issuer,
  principalId: authority.ownerUserId,
  principalType: "user",
  subject: authority.ownerUserId,
};
const observed = {
  adapterSessionId: "adapter-session",
  appId: "sample-app",
  approvedPlanDigest: "a".repeat(64),
  authority,
  initiator,
  nonceSha256: "b".repeat(64),
  operationRef: "123e4567-e89b-42d3-a456-426614174002",
  ownerSessionId: "public-session",
};
const consumed: RealmContinuationAuthority["reason"] = {
  kind: "consumed-proof",
  proofRef: "_protected-operator/artifacts/realm-identity-proof/sample-app/proof",
  proofSha256: "c".repeat(64),
};
const expired: RealmContinuationAuthority["reason"] = {
  kind: "expired-technical-wait",
  expiresAt: "2026-10-01T00:00:00.000Z",
};
const authFor = (reason: RealmContinuationAuthority["reason"] = consumed) =>
  createRealmContinuationServiceAuth({
    ...options,
    claim: mintRealmContinuationAuthority({ ...options, observed: { ...observed, reason } }),
    initiator,
  });

describe("sealed Realm continuation authority", () => {
  it.each([consumed, expired])(
    "accepts an independently observed $kind delegation without changing the current service or pinned initiator",
    (reason) => {
      const auth = authFor(reason);
      expect(auth.current).toMatchObject({
        principalType: "service",
        issuer: service.issuer,
        principalId: service.principalId,
      });
      expect(auth.initiator).toEqual(initiator);
      const claim = readVerifiedRealmContinuationAuthority(auth, options);
      expect(claim).toMatchObject({ ...observed, reason, service });
      const forwarded = exactForwardedSessionAuthority(auth, authorityOptions);
      expect(forwarded).toEqual({
        authority,
        principal: { ...authority, scopes: initiator.attributes["mcp:scopes"] },
      });
      expect(sourceHandoffIdForSessionAuth(auth, authorityOptions)).toBe(
        initiator.attributes["autograph:source-handoff-id"],
      );
      expect(JSON.stringify(auth)).not.toContain(consumed.proofRef);
      expect(JSON.stringify(forwarded)).not.toContain(realmContinuationAuthorityAttribute);
      expect(JSON.stringify(forwarded)).not.toContain("proof");
      expect(JSON.stringify(claim?.reason)).not.toContain("connected");
    },
  );

  it("verifies using the configured environment without injected authority and rejects a foreign configured service", () => {
    try {
      for (const [key, value] of Object.entries(environment)) {
        vi.stubEnv(key, value);
      }
      vi.stubEnv("VERCEL_INTEGRATION_TOKEN_KEY", config.tokenKey.toString("base64"));
      vi.stubEnv("VERCEL_INTEGRATION_TOKEN_KEY_VERSION", config.tokenKeyVersion);
      vi.stubEnv("VERCEL_INTEGRATION_TOKEN_PREVIOUS_KEYS", "");
      const auth = authFor();
      expect(() => exactForwardedSessionAuthority(auth)).toThrow();
      expect(() => sourceHandoffIdForSessionAuth(auth)).toThrow();
      const optIn = { realmContinuation: { adapterSessionId: "adapter-session" } };
      expect(exactForwardedSessionAuthority(auth, optIn).authority).toEqual(authority);
      expect(sourceHandoffIdForSessionAuth(auth, optIn)).toBe(
        initiator.attributes["autograph:source-handoff-id"],
      );
      vi.stubEnv("EVE_HOSTED_VERCEL_PROJECT_NAME", "foreign-project");
      expect(() => exactForwardedSessionAuthority(auth, optIn)).toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("requires explicit native-bound opt-in and keeps generic hosted side-effect parsers closed", () => {
    const auth = authFor();
    expect(() => exactForwardedSessionAuthority(auth)).toThrow();
    expect(() => sourceHandoffIdForSessionAuth(auth)).toThrow();
    const wrongAdapter = {
      realmContinuation: { adapterSessionId: "foreign-native", verification: options },
    };
    expect(() => exactForwardedSessionAuthority(auth, wrongAdapter)).toThrow();
    expect(() => sourceHandoffIdForSessionAuth(auth, wrongAdapter)).toThrow();
  });

  it("uses the configured workload identity convention and refuses missing configuration", () => {
    expect(service.issuer).toBe("https://oidc.vercel.com/withautograph");
    expect(service.principalId).toBe(`${service.issuer}:${service.subject}`);
    expect(service.forwardedBy).toBe(service.subject);
    expect(() => readRealmContinuationServiceIdentity({})).toThrow();
  });

  it("rejects missing, corrupted, wrong-key and wrong-purpose seals without leaking crypto details", () => {
    const auth = authFor();
    const wrongPurpose = JSON.stringify({
      ...encryptVercelToken({
        associatedData: "other-purpose",
        key: config.tokenKey,
        token: JSON.stringify({ ...observed, reason: consumed, service, purpose: "other-purpose" }),
      }),
      keyVersion: config.tokenKeyVersion,
    });
    for (const opaque of [undefined, "not-json", "{}", wrongPurpose]) {
      const candidate = structuredClone(auth);
      Object.assign(candidate.current.attributes, {
        [realmContinuationAuthorityAttribute]: opaque,
      });
      expect(() => readVerifiedRealmContinuationAuthority(candidate, options)).toThrow(
        RealmContinuationAuthorityError,
      );
    }
    expect(() =>
      readVerifiedRealmContinuationAuthority(auth, {
        ...options,
        config: { ...config, tokenKey: Buffer.alloc(32, 9) },
      }),
    ).toThrow(RealmContinuationAuthorityError);
    const tampered = z
      .record(z.string(), z.string())
      .parse(JSON.parse(auth.current.attributes[realmContinuationAuthorityAttribute]));
    tampered.encryptedToken = Buffer.from("plaintext-password-cookie-proof").toString("base64");
    auth.current.attributes[realmContinuationAuthorityAttribute] = JSON.stringify(tampered);
    expect(() => readVerifiedRealmContinuationAuthority(auth, options)).toThrow(
      "Realm continuation authority is invalid.",
    );
  });

  it("rejects a valid GCM seal containing another purpose or unsupported credentials/proof fields", () => {
    for (const extra of [
      { purpose: "other-purpose" },
      { credentials: { cookie: "private-cookie" } },
      { proof: "private-proof" },
    ]) {
      const auth = authFor();
      auth.current.attributes[realmContinuationAuthorityAttribute] = JSON.stringify({
        ...encryptVercelToken({
          associatedData: "autograph-realm-continuation-authority-v1",
          key: config.tokenKey,
          token: JSON.stringify({
            ...observed,
            reason: consumed,
            service,
            purpose: "autograph-realm-continuation-authority-v1",
            ...extra,
          }),
        }),
        keyVersion: config.tokenKeyVersion,
      });
      expect(() => readVerifiedRealmContinuationAuthority(auth, options)).toThrow(
        RealmContinuationAuthorityError,
      );
    }
  });

  it("rejects foreign initiator, scopes, handoff, service and forwarder", () => {
    const candidates = [
      (auth: ReturnType<typeof authFor>) => {
        auth.initiator.subject = "foreign-user";
      },
      (auth: ReturnType<typeof authFor>) => {
        auth.initiator.attributes["mcp:scopes"] = ["autograph:start"];
      },
      (auth: ReturnType<typeof authFor>) => {
        auth.initiator.attributes["autograph:source-handoff-id"] =
          "123e4567-e89b-42d3-a456-426614174099";
      },
      (auth: ReturnType<typeof authFor>) => {
        auth.current.subject = "foreign-service";
      },
      (auth: ReturnType<typeof authFor>) => {
        auth.current.principalId = "foreign-service";
      },
      (auth: ReturnType<typeof authFor>) => {
        auth.current.issuer = "https://oidc.vercel.com/foreign";
      },
      (auth: ReturnType<typeof authFor>) => {
        auth.current.attributes["eve:forwarded-by"] = "foreign-service";
      },
      (auth: ReturnType<typeof authFor>) => {
        auth.initiator.attributes["eve:forwarded-by"] = "foreign-service";
      },
    ];
    for (const mutate of candidates) {
      const auth = structuredClone(authFor());
      mutate(auth);
      expect(() => readVerifiedRealmContinuationAuthority(auth, options)).toThrow(
        RealmContinuationAuthorityError,
      );
      expect(() => exactForwardedSessionAuthority(auth, authorityOptions)).toThrow();
      expect(() => sourceHandoffIdForSessionAuth(auth, authorityOptions)).toThrow();
    }
  });

  it("uses the existing previous-key semantics after rotation", () => {
    const auth = authFor();
    expect(
      readVerifiedRealmContinuationAuthority(auth, {
        service,
        config: {
          tokenKey: Buffer.alloc(32, 9),
          tokenKeyVersion: "v2",
          previousTokenKeys: [{ key: config.tokenKey, version: "v1" }],
        },
      })?.ownerSessionId,
    ).toBe(observed.ownerSessionId);
  });
});
