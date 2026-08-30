import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type { BetterAuthPlugin } from "@better-auth/core";
import {
  createAuthEndpoint,
  createAuthMiddleware,
} from "@better-auth/core/api";
import { getCurrentAdapter } from "@better-auth/core/context";
import { passkey } from "@better-auth/passkey";
import { APIError, getSessionFromCtx } from "better-auth/api";
import { z } from "zod";

const ENABLED_VALUE = "local-preview-v1";
const PROTECTION_VALUE = "vercel-authentication";
const TOKEN_VERSION = 1;
const TOKEN_TTL_SECONDS = 5 * 60;
const INTERNAL_EMAIL_DOMAIN = "passkey.autograph.invalid";

const tokenPayloadSchema = z
  .object({
    version: z.literal(TOKEN_VERSION),
    nonce: z.string().uuid(),
    userHandle: z.string().uuid(),
    deploymentId: z.string().min(1).max(256),
    origin: z.string().url(),
    rpId: z.string().min(1).max(253),
    expiresAt: z.number().int().positive(),
  })
  .strict();

export interface PasskeyOnboardingConfig {
  origin: string;
  rpId: string;
  deploymentId: string;
  secret: string;
  secureCookies: boolean;
}

function exactOrigin(value: string | undefined) {
  const url = new URL(value ?? "");
  if (url.pathname !== "/api/auth" || url.search || url.hash) {
    throw new Error("Passkey onboarding requires the exact auth issuer URL.");
  }
  return url.origin;
}

