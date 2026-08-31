import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import type { ProviderConnectionReturn } from "../integrations/provider-connection-return";
import type { LocalProviderEmulation } from "../integrations/local-provider-emulation";
import type { HostedGitHubInstallationStore } from "../repository/postgres-github-installation-store";
import type { GitHubUserCredentialStore } from "../provisioning/github-user-credential";
import {
  createGitHubOAuthApp,
  createGitHubTokenOctokit,
} from "../github/octokit";

const GITHUB_ORIGIN = "https://github.com";
const STATE_LIFETIME_MS = 10 * 60 * 1_000;
const FAILURE_MESSAGE = "GitHub App installation authorization failed.";

export type GitHubInstallationAuthorizationFailureStage =
  | "callback-state-validation"
  | "membership-state-consumption"
  | "token-exchange-transport"
  | "token-exchange-non-2xx"
  | "token-exchange-oauth-error"
  | "token-response-schema"
  | "oauth-callback-error"
  | "github-user-verification"
  | "installation-identity-validation"
  | "durable-tenant-binding";

export type GitHubOAuthErrorCategory =
  | "incorrect_client_credentials"
  | "redirect_uri_mismatch"
  | "bad_verification_code"
  | "unverified_user_email";

export type GitHubOAuthCallbackError =
  "access_denied" | "temporarily_unavailable" | "server_error";

type GitHubCallbackDiagnostic = {
  queryKeys: string[];
  keyCounts: Record<string, number>;
  unknownKeyCount: number;
  unknownKeyDigests?: string[];
  codePresent: boolean;
  codeLength?: number;
  statePresent: boolean;
  stateLength?: number;
  error?: GitHubOAuthCallbackError;
};

type GitHubStateValidationDiagnostic = {
  substage:
    | "authority-parse"
    | "callback-parse"
    | "state-format"
    | "state-signature"
    | "state-schema"
    | "state-authority-digest"
    | "state-time";
  stateDigest?: string;
  callbackParseReason?:
    "duplicate-key" | "state-format" | "callback-shape" | "code-format";
};

class GitHubCallbackParseError extends Error {
  constructor(
    readonly reason: NonNullable<
      GitHubStateValidationDiagnostic["callbackParseReason"]
    >,
  ) {
    super("invalid-callback");
  }
}

class GitHubStateValidationError extends Error {
  constructor(readonly diagnostic: GitHubStateValidationDiagnostic) {
    super("invalid-state");
  }
}

export class GitHubInstallationAuthorizationError extends Error {
  constructor(
    readonly stage: GitHubInstallationAuthorizationFailureStage,
    readonly category?: GitHubOAuthErrorCategory | GitHubOAuthCallbackError,
    readonly returnState?: ProviderConnectionReturn,
    readonly callback?: GitHubCallbackDiagnostic,
    readonly stateValidation?: GitHubStateValidationDiagnostic,
  ) {
    super(FAILURE_MESSAGE);
  }
}

export function githubInstallationAuthorizationDiagnostic(error: unknown) {
  if (!(error instanceof GitHubInstallationAuthorizationError))
    return undefined;
  return {
    stage: error.stage,
    ...(error.category === undefined ? {} : { category: error.category }),
    ...(error.callback === undefined ? {} : { callback: error.callback }),
    ...(error.stateValidation === undefined
      ? {}
      : { stateValidation: error.stateValidation }),
  };
}

type HostedTenantAuthority = z.infer<typeof hostedTenantAuthoritySchema>;

const decimalSchema = z.string().regex(/^[1-9][0-9]*$/u);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const githubLoginSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u);

