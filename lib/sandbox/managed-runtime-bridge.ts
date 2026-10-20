/* oxlint-disable sonarjs/no-nested-functions -- Node HTTP and upgrade callbacks retain the same authorized request/socket closure through owned transport cleanup. */
/* oxlint-disable promise/avoid-new -- Owned Node listener close events require an event-to-Promise adapter. */
import { createServer, request as upstreamRequest } from "node:http";
import type { IncomingMessage, OutgoingHttpHeaders } from "node:http";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import {
  managedRuntimeIdentitySchema,
  managedRuntimeCurrentSchema,
  managedRuntimePublicProfileSchema,
  verifyManagedCapability,
} from "./managed-runtime-capabilities";
import type {
  ManagedRuntimeIdentity,
  ManagedRuntimeCurrent,
  ManagedRuntimePublicProfile,
} from "./managed-runtime-capabilities";

export const MANAGED_RUNTIME_SUITE_HEADER = "x-platform-managed-suite";
interface VerifiedRequest {
  headers: Headers;
  method: string;
  target: string;
  body?: Uint8Array;
  actors: readonly { actorId: string; organizationId: string }[];
}
/** Arrusted's frozen createManagedGatewayVerification/verifyManagedGatewayRequest exports fit this port directly. */
export interface ManagedGatewayVerificationAdapter<Configuration> {
  createVerification: (input: {
    profile: ManagedRuntimePublicProfile;
    appId: string;
    publicOrigin: string;
    jwksUrl: string;
  }) => Configuration;
  verifyRequest: (
    input: VerifiedRequest & { verification: Configuration },
  ) => Promise<{ sub: string }>;
}
interface Destroyable {
  destroy: () => void;
}
const unavailable = () => new Error("Managed Gateway request unavailable.");
const incomingHeaders = (request: IncomingMessage) => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) {
      headers.set(name, Array.isArray(value) ? value.join(",") : value);
    }
  }
  return headers;
};
const hop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const appHeaders = (
  request: IncomingMessage,
  publicOrigin: URL,
  upgrade: boolean,
): OutgoingHttpHeaders => {
  const excluded = new Set([
    ...hop,
    ...(request.headers.connection ?? "")
      .toLowerCase()
      .split(",")
      .map((name) => name.trim()),
  ]);
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const credentialHeader =
      name === "authorization" ||
      name === MANAGED_RUNTIME_SUITE_HEADER ||
      [
        "x-vercel-oidc-token",
        "x-vercel-trusted-oidc-idp-token",
        "x-vercel-protection-bypass",
        "x-vercel-set-bypass-cookie",
      ].includes(name);
    const forwardingHeader = name === "forwarded" || name.startsWith("x-forwarded-");
    if (excluded.has(name) || credentialHeader || forwardingHeader) {
      continue;
    }
    headers[name] = value;
  }
  headers.host = publicOrigin.host;
  headers["x-forwarded-host"] = publicOrigin.host;
  headers["x-forwarded-proto"] = publicOrigin.protocol.slice(0, -1);
  headers["x-forwarded-port"] = publicOrigin.port || "443";
  if (upgrade) {
    headers.connection = "Upgrade";
    headers.upgrade = request.headers.upgrade;
  }
  return headers;
};
const collectBody = async (request: IncomingMessage, limit: number) => {
  const parts: Buffer[] = [];
  let length = 0;
  for await (const part of request) {
    const bytes = Buffer.from(z.instanceof(Uint8Array).parse(part));
    length += bytes.length;
    if (length > limit) {
      throw unavailable();
    }
    parts.push(bytes);
  }
  return Buffer.concat(parts);
};

