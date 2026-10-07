import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import type { HostedAdminPlanRequest } from "../db/hosted-admin";
import type { ProviderConnectionReturn } from "./provider-connection-return";
import type { ProviderEmulation } from "./local-provider-emulation";
import { VercelTokenDecryptionKeyError } from "./vercel-token-decryption-key-error";

export { VercelTokenDecryptionKeyError } from "./vercel-token-decryption-key-error";

type Authority = HostedAdminPlanRequest["authority"];

const tokenKeyVersionSchema = z.string().regex(/^[A-Za-z0-9._-]{1,32}$/u);
const previousTokenKeySchema = z.strictObject({
  key: z.instanceof(Buffer).refine((value) => value.length === 32),
  version: tokenKeyVersionSchema,
});
const previousTokenKeysSchema = z.array(previousTokenKeySchema).superRefine((keys, context) => {
  const versions = new Set<string>();
  for (const [index, entry] of keys.entries()) {
    if (versions.has(entry.version)) {
      context.addIssue({
        code: "custom",
        message: "Previous token key versions must be unique.",
        path: [index, "version"],
      });
    }
    versions.add(entry.version);
  }
});

const tokenKeyringSchema = z
  .strictObject({
    previousTokenKeys: previousTokenKeysSchema.optional(),
    tokenKey: z.instanceof(Buffer).refine((value) => value.length === 32),
    tokenKeyVersion: tokenKeyVersionSchema,
  })
  .superRefine((config, context) => {
    if (config.previousTokenKeys?.some((entry) => entry.version === config.tokenKeyVersion)) {
      context.addIssue({
        code: "custom",
        message: "The active token key version cannot also be a previous key.",
        path: ["previousTokenKeys"],
      });
    }
  });

const configSchema = z
  .object({
    clientId: z.string().min(1).max(512),
    clientSecret: z.string().min(1).max(512),
    issuer: z.string().url(),
    previousTokenKeys: previousTokenKeysSchema.optional(),
    resource: z.string().url(),
    slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u),
    tokenKey: z.instanceof(Buffer).refine((value) => value.length === 32),
    tokenKeyVersion: tokenKeyVersionSchema,
  })
  .strict()
  .superRefine((config, context) => {
    if (config.previousTokenKeys?.some((entry) => entry.version === config.tokenKeyVersion)) {
      context.addIssue({
        code: "custom",
        message: "The active token key version cannot also be a previous key.",
        path: ["previousTokenKeys"],
      });
    }
  });

export type VercelIntegrationConfig = z.infer<typeof configSchema>;
/** Encryption-only key material for reading previously stored owner tokens. */
export type VercelTokenKeyringConfig = z.infer<typeof tokenKeyringSchema>;

const readTokenKeyringCandidate = (
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
) => {
  const tokenKey = Buffer.from(environment.VERCEL_INTEGRATION_TOKEN_KEY ?? "", "base64");
  let previousTokenKeys: unknown;
  const previousTokenKeysJson = environment.VERCEL_INTEGRATION_TOKEN_PREVIOUS_KEYS;
  if (previousTokenKeysJson !== undefined && previousTokenKeysJson !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(previousTokenKeysJson);
    } catch {
      throw new Error("Invalid Vercel token key rotation configuration.");
    }
    const encodedKeysSchema = z.array(
      z.strictObject({
        key: z.string().regex(/^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/u),
        version: tokenKeyVersionSchema,
      }),
    );
    const encodedKeys = encodedKeysSchema.safeParse(parsed);
    if (!encodedKeys.success) {
      throw new Error("Invalid Vercel token key rotation configuration.");
    }
    previousTokenKeys = encodedKeys.data.map(({ key, version }) => ({
      key: Buffer.from(key, "base64"),
      version,
    }));
  }
  const candidate = {
    tokenKey,
    tokenKeyVersion: environment.VERCEL_INTEGRATION_TOKEN_KEY_VERSION,
  };
  return previousTokenKeys === undefined
    ? candidate
    : { ...candidate, previousTokenKeys };
};

/** Reads only token-encryption keys; suitable for services that decrypt owner grants but do not run OAuth. */
export const readVercelTokenKeyringEnvironment = (
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): VercelTokenKeyringConfig =>
  tokenKeyringSchema.parse(readTokenKeyringCandidate(environment));

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function readVercelIntegrationEnvironment(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): VercelIntegrationConfig {
  const candidate = {
    clientId: environment.VERCEL_INTEGRATION_CLIENT_ID,
    clientSecret: environment.VERCEL_INTEGRATION_CLIENT_SECRET,
    issuer: environment.BETTER_AUTH_URL,
    resource: environment.MCP_RESOURCE_URL,
    slug: environment.VERCEL_INTEGRATION_SLUG,
    ...readTokenKeyringCandidate(environment),
  };
  return configSchema.parse(candidate);
}

