import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { z } from "zod";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import type { HostedGitHubInstallationStore } from "../repository/postgres-github-installation-store";

const GITHUB_ORIGIN = "https://github.com";
const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const USER_AGENT = "autograph-app-builder-github-installation";
const STATE_LIFETIME_MS = 10 * 60 * 1_000;
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const FAILURE_MESSAGE = "GitHub App installation authorization failed.";

type HostedTenantAuthority = z.infer<typeof hostedTenantAuthoritySchema>;

const decimalSchema = z.string().regex(/^[1-9][0-9]*$/u);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const githubLoginSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u);

const configSchema = z
  .object({
    appId: decimalSchema,
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

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function property(value: unknown, key: string): unknown {
  if (!record(value) || !(key in value)) throw new Error("invalid-response");
  return value[key];
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

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)
  ) {
    throw new Error("invalid-response");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES)
    throw new Error("invalid-response");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("invalid-response");
  }
}

function signedState(input: {
  authority: HostedTenantAuthority;
  stateSecret: string;
  now: number;
  nonce: string;
  phase: "install" | "authorize";
  installationId?: string;
  setupAction?: "install" | "update";
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
  if (input.state.length > 2_048) throw new Error("invalid-state");
  const segments = input.state.split(".");
  if (segments.length !== 2) throw new Error("invalid-state");
  const [payload, providedSignature] = segments as [string, string];
  const expectedSignature = createHmac("sha256", input.stateSecret)
    .update("github-installation-state\n")
    .update(payload)
    .digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(providedSignature, "base64url");
  } catch {
    throw new Error("invalid-state");
  }
  if (
    provided.byteLength !== expectedSignature.byteLength ||
    !timingSafeEqual(provided, expectedSignature)
  ) {
    throw new Error("invalid-state");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid-state");
  }
  const parsed = statePayloadSchema.parse(decoded);
  const nowSeconds = Math.floor(input.now / 1_000);
  if (
    parsed.authorityDigest !== authorityDigest(input.authority) ||
    parsed.expiresAt <= nowSeconds ||
    parsed.issuedAt > nowSeconds + 30 ||
    parsed.expiresAt - parsed.issuedAt !== STATE_LIFETIME_MS / 1_000
  ) {
    throw new Error("invalid-state");
  }
  return {
    stateDigest: sha256(input.state),
    authorityDigest: parsed.authorityDigest,
    nonce: parsed.nonce,
    phase: parsed.phase,
    installationId: parsed.installationId,
    setupAction: parsed.setupAction,
  };
}

function callbackInput(url: string) {
  const query = new URL(url).searchParams;
  const allowed = new Set(["code", "installation_id", "setup_action", "state"]);
  for (const key of query.keys()) {
    if (!allowed.has(key) || query.getAll(key).length !== 1)
      throw new Error("invalid-callback");
  }
  const state = z.string().min(1).max(2_048).parse(query.get("state"));
  const code = query.get("code");
  if (code !== null) {
    if (
      query.getAll("code").length !== 1 ||
      query.getAll("state").length !== 1 ||
      query.has("installation_id") ||
      query.has("setup_action")
    ) {
      throw new Error("invalid-callback");
    }
    return {
      kind: "authorize" as const,
      code: z
        .string()
        .min(1)
        .max(512)
        .refine((value) => !/[\0\r\n]/u.test(value))
        .parse(code),
      state,
    };
  }
  if (
    query.getAll("state").length !== 1 ||
    query.getAll("installation_id").length !== 1 ||
    query.getAll("setup_action").length !== 1
  ) {
    throw new Error("invalid-callback");
  }
  return {
    kind: "install" as const,
    installationId: decimalSchema.parse(query.get("installation_id")),
    setupAction: z.enum(["install", "update"]).parse(query.get("setup_action")),
    state,
  };
}

async function userAccessToken(input: {
  config: GitHubAppInstallationConfig;
  code: string;
  codeVerifier: string;
  request: Fetch;
}): Promise<string> {
  const callback = new URL(
    "/github/installations/callback",
    input.config.issuer,
  ).toString();
  const response = await input.request(
    `${GITHUB_ORIGIN}/login/oauth/access_token`,
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({
        client_id: input.config.clientId,
        client_secret: input.config.clientSecret,
        code: input.code,
        code_verifier: input.codeVerifier,
        redirect_uri: callback,
      }),
    },
  );
  if (!response.ok) throw new Error("token-exchange-failed");
  const body = await boundedJson(response);
  if (!record(body)) throw new Error("invalid-response");
  const allowed = new Set([
    "access_token",
    "token_type",
    "scope",
    "expires_in",
    "refresh_token",
    "refresh_token_expires_in",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key)))
    throw new Error("invalid-response");
  const accessToken = stringProperty(body, "access_token");
  if (
    accessToken.length < 20 ||
    accessToken.length > 512 ||
    /[\0\r\n]/u.test(accessToken) ||
    stringProperty(body, "token_type") !== "bearer" ||
    stringProperty(body, "scope") !== ""
  ) {
    throw new Error("invalid-response");
  }
  for (const key of ["expires_in", "refresh_token_expires_in"] as const) {
    if (
      key in body &&
      (typeof body[key] !== "number" ||
        !Number.isSafeInteger(body[key]) ||
        body[key] <= 0)
    ) {
      throw new Error("invalid-response");
    }
  }
  if (
    "refresh_token" in body &&
    (typeof body.refresh_token !== "string" ||
      body.refresh_token.length < 20 ||
      body.refresh_token.length > 512 ||
      /[\0\r\n]/u.test(body.refresh_token))
  ) {
    throw new Error("invalid-response");
  }
  const expiring = "expires_in" in body;
  if (
    (expiring &&
      (!("refresh_token" in body) || !("refresh_token_expires_in" in body))) ||
    (!expiring &&
      ("refresh_token" in body || "refresh_token_expires_in" in body))
  ) {
    throw new Error("invalid-response");
  }
  return accessToken;
}