const configSchema = z
  .object({
    appId: decimalSchema,
    appSlug: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u),
    clientId: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9_-]+$/u),
    clientSecret: z
      .string()
      .min(20)
      .max(512)
      .refine((value) => !/[\0\r\n]/u.test(value)),
    stateSecret: z
      .string()
      .min(32)
      .max(512)
      .refine((value) => !/[\0\r\n]/u.test(value)),
    issuer: z.string().url().startsWith("https://"),
    resource: z.string().url().startsWith("https://"),
  })
  .strict()
  .superRefine((value, context) => {
    const issuer = new URL(value.issuer);
    const resource = new URL(value.resource);
    if (
      issuer.pathname !== "/api/auth" ||
      issuer.search ||
      issuer.hash ||
      issuer.username ||
      issuer.password
    ) {
      context.addIssue({
        code: "custom",
        path: ["issuer"],
        message: "GitHub installation issuer must be exact /api/auth.",
      });
    }
    if (
      resource.pathname !== "/mcp" ||
      resource.search ||
      resource.hash ||
      resource.username ||
      resource.password ||
      resource.origin !== issuer.origin
    ) {
      context.addIssue({
        code: "custom",
        path: ["resource"],
        message: "GitHub installation resource must be same-origin /mcp.",
      });
    }
  });

export type GitHubAppInstallationConfig = z.infer<typeof configSchema>;

export function readGitHubAppInstallationEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): GitHubAppInstallationConfig {
  if (
    environment.GITHUB_TOKEN !== undefined ||
    environment.GITHUB_API_URL !== undefined
  ) {
    throw new Error("GitHub App installation configuration is invalid.");
  }
  const parsed = configSchema.safeParse({
    appId: environment.GITHUB_APP_ID,
    appSlug: environment.GITHUB_APP_SLUG,
    clientId: environment.GITHUB_APP_CLIENT_ID,
    clientSecret: environment.GITHUB_APP_CLIENT_SECRET,
    stateSecret: environment.GITHUB_APP_INSTALL_STATE_SECRET,
    issuer: environment.BETTER_AUTH_URL,
    resource: environment.MCP_RESOURCE_URL,
  });
  if (!parsed.success)
    throw new Error("GitHub App installation configuration is invalid.");
  return parsed.data;
}

export interface GitHubInstallationAuthorizationStateStore {
  create(input: {
    stateDigest: string;
    authority: HostedTenantAuthority;
    authorityDigest: string;
    createdAt: Date;
    expiresAt: Date;
    returnState: ProviderConnectionReturn;
  }): Promise<void>;
  consume(input: {
    stateDigest: string;
    authority: HostedTenantAuthority;
    authorityDigest: string;
    now: Date;
  }): Promise<boolean>;
}

export interface GitHubInstallationMembershipAuthority {
  isActiveMember(authority: HostedTenantAuthority): Promise<boolean>;
}

type Fetch = typeof fetch;

function githubOAuthErrorCategory(value: unknown) {
  return value === "incorrect_client_credentials" ||
    value === "redirect_uri_mismatch" ||
    value === "bad_verification_code" ||
    value === "unverified_user_email"
    ? value
    : undefined;
}

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const canonicalAuthority = (authority: HostedTenantAuthority) =>
  JSON.stringify({
    issuer: authority.issuer,
    audience: authority.audience,
    workspaceId: authority.workspaceId,
    ownerUserId: authority.ownerUserId,
  });

const authorityDigest = (authority: HostedTenantAuthority) =>
  sha256(canonicalAuthority(authority));

function property(value: unknown, key: string): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !(key in value)
  )
    throw new Error("invalid-response");
  return (value as Record<string, unknown>)[key];
}

function decimalProperty(value: unknown, key: string): string {
  const candidate = property(value, key);
  if (
    typeof candidate === "number" &&
    Number.isSafeInteger(candidate) &&
    candidate > 0
  ) {
    return String(candidate);
  }
  if (
    typeof candidate === "string" &&
    decimalSchema.safeParse(candidate).success
  )
    return candidate;
  throw new Error("invalid-response");
}

function stringProperty(value: unknown, key: string): string {
  const candidate = property(value, key);
  if (typeof candidate !== "string") throw new Error("invalid-response");
  return candidate;
}

function nullableStringProperty(value: unknown, key: string): string | null {
  const candidate = property(value, key);
  if (candidate !== null && typeof candidate !== "string")
    throw new Error("invalid-response");
  return candidate;
}