export interface VercelAuthorizationStateStore {
  create: (input: {
    stateDigest: string;
    authority: Authority;
    authorityDigest: string;
    createdAt: Date;
    expiresAt: Date;
    returnState: ProviderConnectionReturn;
  }) => Promise<void>;
  consume: (input: {
    stateDigest: string;
    authority: Authority;
    authorityDigest: string;
    now: Date;
  }) => Promise<ProviderConnectionReturn | undefined>;
  recover: (input: {
    stateDigest: string;
    authority: Authority;
    authorityDigest: string;
  }) => Promise<ProviderConnectionReturn | undefined>;
}

export class VercelInstallationAuthorizationError extends Error {
  readonly reason: string;
  readonly returnState?: ProviderConnectionReturn;

  constructor(reason: string, returnState?: ProviderConnectionReturn) {
    super(reason);
    this.name = "VercelInstallationAuthorizationError";
    this.reason = reason;
    this.returnState = returnState;
  }
}

export interface VercelInstallationBinding {
  installationId: string;
  scopeId: string;
  scopeType: "team" | "user";
  displayName: string;
  slug: string;
  plan: string;
  active: boolean;
  updatedAt: Date;
}

export interface VercelInstallationStore {
  list: (authority: Authority) => Promise<VercelInstallationBinding[]>;
  bind: (input: {
    authority: Authority;
    binding: Omit<VercelInstallationBinding, "active" | "updatedAt">;
    token: string;
    now: Date;
  }) => Promise<VercelInstallationBinding>;
  deactivate: (installationId: string, now: Date) => Promise<number>;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function authorityDigest(authority: Authority) {
  return digest(JSON.stringify(hostedTenantAuthoritySchema.parse(authority)));
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function encryptVercelToken(input: { token: string; key: Buffer; associatedData: string }) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", input.key, iv);
  cipher.setAAD(Buffer.from(input.associatedData));
  const encrypted = Buffer.concat([cipher.update(input.token, "utf-8"), cipher.final()]);
  return {
    encryptedToken: encrypted.toString("base64"),
    tokenIv: iv.toString("base64"),
    tokenTag: cipher.getAuthTag().toString("base64"),
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function decryptVercelToken(input: {
  encryptedToken: string;
  tokenIv: string;
  tokenTag: string;
  key: Buffer;
  associatedData: string;
}) {
  const decipher = createDecipheriv("aes-256-gcm", input.key, Buffer.from(input.tokenIv, "base64"));
  decipher.setAAD(Buffer.from(input.associatedData));
  decipher.setAuthTag(Buffer.from(input.tokenTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(input.encryptedToken, "base64")),
    decipher.final(),
  ]).toString("utf-8");
}

/** Decrypt only with the exact versioned key; encryption continues using the active key. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting for integration callers.
export function decryptVersionedVercelToken(input: {
  encryptedToken: string;
  tokenIv: string;
  tokenTag: string;
  keyVersion: string;
  config: VercelTokenKeyringConfig | VercelIntegrationConfig;
  associatedData: string;
}) {
  const config = tokenKeyringSchema.parse({
    previousTokenKeys: input.config.previousTokenKeys,
    tokenKey: input.config.tokenKey,
    tokenKeyVersion: input.config.tokenKeyVersion,
  });
  const keyVersion = tokenKeyVersionSchema.safeParse(input.keyVersion);
  if (!keyVersion.success) {
    throw new VercelTokenDecryptionKeyError();
  }
  const key =
    keyVersion.data === config.tokenKeyVersion
      ? config.tokenKey
      : config.previousTokenKeys?.find((entry) => entry.version === keyVersion.data)?.key;
  if (key === undefined) {
    throw new VercelTokenDecryptionKeyError();
  }
  return decryptVercelToken({ ...input, key });
}

const tokenResponseSchema = z.object({ access_token: z.string().min(1).max(8192) }).passthrough();
const teamSchema = z
  .object({
    billing: z
      .object({ plan: z.string().min(1) })
      .passthrough()
      .optional(),
    id: z.string().min(1),
    name: z.string().min(1),
    slug: z.string().min(1),
  })
  .passthrough();
const teamResponseSchema = z.union([
  teamSchema,
  z.object({ team: teamSchema }).transform(({ team }) => team),
]);
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

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createVercelInstallationAuthorization(input: {
  config: VercelIntegrationConfig;
  states: VercelAuthorizationStateStore;
  installations: VercelInstallationStore;
  membership: { isActiveMember: (authority: Authority) => Promise<boolean> };
  fetch?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
  emulation?: ProviderEmulation;
}) {
  const config = configSchema.parse(input.config);
  const request = input.fetch ?? fetch;
  const now = input.now ?? Date.now;
  const nonce = input.nonce ?? (() => randomBytes(32).toString("base64url"));
  const defaultReturnState: ProviderConnectionReturn = { returnTo: "/" };

  return {
    async begin(
      authorityInput: Authority,
      returnState: ProviderConnectionReturn = defaultReturnState,
    ) {
      const authority = hostedTenantAuthoritySchema.parse(authorityInput);
      if (!(await input.membership.isActiveMember(authority))) {
        throw new Error("membership-inactive");
      }
      const state = nonce();
      const issuedAt = now();
      await input.states.create({
        authority,
        authorityDigest: authorityDigest(authority),
        createdAt: new Date(issuedAt),
        expiresAt: new Date(issuedAt + 10 * 60_000),
        returnState,
        stateDigest: digest(state),
      });
      const url = input.emulation
        ? new URL("/local-connections/vercel", config.issuer)
        : new URL(`/integrations/${config.slug}/new`, "https://vercel.com");
      url.searchParams.set("state", state);
      if (input.emulation && returnState.resumeKey) {
        url.searchParams.set("resume", returnState.resumeKey);
      }
      return url.toString();
    },

    async complete(callbackUrl: string, authorityInput: Authority) {
      const authority = hostedTenantAuthoritySchema.parse(authorityInput);
      const url = new URL(callbackUrl);
      const code = z.string().min(1).max(2048).parse(url.searchParams.get("code"));
      const state = z.string().min(32).max(512).parse(url.searchParams.get("state"));
      const installationId = z
        .string()
        .min(1)
        .max(256)
        .parse(url.searchParams.get("configurationId"));
      const teamId = url.searchParams.get("teamId") || undefined;
      if (!(await input.membership.isActiveMember(authority))) {
        throw new Error("membership-inactive");
      }
      const returnState = await input.states.consume({
        authority,
        authorityDigest: authorityDigest(authority),
        now: new Date(now()),
        stateDigest: digest(state),
      });
      if (!returnState) {
        throw new VercelInstallationAuthorizationError(
          "state-invalid",
          await input.states.recover({
            authority,
            authorityDigest: authorityDigest(authority),
            stateDigest: digest(state),
          }),
        );
      }

      const token = await (async () => {
        const tokenResponse = await request(
          input.emulation
            ? `${input.emulation.vercelOrigin}/login/oauth/token`
            : "https://api.vercel.com/v2/oauth/access_token",
          {
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
            headers: {
              Accept: "application/json",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            method: "POST",
            signal: AbortSignal.timeout(8000),
          },
        );
        if (!tokenResponse.ok) {
          const errorPayload = z
            .object({ error: z.string().max(64).optional() })
            .safeParse(await tokenResponse.json().catch(() => ({})));
          const errorCode = errorPayload.success ? errorPayload.data.error : undefined;
          throw new Error(
            `token-exchange-failed:${tokenResponse.status}:${errorCode ?? "unknown"}`,
          );
        }
        return tokenResponseSchema.parse(await tokenResponse.json()).access_token;
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
            signal: AbortSignal.timeout(8000),
          },
        );
        if (!response.ok) {
          throw new Error("scope-read-failed");
        }
        const team = teamResponseSchema.parse(await response.json());
        binding = {
          displayName: team.name,
          installationId,
          plan: team.billing?.plan ?? "unknown",
          scopeId: team.id,
          scopeType: "team",
          slug: team.slug,
        };
      } else {
        const response = await request(
          `${input.emulation?.vercelOrigin ?? "https://api.vercel.com"}/v2/user`,
          {
            headers,
            signal: AbortSignal.timeout(8000),
          },
        );
        if (!response.ok) {
          throw new Error("scope-read-failed");
        }
        const { user } = userSchema.parse(await response.json());
        binding = {
          displayName: user.name ?? user.username,
          installationId,
          plan: "hobby",
          scopeId: user.id,
          scopeType: "user",
          slug: user.username,
        };
      }
      if (!(await input.membership.isActiveMember(authority))) {
        throw new Error("membership-inactive");
      }
      const persistedBinding = await input.installations.bind({
        authority,
        binding,
        now: new Date(now()),
        token,
      });
      return { binding: persistedBinding, returnState };
    },
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function verifyVercelWebhook(input: {
  body: string;
  signature: string | null;
  secret: string;
}) {
  if (!input.signature || !/^[a-f0-9]{40}$/iu.test(input.signature)) {
    return false;
  }
  const expected = createHmac("sha1", input.secret).update(input.body).digest();
  const provided = Buffer.from(input.signature, "hex");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
