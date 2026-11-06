import { createHash, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { verifyPrototypeArtifactManifest } from "../agent/prototype-artifact-stream";
import type { ReadPrototypeChunk } from "../agent/prototype-artifact-stream";
import type { PrototypeArtifactV2 } from "../agent/workflow-state";
import type { EveSessionResult, PublicPrototype } from "./contracts";
import type { EveSessionService } from "../eve/service";
import { runSequentially } from "../async-sequential";

const previewSessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/u;
const previewDigestPattern = /^[a-f0-9]{64}$/u;

const parseUnprivilegedPort = (value: string): number | undefined => {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65_535 ? port : undefined;
};

const isPreviewRouteInput = (value: { sessionId: string; digest: string }): boolean =>
  previewSessionIdPattern.test(value.sessionId) && previewDigestPattern.test(value.digest);

const isPublicPreviewUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    const loopbackHttp =
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
    const hostedHttps = url.protocol === "https:";
    const hasNoCredentials = url.username === "" && url.password === "";
    const hasNoUrlSuffix = url.search === "" && url.hash === "";
    const usesAllowedProtocol = hostedHttps || loopbackHttp;
    const hasPreviewPath = /^\/preview\/[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}\/[a-f0-9]{64}$/u.test(
      url.pathname,
    );
    return [
      hasNoCredentials,
      hasNoUrlSuffix,
      usesAllowedProtocol,
      hasPreviewPath,
      value.length <= 1024,
    ].every(Boolean);
  } catch {
    return false;
  }
};

const isPublicPrototype = (value: PublicPrototype | undefined): value is PublicPrototype => {
  if (value === undefined) return false;
  const hasContent = typeof value.content === "string" && value.content.length > 0;
  const hasValidDigest =
    typeof value.digest === "string" && previewDigestPattern.test(value.digest);
  const hasValidPath =
    typeof value.path === "string" &&
    /^prototype\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/index\.html$/u.test(value.path);
  const hasValidRevision =
    typeof value.revision === "string" && previewDigestPattern.test(value.revision);
  const hasValidPreviewUrl = value.previewUrl === undefined || isPublicPreviewUrl(value.previewUrl);
  return [
    hasContent,
    hasValidDigest,
    value.mediaType === "text/html",
    hasValidPath,
    hasValidRevision,
    hasValidPreviewUrl,
  ].every(Boolean);
};

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

export const loopbackDevelopmentOrigin = (port: number): string => {
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("The local development preview port is invalid.");
  }
  return `http://127.0.0.1:${port}`;
};

export const prototypePreviewRequestUrl = (input: {
  environment: Environment;
  requestUrl: string;
}): string => {
  const { environment } = input;
  const exactDevelopmentAdapter = [
    environment.APP_BUILDER_EXECUTION_MODE === "development",
    environment.APP_BUILDER_EXECUTION_BUNDLE === "local-development",
    environment.APP_BUILDER_SANDBOX_PROVIDER === "vercel",
    environment.APP_BUILDER_LOCAL_ADAPTER === "1",
    environment.EVE_HOSTED_ADAPTER === "0",
  ].every(Boolean);
  if (!exactDevelopmentAdapter) {
    return input.requestUrl;
  }

  const configured = environment.APP_BUILDER_DEVELOPMENT_ORIGIN;
  if (configured === undefined) {
    throw new Error("The local development preview origin is unavailable.");
  }
  const origin = new URL(configured);
  const port = parseUnprivilegedPort(origin.port);
  const supportedHttpLoopback = origin.protocol === "http:" && origin.hostname === "127.0.0.1";
  const supportedHttpsLoopback = origin.protocol === "https:" && origin.hostname === "localhost";
  const supportedLoopbackOrigin = supportedHttpLoopback || supportedHttpsLoopback;
  const hasNoCredentials = origin.username === "" && origin.password === "";
  const hasNoUrlSuffix = origin.pathname === "/" && origin.search === "" && origin.hash === "";
  if (!supportedLoopbackOrigin || port === undefined || !hasNoCredentials || !hasNoUrlSuffix) {
    throw new Error(
      "The local development preview origin must be an exact unprivileged 127.0.0.1 HTTP or localhost HTTPS origin.",
    );
  }
  return new URL("/mcp", origin).href;
};