/** A private fixed-loopback bridge. It has public verification keys and capability hashes, never signing/Auth/OIDC credentials. */
export const createManagedRuntimeBridge = <Configuration>(input: {
  identity: ManagedRuntimeIdentity;
  profile: ManagedRuntimePublicProfile;
  transportSha256: string;
  actors: readonly { actorId: string; organizationId: string }[];
  appPort: number;
  expiresAt: number;
  ownershipSignal: AbortSignal;
  /** Host-published local ownership only: no provider, model, Auth or remote journal lookup per app request. */
  readCurrent: () => Promise<ManagedRuntimeCurrent>;
  verification: ManagedGatewayVerificationAdapter<Configuration>;
  /** Same per-entity memory boundary as the already configured Gateway, not an export/app workload quota. */
  maxBoundRequestBodyBytes?: number;
  now?: () => Date;
}) => {
  const identity = managedRuntimeIdentitySchema.parse(structuredClone(input.identity));
  const profile = managedRuntimePublicProfileSchema.parse(structuredClone(input.profile));
  const actors = z
    .array(z.strictObject({ actorId: z.string().min(1), organizationId: z.string().min(1) }))
    .min(1)
    .parse(structuredClone(input.actors));
  const appPort = z.number().int().min(1).max(65_535).parse(input.appPort);
  const transportSha256 = z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .parse(input.transportSha256);
  const now = input.now ?? (() => new Date());
  if (
    profile.appId !== identity.appId ||
    !Number.isFinite(input.expiresAt) ||
    input.expiresAt <= now().getTime()
  ) {
    throw unavailable();
  }
  const publicOrigin = new URL(profile.publicOrigin);
  let verification = input.verification.createVerification({
    profile,
    appId: identity.appId,
    publicOrigin: profile.publicOrigin,
    jwksUrl: profile.jwksUrl,
  });
  const limit = z
    .number()
    .int()
    .positive()
    .refine(Number.isSafeInteger)
    .parse(input.maxBoundRequestBodyBytes ?? 10 * 1024 * 1024);
  const controller = new AbortController();
  const signal = AbortSignal.any([input.ownershipSignal, controller.signal]);
  const connections = new Set<Destroyable>();
  const timer = setTimeout(() => {
    controller.abort();
  }, input.expiresAt - now().getTime());
  timer.unref();
  const assertCurrent = async () => {
    if (signal.aborted || now().getTime() >= input.expiresAt) {
      throw unavailable();
    }
    const current = managedRuntimeCurrentSchema.parse(await input.readCurrent());
    const { state, leaseExpiresAt, ...observed } = current;
    if (
      !isDeepStrictEqual(observed, identity) ||
      state !== "ready" ||
      Date.parse(leaseExpiresAt) <= now().getTime() ||
      signal.aborted
    ) {
      throw unavailable();
    }
  };
  const authorize = async (request: IncomingMessage, body?: Uint8Array) => {
    const authorization = request.headers.authorization;
    const bearer =
      authorization !== undefined && authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : undefined;
    if (!verifyManagedCapability(bearer, transportSha256)) {
      throw unavailable();
    }
    await assertCurrent();
    await input.verification.verifyRequest({
      verification,
      headers: incomingHeaders(request),
      method: request.method ?? "GET",
      target: request.url ?? "/",
      ...(body === undefined ? {} : { body }),
      actors,
    });
    await assertCurrent();
  };
  const server = createServer((request, response) => {
    void (async () => {
      try {
        // Reject unauthenticated ingress before buffering any entity bytes.
        const authorization = request.headers.authorization;
        if (
          !verifyManagedCapability(
            authorization !== undefined && authorization.startsWith("Bearer ")
              ? authorization.slice(7)
              : undefined,
            transportSha256,
          )
        ) {
          throw unavailable();
        }
        const body = await collectBody(request, limit);
        await authorize(request, body);
        const headers = appHeaders(request, publicOrigin, false);
        headers["content-length"] = body.length;
        const upstream = upstreamRequest(
          {
            hostname: "127.0.0.1",
            port: appPort,
            path: request.url ?? "/",
            method: request.method ?? "GET",
            headers,
          },
          (incoming) => {
            response.writeHead(incoming.statusCode ?? 502, incoming.headers);
            incoming.pipe(response);
            incoming.on("error", () => {
              response.destroy();
            });
          },
        );
        connections.add(upstream);
        upstream.once("close", () => {
          connections.delete(upstream);
        });
        upstream.on("error", () => {
          if (response.headersSent) {
            response.destroy();
          } else {
            response.writeHead(502, { "cache-control": "no-store" });
            response.end();
          }
        });
        response.once("close", () => {
          upstream.destroy();
        });
        upstream.end(body);
      } catch {
        response.writeHead(403, { "cache-control": "no-store" });
        response.end();
      }
    })();
  });
  const denyUpgrade = (socket: Duplex) => {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  };
  server.on("upgrade", (request, socket, head) => {
    connections.add(socket);
    socket.once("close", () => {
      connections.delete(socket);
    });
    socket.on("error", () => {
      socket.destroy();
    });
    void (async () => {
      try {
        await authorize(request);
        const upstream = upstreamRequest({
          hostname: "127.0.0.1",
          port: appPort,
          path: request.url ?? "/",
          method: request.method ?? "GET",
          headers: appHeaders(request, publicOrigin, true),
        });
        connections.add(upstream);
        upstream.once("close", () => {
          connections.delete(upstream);
        });
        upstream.once("upgrade", (incoming, childSocket, childHead) => {
          connections.add(childSocket);
          childSocket.once("close", () => {
            connections.delete(childSocket);
          });
          childSocket.on("error", () => {
            socket.destroy();
          });
          const responseHeaders = Object.entries(incoming.headers).flatMap(([name, value]) =>
            value === undefined
              ? []
              : [`${name}: ${Array.isArray(value) ? value.join(", ") : value}`],
          );
          socket.write(
            `HTTP/1.1 ${incoming.statusCode ?? 101} Switching Protocols\r\n${responseHeaders.join("\r\n")}\r\n\r\n`,
          );
          if (childHead.length > 0) {
            socket.write(childHead);
          }
          if (head.length > 0) {
            childSocket.write(head);
          }
          childSocket.pipe(socket);
          socket.pipe(childSocket);
          socket.once("close", () => {
            childSocket.destroy();
          });
        });
        upstream.once("response", (incoming) => {
          incoming.destroy();
          denyUpgrade(socket);
        });
        upstream.on("error", () => {
          denyUpgrade(socket);
        });
        socket.once("close", () => {
          upstream.destroy();
        });
        upstream.end();
      } catch {
        denyUpgrade(socket);
      }
    })();
  });
  // Include HTTP ingress before its entity is complete; these sockets are owned
  // even while collectBody has not yet created an upstream request.
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => {
      connections.delete(socket);
    });
    if (signal.aborted) {
      socket.destroy();
    }
  });
  let closing: Promise<void> | undefined;
  const shutdown = () => {
    closing ??= new Promise<void>((resolve, reject) => {
      // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Node server close acknowledgement is retained once and awaited by every owner close call.
      server.close((error) => {
        if (
          error &&
          !z.object({ code: z.literal("ERR_SERVER_NOT_RUNNING") }).safeParse(error).success
        ) {
          reject(error);
        } else {
          resolve();
        }
      });
      for (const connection of connections) {
        connection.destroy();
      }
    });
    return closing;
  };
  signal.addEventListener(
    "abort",
    () => {
      void (async () => {
        try {
          await shutdown();
        } catch {
          // The retained close promise reports listener cleanup failure to its owner.
        }
      })();
    },
    { once: true },
  );
  return {
    server,
    async replacePublicProfile(value: ManagedRuntimePublicProfile): Promise<void> {
      const replacement = managedRuntimePublicProfileSchema.parse(structuredClone(value));
      if (
        replacement.appId !== profile.appId ||
        replacement.publicOrigin !== profile.publicOrigin ||
        replacement.jwksUrl !== profile.jwksUrl
      ) {
        throw unavailable();
      }
      await assertCurrent();
      const next = input.verification.createVerification({
        profile: replacement,
        appId: identity.appId,
        publicOrigin: profile.publicOrigin,
        jwksUrl: profile.jwksUrl,
      });
      await assertCurrent();
      verification = next;
    },
    async close() {
      clearTimeout(timer);
      controller.abort();
      await shutdown();
    },
  };
};
