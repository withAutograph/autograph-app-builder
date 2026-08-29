import { createHash, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import {
  eveSessionResultSchema,
  publicPrototypePreviewUrlSchema,
  publicPrototypeSchema,
  type EveSessionResult,
  type PublicPrototype,
} from "./contracts";
import type { EveSessionService } from "../eve/service";

const previewSessionIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u);
const previewDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const previewRouteInputSchema = z
  .object({
    sessionId: previewSessionIdSchema,
    digest: previewDigestSchema,
  })
  .strict();

export const prototypePreviewContentSecurityPolicy = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "font-src data:",
  "img-src data: blob:",
  "media-src data: blob:",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
].join("; ");

const previewResponseHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "Content-Security-Policy": prototypePreviewContentSecurityPolicy,
  "Content-Type": "text/html; charset=utf-8",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy":
    "camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

function equalDigest(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function previewUrl(input: {
  requestUrl: string;
  sessionId: string;
  digest: string;
}): string | undefined {
  const parsed = previewRouteInputSchema.safeParse({
    sessionId: input.sessionId,
    digest: input.digest,
  });
  if (!parsed.success) return undefined;
  let origin: string;
  try {
    origin = new URL(input.requestUrl).origin;
  } catch {
    return undefined;
  }
  const candidate = new URL(
    `/preview/${parsed.data.sessionId}/${parsed.data.digest}`,
    `${origin}/`,
  ).href;
  return publicPrototypePreviewUrlSchema.safeParse(candidate).success
    ? candidate
    : undefined;
}

export function attachPrototypePreviewUrl(
  resultInput: EveSessionResult,
  requestUrl: string,
): EveSessionResult {
  const result = eveSessionResultSchema.parse(resultInput);
  if (result.prototype === undefined) return result;
  const url = previewUrl({
    requestUrl,
    sessionId: result.sessionId,
    digest: result.prototype.digest,
  });
  if (url === undefined) return result;
  return eveSessionResultSchema.parse({
    ...result,
    prototype: { ...result.prototype, previewUrl: url },
  });
}

export type PrototypePreviewResolver = (input: {
  request: Request;
  sessionId: string;
}) => Promise<PublicPrototype | undefined>;

export function createPrototypePreviewRequestHandler(input: {
  resolvePrototype: PrototypePreviewResolver;
}) {
  return async (
    request: Request,
    routeInput: { sessionId: string; digest: string },
  ): Promise<Response> => {
    const route = previewRouteInputSchema.safeParse(routeInput);
    if (!route.success) return new Response(null, { status: 404 });
    try {
      const prototype = publicPrototypeSchema.safeParse(
        await input.resolvePrototype({
          request,
          sessionId: route.data.sessionId,
        }),
      );
      if (
        !prototype.success ||
        !equalDigest(prototype.data.digest, route.data.digest) ||
        !equalDigest(
          createHash("sha256").update(prototype.data.content).digest("hex"),
          route.data.digest,
        )
      ) {
        return new Response(null, { status: 404 });
      }
      return new Response(prototype.data.content, {
        status: 200,
        headers: previewResponseHeaders,
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  };
}

export function createServicePrototypePreviewResolver(input: {
  serviceForRequest(request: Request): Promise<EveSessionService | undefined>;
}): PrototypePreviewResolver {
  return async ({ request, sessionId }) => {
    const service = await input.serviceForRequest(request);
    if (service === undefined) return undefined;
    const result = await service.get({ sessionId, cursor: 0, limit: 1 });
    return result.prototype;
  };
}