async function githubJson(input: {
  request: Fetch;
  token: string;
  path: string;
}): Promise<unknown> {
  const response = await input.request(`${GITHUB_API_ORIGIN}${input.path}`, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${input.token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok) throw new Error("github-verification-failed");
  return boundedJson(response);
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
  request: Fetch;
  token: string;
  appId: string;
  requestedInstallationId?: string;
}) {
  const candidates: ReturnType<typeof installationIdentity>[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const body = await githubJson({
      request: input.request,
      token: input.token,
      path: `/user/installations?per_page=100&page=${page}`,
    });
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
        installation.appSlug === "autograph-app-builder" &&
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
  fetch?: Fetch;
  now?: () => number;
  nonce?: () => string;
}) {
  const config = configSchema.parse(input.config);
  const request = input.fetch ?? fetch;
  const now = input.now ?? Date.now;
  const nonce = input.nonce ?? (() => randomBytes(32).toString("base64url"));

  return {
    async begin(authorityInput: HostedTenantAuthority) {
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
        });
        await input.stateStore.create({
          stateDigest: state.stateDigest,
          authority,
          authorityDigest: state.authorityDigest,
          createdAt: new Date(issuedAt),
          expiresAt: state.expiresAt,
        });
        const redirect = new URL(
          "/apps/autograph-app-builder/installations/new",
          GITHUB_ORIGIN,
        );
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
        const authority = hostedTenantAuthoritySchema.parse(authorityInput);
        const callback = callbackInput(inputUrl);
        const current = now();
        const state = verifyState({
          state: callback.state,
          authority,
          stateSecret: config.stateSecret,
          now: current,
        });
        if (!(await input.membership.isActiveMember(authority)))
          throw new Error("membership-inactive");
        if (
          !(await input.stateStore.consume({
            stateDigest: state.stateDigest,
            authority,
            authorityDigest: state.authorityDigest,
            now: new Date(current),
          }))
        ) {
          throw new Error("state-replayed");
        }

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
          });
          await input.stateStore.create({
            stateDigest: authorizationState.stateDigest,
            authority,
            authorityDigest: authorizationState.authorityDigest,
            createdAt: new Date(issuedAt),
            expiresAt: authorizationState.expiresAt,
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
          const authorizeUrl = new URL("/login/oauth/authorize", GITHUB_ORIGIN);
          authorizeUrl.searchParams.set("client_id", config.clientId);
          authorizeUrl.searchParams.set(
            "redirect_uri",
            new URL("/github/installations/callback", config.issuer).toString(),
          );
          authorizeUrl.searchParams.set("state", authorizationState.state);
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

        const token = await userAccessToken({
          config,
          code: callback.code,
          codeVerifier: codeVerifier(config.stateSecret, state.nonce),
          request,
        });
        const user = await githubJson({ request, token, path: "/user" });
        const providerUserId = decimalProperty(user, "id");
        const providerLogin = githubLoginSchema.parse(
          stringProperty(user, "login"),
        );
        const installation = await accessibleInstallation({
          request,
          token,
          appId: config.appId,
          requestedInstallationId: state.installationId,
        });
        if (
          installation.repositorySelection !== "selected" ||
          installation.suspendedAt !== null
        ) {
          throw new Error("installation-mismatch");
        }
        if (
          installation.accountType === "User" &&
          installation.accountId !== providerUserId
        )
          throw new Error("installation-owner-mismatch");
        if (!(await input.membership.isActiveMember(authority)))
          throw new Error("membership-inactive");

        const appliedAt = new Date(now());
        const binding = await input.installationStore.bind({
          authority,
          binding: {
            installationId: installation.installationId,
            accountId: installation.accountId,
            accountLogin: installation.accountLogin,
            accountType: installation.accountType,
          },
          now: appliedAt,
        });
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
          repositorySelection: "selected" as const,
          setupAction: state.setupAction,
          appliedAt: appliedAt.toISOString(),
        };
      } catch {
        throw new Error(FAILURE_MESSAGE);
      }
    },
  };
}