function signedState(input: {
  authority: HostedTenantAuthority;
  stateSecret: string;
  now: number;
  nonce: string;
  phase: "install" | "authorize";
  installationId?: string;
  setupAction?: "install" | "update";
  returnState: ProviderConnectionReturn;
}) {
  const binding = authorityDigest(input.authority);
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      nonce: input.nonce,
      authorityDigest: binding,
      phase: input.phase,
      ...(input.installationId === undefined
        ? {}
        : { installationId: input.installationId }),
      ...(input.setupAction === undefined
        ? {}
        : { setupAction: input.setupAction }),
      returnTo: input.returnState.returnTo,
      ...(input.returnState.resumeKey === undefined
        ? {}
        : { resumeKey: input.returnState.resumeKey }),
      issuedAt: Math.floor(input.now / 1_000),
      expiresAt: Math.floor((input.now + STATE_LIFETIME_MS) / 1_000),
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", input.stateSecret)
    .update("github-installation-state\n")
    .update(payload)
    .digest("base64url");
  return {
    state: `${payload}.${signature}`,
    stateDigest: sha256(`${payload}.${signature}`),
    authorityDigest: binding,
    expiresAt: new Date(input.now + STATE_LIFETIME_MS),
  };
}

const statePayloadSchema = z
  .object({
    version: z.literal(1),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/u),
    authorityDigest: digestSchema,
    phase: z.enum(["install", "authorize"]),
    installationId: decimalSchema.optional(),
    setupAction: z.enum(["install", "update"]).optional(),
    returnTo: z.literal("/"),
    resumeKey: z.string().uuid().optional(),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
  })
  .strict();

function verifyState(input: {
  state: string;
  authority: HostedTenantAuthority;
  stateSecret: string;
  now: number;
}) {
  const diagnostic = { stateDigest: sha256(input.state) };
  if (input.state.length > 2_048)
    throw new GitHubStateValidationError({
      substage: "state-format",
      ...diagnostic,
    });
  const segments = input.state.split(".");
  if (segments.length !== 2)
    throw new GitHubStateValidationError({
      substage: "state-format",
      ...diagnostic,
    });
  const [payload, providedSignature] = segments as [string, string];
  const expectedSignature = createHmac("sha256", input.stateSecret)
    .update("github-installation-state\n")
    .update(payload)
    .digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(providedSignature, "base64url");
  } catch {
    throw new GitHubStateValidationError({
      substage: "state-format",
      ...diagnostic,
    });
  }
  if (
    provided.byteLength !== expectedSignature.byteLength ||
    !timingSafeEqual(provided, expectedSignature)
  ) {
    throw new GitHubStateValidationError({
      substage: "state-signature",
      ...diagnostic,
    });
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new GitHubStateValidationError({
      substage: "state-schema",
      ...diagnostic,
    });
  }
  let parsed: z.infer<typeof statePayloadSchema>;
  try {
    parsed = statePayloadSchema.parse(decoded);
  } catch {
    throw new GitHubStateValidationError({
      substage: "state-schema",
      ...diagnostic,
    });
  }
  const nowSeconds = Math.floor(input.now / 1_000);
  if (parsed.authorityDigest !== authorityDigest(input.authority))
    throw new GitHubStateValidationError({
      substage: "state-authority-digest",
      ...diagnostic,
    });
  if (
    parsed.expiresAt <= nowSeconds ||
    parsed.issuedAt > nowSeconds + 30 ||
    parsed.expiresAt - parsed.issuedAt !== STATE_LIFETIME_MS / 1_000
  )
    throw new GitHubStateValidationError({
      substage: "state-time",
      ...diagnostic,
    });
  return {
    stateDigest: sha256(input.state),
    authorityDigest: parsed.authorityDigest,
    nonce: parsed.nonce,
    phase: parsed.phase,
    installationId: parsed.installationId,
    setupAction: parsed.setupAction,
    returnState: {
      returnTo: parsed.returnTo,
      ...(parsed.resumeKey === undefined
        ? {}
        : { resumeKey: parsed.resumeKey }),
    },
  };
}