function isLoopback(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

export function readPasskeyOnboardingConfig(
  environment: Readonly<Record<string, string | undefined>>,
): PasskeyOnboardingConfig | null {
  if (environment.PASSKEY_ONBOARDING !== ENABLED_VALUE) return null;

  const secret = environment.BETTER_AUTH_SECRET?.trim();
  if (!secret || secret.length < 32 || /[\0\r\n]/u.test(secret)) {
    throw new Error("Passkey onboarding requires BETTER_AUTH_SECRET.");
  }

  const derivedPreviewIssuer =
    environment.VERCEL_ENV === "preview" && environment.VERCEL_URL
      ? `https://${environment.VERCEL_URL}/api/auth`
      : undefined;
  const origin = exactOrigin(
    environment.BETTER_AUTH_URL ?? derivedPreviewIssuer,
  );
  const hostname = new URL(origin).hostname;
  if (environment.VERCEL_ENV === "production") {
    throw new Error("Passkey onboarding is unavailable in Production.");
  }

  if (environment.VERCEL_ENV === "preview") {
    if (environment.PASSKEY_PREVIEW_PROTECTION !== PROTECTION_VALUE) {
      throw new Error(
        "Preview passkey onboarding requires an explicit Vercel Authentication protection acknowledgement.",
      );
    }
    const deploymentId = environment.VERCEL_DEPLOYMENT_ID?.trim();
    const deploymentHostname = environment.VERCEL_URL?.trim();
    if (
      !deploymentId ||
      deploymentId.length > 256 ||
      !deploymentHostname ||
      deploymentHostname !== hostname ||
      !origin.startsWith("https://")
    ) {
      throw new Error(
        "Preview passkey onboarding requires exact Vercel deployment metadata.",
      );
    }
    return {
      origin,
      rpId: hostname,
      deploymentId,
      secret,
      secureCookies: true,
    };
  }

  if (
    environment.NODE_ENV === "production" ||
    environment.VERCEL_ENV !== undefined ||
    !isLoopback(hostname)
  ) {
    throw new Error(
      "Local passkey onboarding requires a non-Production loopback origin.",
    );
  }
  const localProviderEmulation =
    environment.APP_BUILDER_LOCAL_PROVIDER_EMULATION === "1";
  const localAuthEmulation =
    environment.APP_BUILDER_LOCAL_AUTH_EMULATION === "1";
  const isHttps = origin.startsWith("https://");
  if (
    (!origin.startsWith("http://") && !isHttps) ||
    (isHttps &&
      (origin !== "https://localhost:3001" ||
        !localProviderEmulation ||
        !localAuthEmulation))
  ) {
    throw new Error(
      "HTTPS loopback passkey onboarding requires explicit local provider and authentication emulation gates.",
    );
  }
  return {
    origin,
    rpId: hostname,
    deploymentId: "local",
    secret,
    secureCookies: isHttps,
  };
}

function encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function sign(encodedPayload: string, secret: string) {
  return createHmac("sha256", secret)
    .update("autograph-passkey-onboarding-v1\0")
    .update(encodedPayload)
    .digest("base64url");
}

function tokenDigest(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function personalWorkspaceSlug(userId: string, deploymentId: string) {
  const digest = createHash("sha256")
    .update("autograph-passkey-workspace-v1\0")
    .update(deploymentId)
    .update("\0")
    .update(userId)
    .digest("hex");
  return `personal-${digest.slice(0, 24)}`;
}

export function createPasskeyOnboardingToken(
  config: PasskeyOnboardingConfig,
  now = new Date(),
) {
  const payload = tokenPayloadSchema.parse({
    version: TOKEN_VERSION,
    nonce: randomUUID(),
    userHandle: randomUUID(),
    deploymentId: config.deploymentId,
    origin: config.origin,
    rpId: config.rpId,
    expiresAt: Math.floor(now.getTime() / 1000) + TOKEN_TTL_SECONDS,
  });
  const encodedPayload = encode(JSON.stringify(payload));
  const token = `${encodedPayload}.${sign(encodedPayload, config.secret)}`;
  return { payload, token, digest: tokenDigest(token) };
}

export function verifyPasskeyOnboardingToken(
  token: string | null | undefined,
  config: PasskeyOnboardingConfig,
  now = new Date(),
) {
  if (!token || token.length > 4_096) return null;
  const [encodedPayload, signature, extra] = token.split(".");
  if (!encodedPayload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(encodedPayload, config.secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }
  try {
    const payload = tokenPayloadSchema.parse(
      JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")),
    );
    if (
      payload.expiresAt <= Math.floor(now.getTime() / 1000) ||
      payload.deploymentId !== config.deploymentId ||
      payload.origin !== config.origin ||
      payload.rpId !== config.rpId
    ) {
      return null;
    }
    return { payload, digest: tokenDigest(token) };
  } catch {
    return null;
  }
}

function onboardingUnavailable() {
  return APIError.from("FORBIDDEN", {
    code: "PASSKEY_ONBOARDING_UNAVAILABLE",
    message: "Passkey registration is unavailable on this deployment.",
  });
}

function invalidOnboardingAuthority() {
  return APIError.from("UNAUTHORIZED", {
    code: "PASSKEY_ONBOARDING_AUTHORITY_INVALID",
    message: "Passkey registration expired or was already used.",
  });
}

export function createPasskeyOnboardingPlugin(input: {
  config: PasskeyOnboardingConfig | null;
  now?: () => Date;
}): BetterAuthPlugin {
  const now = input.now ?? (() => new Date());
  return {
    id: "autograph-passkey-onboarding",
    init() {
      return {
        options: {
          databaseHooks: {
            session: {
              create: {
                async before(
                  session: Record<string, unknown> & { userId: string },
                  ctx: { path?: string; context: { adapter: unknown } } | null,
                ) {
                  if (ctx?.path !== "/passkey/verify-registration") return;
                  const adapter = await getCurrentAdapter(
                    ctx.context.adapter as Parameters<
                      typeof getCurrentAdapter
                    >[0],
                  );
                  const memberships = await adapter.findMany<{
                    organizationId: string;
                  }>({
                    model: "member",
                    where: [{ field: "userId", value: session.userId }],
                    limit: 2,
                  });
                  if (memberships.length !== 1 || !memberships[0]) {
                    throw APIError.from("INTERNAL_SERVER_ERROR", {
                      code: "PASSKEY_WORKSPACE_SETUP_FAILED",
                      message: "Passkey workspace setup failed.",
                    });
                  }
                  return {
                    data: {
                      ...session,
                      activeOrganizationId: memberships[0].organizationId,
                    },
                  };
                },
              },
            },
          },
        },
      };
    },
    endpoints: {
      createPasskeyOnboardingContext: createAuthEndpoint(
        "/passkey/onboarding-context",
        {
          method: "POST",
          body: z.object({}).strict(),
          metadata: { noStore: true },
        },
        async (ctx) => {
          const config = input.config;
          if (!config) throw onboardingUnavailable();
          if (ctx.headers?.get("origin") !== config.origin) {
            throw invalidOnboardingAuthority();
          }
          const issued = createPasskeyOnboardingToken(config, now());
          await ctx.context.adapter.create({
            model: "passkeyOnboarding",
            data: {
              id: issued.payload.nonce,
              tokenDigest: issued.digest,
              deploymentId: issued.payload.deploymentId,
              origin: issued.payload.origin,
              rpId: issued.payload.rpId,
              userHandle: issued.payload.userHandle,
              expiresAt: new Date(issued.payload.expiresAt * 1000),
              createdAt: now(),
            },
            forceAllowId: true,
          });
          return ctx.json({ context: issued.token });
        },
      ),
    },
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/passkey/delete-passkey",
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            if (!session?.user.id) return;
            const count = await ctx.context.adapter.count({
              model: "passkey",
              where: [{ field: "userId", value: session.user.id }],
            });
            if (count <= 1) {
              throw APIError.from("BAD_REQUEST", {
                code: "FINAL_PASSKEY_REQUIRED",
                message: "Add another passkey before deleting this one.",
              });
            }
          }),
        },
      ],
    },
    schema: {
      passkeyOnboarding: {
        fields: {
          tokenDigest: { type: "string", required: true, unique: true },
          deploymentId: { type: "string", required: true },
          origin: { type: "string", required: true },
          rpId: { type: "string", required: true },
          userHandle: { type: "string", required: true, unique: true },
          expiresAt: { type: "date", required: true },
          createdAt: { type: "date", required: true },
        },
      },
    },
    rateLimit: [
      {
        pathMatcher: (path) => path === "/passkey/onboarding-context",
        window: 60,
        max: 10,
      },
    ],
  };
}