export const prototypePreviewContentSecurityPolicy = [
  "sandbox allow-forms allow-scripts",
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

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function emptyPreviewNotFoundResponse(): Response {
  return new Response(null, {
    headers: previewResponseHeaders,
    status: 404,
  });
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function equalDigest(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function previewUrl(input: {
  requestUrl: string;
  sessionId: string;
  digest: string;
}): string | undefined {
  if (!isPreviewRouteInput(input)) {
    return undefined;
  }
  let origin: string;
  try {
    ({ origin } = new URL(input.requestUrl));
  } catch {
    return undefined;
  }
  const candidate = new URL(`/preview/${input.sessionId}/${input.digest}`, `${origin}/`).href;
  return isPublicPreviewUrl(candidate) ? candidate : undefined;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function attachPrototypePreviewUrl(
  resultInput: EveSessionResult,
  requestUrl: string,
): EveSessionResult {
  const result = resultInput;
  const selected = result.prototypeRef ?? result.prototype;
  if (selected === undefined) {
    return result;
  }
  const url = previewUrl({
    digest: selected.digest,
    requestUrl,
    sessionId: result.sessionId,
  });
  if (url === undefined) {
    return result;
  }
  const updatedResult = { ...result };
  if (result.prototype !== undefined && result.prototypeRef === undefined) {
    updatedResult.prototype = { ...result.prototype, previewUrl: url };
  }
  if (result.prototypeRef !== undefined) {
    updatedResult.prototypeRef = { ...result.prototypeRef, previewUrl: url };
  }
  if (result.uiPreview !== undefined) {
    updatedResult.uiPreview = { ...result.uiPreview, previewUrl: url };
  }
  return updatedResult;
}

export type PrototypePreviewResolver = (input: {
  request: Request;
  sessionId: string;
}) => Promise<PublicPrototype | undefined>;

/** The resolver must authorize the request and bind immutable chunks to this tenant and session. */
export type StreamedPrototypePreviewResolver = (input: {
  request: Request;
  sessionId: string;
}) => Promise<
  | {
      artifact: PrototypeArtifactV2;
      /** Server-authorized stored public/native binding; never supplied by the Browser. */
      authorizedSessionAlias?: { publicSessionId: string; artifactSessionId: string };
      readChunk: ReadPrototypeChunk;
    }
  | undefined
>;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createPrototypePreviewRequestHandler(input: {
  resolvePrototype: PrototypePreviewResolver;
  resolveStreamedPrototype?: StreamedPrototypePreviewResolver;
}) {
  return async (
    request: Request,
    routeInput: { sessionId: string; digest: string },
  ): Promise<Response> => {
    if (!isPreviewRouteInput(routeInput)) {
      return emptyPreviewNotFoundResponse();
    }
    const { sessionId, digest } = routeInput;
    try {
      const streamed = await input.resolveStreamedPrototype?.({
        request,
        sessionId,
      });
      if (streamed !== undefined) {
        const { artifact, authorizedSessionAlias, readChunk } = streamed;
        const sessionBound =
          authorizedSessionAlias === undefined
            ? artifact.sessionId === sessionId
            : authorizedSessionAlias.publicSessionId === sessionId &&
              authorizedSessionAlias.artifactSessionId === artifact.sessionId;
        if (
          !sessionBound ||
          artifact.mediaType !== "text/html" ||
          !artifact.path.endsWith("/index.html") ||
          !equalDigest(artifact.digest, digest)
        ) {
          return emptyPreviewNotFoundResponse();
        }
        // Finish complete manifest and content validation before response headers or bytes are sent.
        await verifyPrototypeArtifactManifest({ artifact, readChunk });
        let nextIndex = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (nextIndex >= artifact.chunkCount) {
                controller.close();
                return;
              }
              const content = await readChunk(nextIndex);
              if (content === undefined) {
                controller.error(new Error("A verified prototype chunk became unavailable."));
                return;
              }
              nextIndex += 1;
              controller.enqueue(Buffer.from(content, "utf-8"));
            },
          }),
          { headers: previewResponseHeaders, status: 200 },
        );
      }
      const prototype = await input.resolvePrototype({ request, sessionId });
      if (
        !isPublicPrototype(prototype) ||
        !equalDigest(prototype.digest, digest) ||
        !equalDigest(createHash("sha256").update(prototype.content).digest("hex"), digest)
      ) {
        return emptyPreviewNotFoundResponse();
      }
      return new Response(prototype.content, {
        headers: previewResponseHeaders,
        status: 200,
      });
    } catch {
      return emptyPreviewNotFoundResponse();
    }
  };
}

export const createServicePrototypePreviewResolver =
  (input: {
    serviceForRequest: (request: Request) => Promise<EveSessionService | undefined>;
  }): PrototypePreviewResolver =>
  async ({ request, sessionId }) => {
    const service = await input.serviceForRequest(request);
    let prototype: PublicPrototype | undefined;
    if (service !== undefined) {
      // The public event tail can expose the preview URL just before the
      // corresponding prototype event has reached the request-scoped read. Give
      // that normal delivery race a short chance to settle so the first Browser
      // navigation does not turn a valid preview into a sticky 404.
      await runSequentially([0, 1, 2, 3, 4], async (attempt) => {
        if (prototype !== undefined) return;
        const result = await service.get({ cursor: 0, limit: 1, sessionId });
        if (result.prototype !== undefined) {
          ({ prototype } = result);
          return;
        }
        if (attempt < 4) {
          await delay(100);
        }
      });
    }
    return prototype;
  };