function callbackInput(url: string) {
  const query = new URL(url).searchParams;
  const singular = [
    "code",
    "error",
    "installation_id",
    "setup_action",
    "state",
  ];
  if (singular.some((key) => query.getAll(key).length > 1))
    throw new GitHubCallbackParseError("duplicate-key");
  const stateResult = z
    .string()
    .min(1)
    .max(2_048)
    .safeParse(query.get("state"));
  if (!stateResult.success) throw new GitHubCallbackParseError("state-format");
  const state = stateResult.data;
  const code = query.get("code");
  const oauthError = query.get("error");
  if (oauthError !== null) {
    if (
      oauthError.length === 0 ||
      code !== null ||
      query.has("installation_id") ||
      query.has("setup_action")
    )
      throw new GitHubCallbackParseError("callback-shape");
    return {
      kind: "oauth-error" as const,
      error: [
        "access_denied",
        "temporarily_unavailable",
        "server_error",
      ].includes(oauthError)
        ? (oauthError as GitHubOAuthCallbackError)
        : undefined,
      state,
    };
  }
  if (code !== null) {
    if (
      query.getAll("code").length !== 1 ||
      query.getAll("state").length !== 1 ||
      query.has("installation_id") !== query.has("setup_action") ||
      (query.has("installation_id") &&
        (query.getAll("installation_id").length !== 1 ||
          query.getAll("setup_action").length !== 1))
    ) {
      throw new GitHubCallbackParseError("callback-shape");
    }
    if (code.length === 0) throw new GitHubCallbackParseError("code-format");
    return {
      kind: "authorize" as const,
      code,
      ...(query.has("installation_id")
        ? {
            installationId: decimalSchema.parse(query.get("installation_id")),
            setupAction: z
              .enum(["install", "update"])
              .parse(query.get("setup_action")),
          }
        : {}),
      state,
    };
  }
  if (
    query.getAll("state").length !== 1 ||
    query.getAll("installation_id").length !== 1 ||
    query.getAll("setup_action").length !== 1
  ) {
    throw new GitHubCallbackParseError("callback-shape");
  }
  return {
    kind: "install" as const,
    installationId: decimalSchema.parse(query.get("installation_id")),
    setupAction: z.enum(["install", "update"]).parse(query.get("setup_action")),
    state,
  };
}

function githubCallbackDiagnostic(url: string): GitHubCallbackDiagnostic {
  const query = new URL(url).searchParams;
  const known = new Set([
    "code",
    "error",
    "error_description",
    "error_uri",
    "installation_id",
    "setup_action",
    "state",
  ]);
  const state = query.get("state");
  const code = query.get("code");
  const error = query.get("error");
  const unknownKeys = [
    ...new Set([...query.keys()].filter((key) => !known.has(key))),
  ];
  return {
    queryKeys: [
      ...new Set([...query.keys()].filter((key) => known.has(key))),
    ].sort(),
    keyCounts: Object.fromEntries(
      [...known].map((key) => [key, query.getAll(key).length]),
    ),
    unknownKeyCount: unknownKeys.length,
    ...(unknownKeys.length === 0
      ? {}
      : {
          unknownKeyDigests: unknownKeys.slice(0, 3).map(sha256),
        }),
    codePresent: code !== null,
    ...(code === null ? {} : { codeLength: code.length }),
    statePresent: state !== null,
    ...(state === null ? {} : { stateLength: state.length }),
    ...(["access_denied", "temporarily_unavailable", "server_error"].includes(
      error ?? "",
    )
      ? { error: error as GitHubOAuthCallbackError }
      : {}),
  };
}

function oauthErrorCategoryFromException(error: unknown) {
  try {
    return githubOAuthErrorCategory(
      property(property(property(error, "response"), "data"), "error"),
    );
  } catch {
    return undefined;
  }
}