export function createPasskeyPlugin(input: {
  config: PasskeyOnboardingConfig | null;
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  return passkey({
    ...(input.config
      ? { origin: input.config.origin, rpID: input.config.rpId }
      : {}),
    registration: {
      requireSession: false,
      async resolveUser({ context }) {
        const config = input.config;
        if (!config) throw onboardingUnavailable();
        const verified = verifyPasskeyOnboardingToken(context, config, now());
        if (!verified) throw invalidOnboardingAuthority();
        return {
          id: verified.payload.userHandle,
          name: "Autograph passkey user",
          displayName: "Autograph user",
        };
      },
      async afterVerification({ ctx, context }) {
        const existingSession = await getSessionFromCtx(ctx);
        if (existingSession?.user.id) {
          return {
            userId: existingSession.user.id,
            name: "Additional passkey",
          };
        }
        const config = input.config;
        if (!config) throw onboardingUnavailable();
        const verified = verifyPasskeyOnboardingToken(context, config, now());
        if (!verified) throw invalidOnboardingAuthority();
        const adapter = await getCurrentAdapter(ctx.context.adapter);
        const consumed = await adapter.consumeOne<{
          userHandle: string;
          expiresAt: Date;
        }>({
          model: "passkeyOnboarding",
          where: [
            { field: "id", value: verified.payload.nonce },
            { field: "tokenDigest", value: verified.digest },
            { field: "userHandle", value: verified.payload.userHandle },
          ],
        });
        if (!consumed || consumed.expiresAt.getTime() <= now().getTime()) {
          throw invalidOnboardingAuthority();
        }
        const user = await ctx.context.internalAdapter.createUser(
          {
            name: "Autograph user",
            email: `${verified.payload.userHandle}@${INTERNAL_EMAIL_DOMAIN}`,
            emailVerified: false,
          },
          { method: "passkey" },
        );
        const organizationId = randomUUID();
        const workspaceId = randomUUID();
        await adapter.create({
          model: "organization",
          data: {
            id: organizationId,
            name: "My Workspace",
            slug: personalWorkspaceSlug(user.id, config.deploymentId),
            createdAt: now(),
            issuer: `${config.origin}/api/auth`,
            audience: `${config.origin}/mcp`,
            workspaceId,
          },
          forceAllowId: true,
        });
        await adapter.create({
          model: "member",
          data: {
            id: randomUUID(),
            organizationId,
            userId: user.id,
            role: "owner",
            createdAt: now(),
          },
          forceAllowId: true,
        });
        return { userId: user.id, name: "Primary passkey" };
      },
    },
  });
}
