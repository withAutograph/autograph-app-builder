import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { z } from "zod";

import {
  hostedTenantAuthoritySchema,
  type HostedAdminPlanRequest,
} from "../db/hosted-admin";
import type { ProviderConnectionReturn } from "./provider-connection-return";
import type { ProviderEmulation } from "./local-provider-emulation";

type Authority = HostedAdminPlanRequest["authority"];

const configSchema = z
  .object({
    issuer: z.string().url(),
    resource: z.string().url(),
    slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u),
    clientId: z.string().min(1).max(512),
    clientSecret: z.string().min(1).max(512),
    tokenKey: z.instanceof(Buffer).refine((value) => value.length === 32),
    tokenKeyVersion: z.string().regex(/^[A-Za-z0-9._-]{1,32}$/u),
  })
  .strict();

export type VercelIntegrationConfig = z.infer<typeof configSchema>;

export function readVercelIntegrationEnvironment(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): VercelIntegrationConfig {
  const tokenKey = Buffer.from(
    environment.VERCEL_INTEGRATION_TOKEN_KEY ?? "",
    "base64",
  );
  return configSchema.parse({
    issuer: environment.BETTER_AUTH_URL,
    resource: environment.MCP_RESOURCE_URL,
    slug: environment.VERCEL_INTEGRATION_SLUG,
    clientId: environment.VERCEL_INTEGRATION_CLIENT_ID,
    clientSecret: environment.VERCEL_INTEGRATION_CLIENT_SECRET,
    tokenKey,
    tokenKeyVersion: environment.VERCEL_INTEGRATION_TOKEN_KEY_VERSION,
  });
}

export type VercelAuthorizationStateStore = {
  create(input: {
    stateDigest: string;
    authority: Authority;
    authorityDigest: string;
    createdAt: Date;
    expiresAt: Date;
    returnState: ProviderConnectionReturn;
  }): Promise<void>;
  consume(input: {
    stateDigest: string;
    authority: Authority;
    authorityDigest: string;
    now: Date;
  }): Promise<ProviderConnectionReturn | undefined>;
};

export type VercelInstallationBinding = {
  installationId: string;
  scopeId: string;
  scopeType: "team" | "user";
  displayName: string;
  slug: string;
  plan: string;
  active: boolean;
  updatedAt: Date;
};

export type VercelInstallationStore = {
  list(authority: Authority): Promise<VercelInstallationBinding[]>;
  bind(input: {
    authority: Authority;
    binding: Omit<VercelInstallationBinding, "active" | "updatedAt">;
    token: string;
    now: Date;
  }): Promise<VercelInstallationBinding>;
  deactivate(installationId: string, now: Date): Promise<number>;
};

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function authorityDigest(authority: Authority) {
  return digest(JSON.stringify(hostedTenantAuthoritySchema.parse(authority)));
}