function normalizedUserTokens(authentication: unknown, now: number) {
  try {
    const accessToken = stringProperty(authentication, "token");
    if (
      accessToken.length < 20 ||
      accessToken.length > 512 ||
      /[\0\r\n]/u.test(accessToken)
    )
      throw new Error("invalid-token");
    const expiresAt =
      typeof propertyOrUndefined(authentication, "expiresAt") === "string"
        ? String(propertyOrUndefined(authentication, "expiresAt"))
        : undefined;
    const refreshToken =
      typeof propertyOrUndefined(authentication, "refreshToken") === "string"
        ? String(propertyOrUndefined(authentication, "refreshToken"))
        : undefined;
    const refreshTokenExpiresAt =
      typeof propertyOrUndefined(authentication, "refreshTokenExpiresAt") ===
      "string"
        ? String(propertyOrUndefined(authentication, "refreshTokenExpiresAt"))
        : undefined;
    const expiring =
      expiresAt !== undefined ||
      refreshToken !== undefined ||
      refreshTokenExpiresAt !== undefined;
    if (
      expiring &&
      (expiresAt === undefined ||
        refreshToken === undefined ||
        refreshTokenExpiresAt === undefined ||
        refreshToken.length < 20 ||
        refreshToken.length > 512 ||
        /[\0\r\n]/u.test(refreshToken) ||
        !Number.isFinite(Date.parse(expiresAt)) ||
        !Number.isFinite(Date.parse(refreshTokenExpiresAt)) ||
        Date.parse(expiresAt) <= now ||
        Date.parse(refreshTokenExpiresAt) <= now)
    )
      throw new Error("invalid-token");
    return {
      accessToken,
      ...(expiring
        ? {
            accessTokenExpiresAt: expiresAt!,
            refreshToken: refreshToken!,
            refreshTokenExpiresAt: refreshTokenExpiresAt!,
          }
        : {}),
    };
  } catch {
    throw new GitHubInstallationAuthorizationError("token-response-schema");
  }
}

function propertyOrUndefined(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  return key in value ? (value as Record<string, unknown>)[key] : undefined;
}

function installationIdentity(value: unknown) {
  const account = property(value, "account");
  return {
    installationId: decimalProperty(value, "id"),
    appId: decimalProperty(value, "app_id"),
    appSlug: githubLoginSchema.parse(stringProperty(value, "app_slug")),
    repositorySelection: z
      .enum(["all", "selected"])
      .parse(stringProperty(value, "repository_selection")),
    suspendedAt: nullableStringProperty(value, "suspended_at"),
    accountId: decimalProperty(account, "id"),
    accountLogin: githubLoginSchema.parse(stringProperty(account, "login")),
    accountType: z
      .enum(["Organization", "User"])
      .parse(stringProperty(account, "type")),
    targetType: z
      .enum(["Organization", "User"])
      .parse(stringProperty(value, "target_type")),
  };
}

function codeVerifier(stateSecret: string, nonce: string): string {
  return createHmac("sha256", stateSecret)
    .update(`github-installation-pkce\n${nonce}`)
    .digest("base64url");
}

function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function accessibleInstallation(input: {
  octokit: ReturnType<typeof createGitHubTokenOctokit>;
  appId: string;
  appSlug: string;
  requestedInstallationId?: string;
}) {
  const candidates: ReturnType<typeof installationIdentity>[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const { data: body } = await input.octokit.request(
      "GET /user/installations",
      { per_page: 100, page },
    );
    const totalCount = property(body, "total_count");
    const installations = property(body, "installations");
    if (
      typeof totalCount !== "number" ||
      !Number.isSafeInteger(totalCount) ||
      totalCount < 0 ||
      totalCount > 1_000 ||
      !Array.isArray(installations) ||
      installations.length > 100
    ) {
      throw new Error("invalid-response");
    }
    for (const value of installations) {
      const installation = installationIdentity(value);
      if (
        installation.appId === input.appId &&
        installation.appSlug === input.appSlug &&
        installation.targetType === installation.accountType &&
        (input.requestedInstallationId === undefined ||
          installation.installationId === input.requestedInstallationId)
      ) {
        candidates.push(installation);
      }
    }
    if (page * 100 >= totalCount) break;
    if (page === 10) throw new Error("too-many-installations");
  }
  if (candidates.length !== 1) throw new Error("ambiguous-installation");
  return candidates[0]!;
}

export function createGitHubAppInstallationAuthorization(input: {
  config: GitHubAppInstallationConfig;
  stateStore: GitHubInstallationAuthorizationStateStore;
  membership: GitHubInstallationMembershipAuthority;
  installationStore: HostedGitHubInstallationStore;
  credentialStore?: GitHubUserCredentialStore;
  fetch?: Fetch;
  now?: () => number;
  nonce?: () => string;
  emulation?: LocalProviderEmulation;
}) {
  const config = configSchema.parse(input.config);
  const request = input.fetch ?? fetch;
  const providerFetch: Fetch = input.emulation
    ? (resource, init) => {
        const githubUrl = new URL(
          typeof resource === "string"
            ? resource
            : resource instanceof URL
              ? resource.href
              : resource.url,
        );
        return request(
          new URL(
            `${githubUrl.pathname}${githubUrl.search}`,
            input.emulation!.githubOrigin,
          ),
          init,
        );
      }
    : request;
  const now = input.now ?? Date.now;
  const nonce = input.nonce ?? (() => randomBytes(32).toString("base64url"));
  const callbackUrl = new URL(
    "/github/installations/callback",
    config.issuer,
  ).toString();

  async function persistInstallationBinding(
    authority: HostedTenantAuthority,
    installation: ReturnType<typeof installationIdentity>,
    appliedAt: Date,
  ) {
    try {
      return await input.installationStore.bind({
        authority,
        binding: {
          installationId: installation.installationId,
          accountId: installation.accountId,
          accountLogin: installation.accountLogin,
          accountType: installation.accountType,
        },
        now: appliedAt,
      });
    } catch {
      throw new GitHubInstallationAuthorizationError("durable-tenant-binding");
    }
  }

  return {
    async begin(
      authorityInput: HostedTenantAuthority,
      returnState: ProviderConnectionReturn = { returnTo: "/" },
    ) {
      try {
        const authority = hostedTenantAuthoritySchema.parse(authorityInput);
        if (!(await input.membership.isActiveMember(authority)))
          throw new Error("membership-inactive");
        const issuedAt = now();
        const state = signedState({
          authority,
          stateSecret: config.stateSecret,
          now: issuedAt,
          nonce: nonce(),
          phase: "install",
          returnState,
        });
        await input.stateStore.create({
          stateDigest: state.stateDigest,
          authority,
          authorityDigest: state.authorityDigest,
          createdAt: new Date(issuedAt),
          expiresAt: state.expiresAt,
          returnState,
        });
        const redirect = input.emulation
          ? new URL("/local-connections/github", config.issuer)
          : new URL(`/apps/${config.appSlug}/installations/new`, GITHUB_ORIGIN);
        redirect.searchParams.set("state", state.state);
        return {
          version: 1 as const,
          action: "github-app.installation.begin" as const,
          status: "redirect" as const,
          redirectUrl: redirect.toString(),
          stateDigest: state.stateDigest,
          authorityDigest: state.authorityDigest,
          expiresAt: state.expiresAt.toISOString(),
        };
      } catch {
        throw new Error(FAILURE_MESSAGE);
      }
    },

    async complete(inputUrl: string, authorityInput: HostedTenantAuthority) {
      try {
        let authority: HostedTenantAuthority;
        let callback: ReturnType<typeof callbackInput>;
        let state: ReturnType<typeof verifyState>;
        const callbackDiagnostic = githubCallbackDiagnostic(inputUrl);
        try {
          authority = hostedTenantAuthoritySchema.parse(authorityInput);
        } catch {
          throw new GitHubInstallationAuthorizationError(
            "callback-state-validation",
            undefined,
            undefined,
            callbackDiagnostic,
            { substage: "authority-parse" },
          );
        }
        try {
          callback = callbackInput(inputUrl);
        } catch (error) {
          throw new GitHubInstallationAuthorizationError(
            "callback-state-validation",
            undefined,
            undefined,
            callbackDiagnostic,
            {
              substage: "callback-parse",
              ...(error instanceof GitHubCallbackParseError
                ? { callbackParseReason: error.reason }
                : {}),
            },
          );
        }
        try {
          state = verifyState({
            state: callback.state,
            authority,
            stateSecret: config.stateSecret,
            now: now(),
          });
        } catch (error) {
          throw new GitHubInstallationAuthorizationError(
            "callback-state-validation",
            undefined,
            undefined,
            callbackDiagnostic,
            error instanceof GitHubStateValidationError
              ? error.diagnostic
              : { substage: "state-schema" },
          );
        }
        const current = now();
        try {
          if (!(await input.membership.isActiveMember(authority)))
            throw new Error("membership-inactive");
          if (
            !(await input.stateStore.consume({
              stateDigest: state.stateDigest,
              authority,
              authorityDigest: state.authorityDigest,
              now: new Date(current),
            }))
          )
            throw new Error("state-replayed");
        } catch {
          throw new GitHubInstallationAuthorizationError(
            "membership-state-consumption",
          );
        }

        if (callback.kind === "oauth-error")
          throw new GitHubInstallationAuthorizationError(
            "oauth-callback-error",
            callback.error,
            state.returnState,
          );

        if (callback.kind === "install") {
          if (
            state.phase !== "install" ||
            state.installationId !== undefined ||
            state.setupAction !== undefined
          ) {
            throw new Error("state-phase-mismatch");
          }
          const issuedAt = now();
          const authorizationState = signedState({
            authority,
            stateSecret: config.stateSecret,
            now: issuedAt,
            nonce: nonce(),
            phase: "authorize",
            installationId: callback.installationId,
            setupAction: callback.setupAction,
            returnState: state.returnState,
          });
          await input.stateStore.create({
            stateDigest: authorizationState.stateDigest,
            authority,
            authorityDigest: authorizationState.authorityDigest,
            createdAt: new Date(issuedAt),
            expiresAt: authorizationState.expiresAt,
            returnState: state.returnState,
          });
          const verifier = codeVerifier(
            config.stateSecret,
            verifyState({
              state: authorizationState.state,
              authority,
              stateSecret: config.stateSecret,
              now: issuedAt,
            }).nonce,
          );
          const authorization = createGitHubOAuthApp({
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            redirectUrl: callbackUrl,
            fetch: providerFetch,
          }).getWebFlowAuthorizationUrl({
            state: authorizationState.state,
            redirectUrl: callbackUrl,
          });
          const authorizeUrl = new URL(authorization.url);
          if (input.emulation)
            authorizeUrl.host = new URL(input.emulation.githubOrigin).host;
          if (input.emulation)
            authorizeUrl.protocol = new URL(
              input.emulation.githubOrigin,
            ).protocol;
          authorizeUrl.searchParams.set(
            "code_challenge",
            codeChallenge(verifier),
          );
          authorizeUrl.searchParams.set("code_challenge_method", "S256");
          return {
            version: 1 as const,
            action: "github-app.installation.authorize" as const,
            status: "redirect" as const,
            redirectUrl: authorizeUrl.toString(),
            stateDigest: authorizationState.stateDigest,
            authorityDigest: authorizationState.authorityDigest,
            expiresAt: authorizationState.expiresAt.toISOString(),
          };
        }
        if (
          state.phase !== "authorize" ||
          state.installationId === undefined ||
          state.setupAction === undefined
        ) {
          throw new Error("state-phase-mismatch");
        }
        if (
          callback.installationId !== undefined &&
          (callback.installationId !== state.installationId ||
            callback.setupAction !== state.setupAction)
        )
          throw new Error("installation-mismatch");

        let authentication: unknown;
        try {
          ({ authentication } = await createGitHubOAuthApp({
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            redirectUrl: callbackUrl,
            codeVerifier: codeVerifier(config.stateSecret, state.nonce),
            fetch: providerFetch,
          }).createToken({ code: callback.code, redirectUrl: callbackUrl }));
        } catch (error) {
          const category = oauthErrorCategoryFromException(error);
          const status = propertyOrUndefined(error, "status");
          const responseStatus = propertyOrUndefined(
            propertyOrUndefined(error, "response"),
            "status",
          );
          throw new GitHubInstallationAuthorizationError(
            category !== undefined && responseStatus === 200
              ? "token-exchange-oauth-error"
              : typeof status === "number"
                ? "token-exchange-non-2xx"
                : "token-exchange-transport",
            category,
          );
        }
        const tokens = normalizedUserTokens(authentication, current);
        const userOctokit = createGitHubTokenOctokit({
          token: tokens.accessToken,
          fetch: providerFetch,
        });
        let providerUserId: string;
        let providerLogin: string;
        try {
          const { data: user } = await userOctokit.request("GET /user");
          providerUserId = decimalProperty(user, "id");
          providerLogin = githubLoginSchema.parse(
            stringProperty(user, "login"),
          );
        } catch {
          throw new GitHubInstallationAuthorizationError(
            "github-user-verification",
          );
        }
        let installation: ReturnType<typeof installationIdentity>;
        try {
          installation = input.emulation
            ? await (async () => {
                const [owner, repo] =
                  input.emulation!.githubRepository.split("/");
                if (!owner || !repo) throw new Error("invalid-emulation");
                const { data } = await userOctokit.request(
                  "GET /repos/{owner}/{repo}/installation",
                  { owner, repo },
                );
                const value = installationIdentity(data);
                if (
                  value.installationId !== state.installationId ||
                  value.appId !== config.appId
                )
                  throw new Error("installation-mismatch");
                return value;
              })()
            : await accessibleInstallation({
                octokit: userOctokit,
                appId: config.appId,
                appSlug: config.appSlug,
                requestedInstallationId: state.installationId,
              });
          if (installation.suspendedAt !== null) throw new Error();
          if (
            installation.accountType === "User" &&
            installation.accountId !== providerUserId
          )
            throw new Error();
        } catch {
          throw new GitHubInstallationAuthorizationError(
            "installation-identity-validation",
          );
        }
        try {
          if (!(await input.membership.isActiveMember(authority)))
            throw new Error("membership-inactive");
        } catch {
          throw new GitHubInstallationAuthorizationError(
            "membership-state-consumption",
          );
        }

        const appliedAt = new Date(now());
        if (input.credentialStore) {
          await input.credentialStore.bind({
            authority,
            providerUserId,
            providerLogin,
            tokens,
            now: appliedAt,
          });
        }
        const binding = await persistInstallationBinding(
          authority,
          installation,
          appliedAt,
        );
        return {
          version: 1 as const,
          action: "github-app.installation.complete" as const,
          status: "bound" as const,
          authorityDigest: state.authorityDigest,
          stateDigest: state.stateDigest,
          installationDigest: sha256(
            JSON.stringify({
              installationId: binding.installationId,
              accountId: binding.accountId,
              accountLogin: binding.accountLogin,
              accountType: binding.accountType,
            }),
          ),
          providerUserDigest: sha256(
            JSON.stringify({ id: providerUserId, login: providerLogin }),
          ),
          accountType: binding.accountType,
          repositorySelection: installation.repositorySelection,
          setupAction: state.setupAction,
          returnState: state.returnState,
          appliedAt: appliedAt.toISOString(),
        };
      } catch (error) {
        if (error instanceof GitHubInstallationAuthorizationError) throw error;
        throw new Error(FAILURE_MESSAGE);
      }
    },
  };
}