export function encryptVercelToken(input: {
  token: string;
  key: Buffer;
  associatedData: string;
}) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", input.key, iv);
  cipher.setAAD(Buffer.from(input.associatedData));
  const encrypted = Buffer.concat([
    cipher.update(input.token, "utf8"),
    cipher.final(),
  ]);
  return {
    encryptedToken: encrypted.toString("base64"),
    tokenIv: iv.toString("base64"),
    tokenTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptVercelToken(input: {
  encryptedToken: string;
  tokenIv: string;
  tokenTag: string;
  key: Buffer;
  associatedData: string;
}) {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    input.key,
    Buffer.from(input.tokenIv, "base64"),
  );
  decipher.setAAD(Buffer.from(input.associatedData));
  decipher.setAuthTag(Buffer.from(input.tokenTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(input.encryptedToken, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

const tokenResponseSchema = z
  .object({ access_token: z.string().min(1).max(8_192) })
  .passthrough();
const teamSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    slug: z.string().min(1),
    billing: z
      .object({ plan: z.string().min(1) })
      .passthrough()
      .optional(),
  })
  .passthrough();
const userSchema = z
  .object({
    user: z
      .object({
        id: z.string().min(1),
        name: z.string().min(1).optional(),
        username: z.string().min(1),
      })
      .passthrough(),
  })
  .passthrough();

export function createVercelInstallationAuthorization(input: {
  config: VercelIntegrationConfig;
  states: VercelAuthorizationStateStore;
  installations: VercelInstallationStore;
  membership: { isActiveMember(authority: Authority): Promise<boolean> };
  fetch?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
  emulation?: ProviderEmulation;
}) {
  const config = configSchema.parse(input.config);
  const request = input.fetch ?? fetch;
  const now = input.now ?? Date.now;
  const nonce = input.nonce ?? (() => randomBytes(32).toString("base64url"));

  return {
    async begin(
      authorityInput: Authority,
      returnState: ProviderConnectionReturn = { returnTo: "/" },
    ) {
      const authority = hostedTenantAuthoritySchema.parse(authorityInput);
      if (!(await input.membership.isActiveMember(authority)))
        throw new Error("membership-inactive");
      const state = nonce();
      const issuedAt = now();
      await input.states.create({
        stateDigest: digest(state),
        authority,
        authorityDigest: authorityDigest(authority),
        createdAt: new Date(issuedAt),
        expiresAt: new Date(issuedAt + 10 * 60_000),
        returnState,
      });
      const url = input.emulation
        ? new URL("/local-connections/vercel", config.issuer)
        : new URL(`/integrations/${config.slug}/new`, "https://vercel.com");
      url.searchParams.set("state", state);
      return url.toString();
    },

    async complete(callbackUrl: string, authorityInput: Authority) {
      const authority = hostedTenantAuthoritySchema.parse(authorityInput);
      const url = new URL(callbackUrl);
      const code = z
        .string()
        .min(1)
        .max(2_048)
        .parse(url.searchParams.get("code"));
      const state = z
        .string()
        .min(32)
        .max(512)
        .parse(url.searchParams.get("state"));
      const installationId = z
        .string()
        .min(1)
        .max(256)
        .parse(url.searchParams.get("configurationId"));
      const teamId = url.searchParams.get("teamId") || undefined;
      if (!(await input.membership.isActiveMember(authority)))
        throw new Error("membership-inactive");
      const returnState = await input.states.consume({
        stateDigest: digest(state),
        authority,
        authorityDigest: authorityDigest(authority),
        now: new Date(now()),
      });
      if (!returnState) throw new Error("state-invalid");

      const token = await (async () => {
        const tokenResponse = await request(
          input.emulation
            ? `${input.emulation.vercelOrigin}/login/oauth/token`
            : "https://api.vercel.com/v2/oauth/access_token",
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              client_id: config.clientId,
              client_secret: config.clientSecret,
              code,
              redirect_uri: new URL(
                input.emulation
                  ? "/local-connections/vercel/oauth-callback"
                  : "/vercel/installations/callback",
                config.issuer,
              ).toString(),
            }),
            signal: AbortSignal.timeout(8_000),
          },
        );
        if (!tokenResponse.ok) throw new Error("token-exchange-failed");
        return tokenResponseSchema.parse(await tokenResponse.json())
          .access_token;
      })();
      const headers = {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      };
      let binding: Omit<VercelInstallationBinding, "active" | "updatedAt">;
      if (teamId) {
        const response = await request(
          `${input.emulation?.vercelOrigin ?? "https://api.vercel.com"}/v2/teams/${encodeURIComponent(teamId)}`,
          {
            headers,
            signal: AbortSignal.timeout(8_000),
          },
        );
        if (!response.ok) throw new Error("scope-read-failed");
        const payload: unknown = await response.json();
        const team = teamSchema.parse(
          input.emulation &&
            typeof payload === "object" &&
            payload !== null &&
            "team" in payload
            ? payload.team
            : payload,
        );
        binding = {
          installationId,
          scopeId: team.id,
          scopeType: "team",
          displayName: team.name,
          slug: team.slug,
          plan: team.billing?.plan ?? "unknown",
        };
      } else {
        const response = await request(
          `${input.emulation?.vercelOrigin ?? "https://api.vercel.com"}/v2/user`,
          {
            headers,
            signal: AbortSignal.timeout(8_000),
          },
        );
        if (!response.ok) throw new Error("scope-read-failed");
        const { user } = userSchema.parse(await response.json());
        binding = {
          installationId,
          scopeId: user.id,
          scopeType: "user",
          displayName: user.name ?? user.username,
          slug: user.username,
          plan: "hobby",
        };
      }
      if (!(await input.membership.isActiveMember(authority)))
        throw new Error("membership-inactive");
      const persistedBinding = await input.installations.bind({
        authority,
        binding,
        token,
        now: new Date(now()),
      });
      return { binding: persistedBinding, returnState };
    },
  };
}

export function verifyVercelWebhook(input: {
  body: string;
  signature: string | null;
  secret: string;
}) {
  if (!input.signature || !/^[a-f0-9]{40}$/iu.test(input.signature))
    return false;
  const expected = createHmac("sha1", input.secret).update(input.body).digest();
  const provided = Buffer.from(input.signature, "hex");
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}
