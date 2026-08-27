import { isPublicRoutableHost } from "@better-auth/core/utils/host";
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup as resolveHostname } from "node:dns/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as requestHttps, type RequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

const BODY_FORBIDDEN_RESPONSE_STATUSES = new Set([204, 205, 304]);
const REQUEST_TIMEOUT_MS = 5_000;

type ResolveHostname = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<LookupAddress[]>;

type RequestHttps = (
  url: URL,
  options: RequestOptions,
  responseListener: (response: IncomingMessage) => void,
) => ClientRequest;

export type PreviewCimdTransportDependencies = {
  resolveHostname: ResolveHostname;
  requestHttps: RequestHttps;
  timeoutSignal?: (milliseconds: number) => AbortSignal;
};

function lookupError(hostname: string): NodeJS.ErrnoException {
  return Object.assign(
    new Error(
      `No pinned address satisfies the requested family for ${hostname}.`,
    ),
    { code: "ENOTFOUND" },
  );
}

function addressesForOptions(
  addresses: readonly LookupAddress[],
  options: LookupOptions,
): readonly LookupAddress[] {
  const requestedFamily = options.family;
  if (requestedFamily !== 4 && requestedFamily !== 6) return addresses;
  return addresses.filter(({ family }) => family === requestedFamily);
}

/**
 * Adapt resolve-once results to both Node lookup callback signatures.
 *
 * Node can request `all: true` when automatic family selection is enabled. In
 * that case the callback must receive the pinned address array, not a scalar.
 */
export function createPinnedPreviewLookup(
  addresses: readonly LookupAddress[],
): LookupFunction {
  const pinnedAddresses = addresses.map(({ address, family }) => ({
    address,
    family,
  }));

  return (hostname, options, callback) => {
    const eligible = addressesForOptions(pinnedAddresses, options);
    if (eligible.length === 0) {
      callback(lookupError(hostname), options.all ? [] : "");
      return;
    }
    if (options.all === true) {
      callback(null, [...eligible]);
      return;
    }
    callback(null, eligible[0].address, eligible[0].family);
  };
}

function responseHeaders(headers: IncomingMessage["headers"]): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else if (value !== undefined) {
      result.append(name, value);
    }
  }
  return result;
}

function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject<T>(signal.reason);

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function createPreviewCimdTransport(
  dependencies: PreviewCimdTransportDependencies = {
    resolveHostname,
    requestHttps,
  },
): ClientMetadataResourceFetch {
  return async (input, init) => {
    const webRequest = new Request(input, init);
    const url = new URL(webRequest.url);
    if (url.protocol !== "https:") {
      throw new TypeError("Preview CIMD transport requires an HTTPS URL.");
    }
    if (webRequest.method !== "GET" && webRequest.method !== "HEAD") {
      throw new TypeError("Preview CIMD transport supports only GET and HEAD.");
    }

    const callerSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const timeoutSignal = (dependencies.timeoutSignal ?? AbortSignal.timeout)(
      REQUEST_TIMEOUT_MS,
    );
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal;
    const addresses = await awaitWithAbort(
      dependencies.resolveHostname(url.hostname, {
        all: true,
        verbatim: true,
      }),
      signal,
    );
    if (addresses.length === 0) {
      throw new TypeError("Metadata hostname returned no DNS addresses.");
    }
    if (addresses.some(({ address }) => !isPublicRoutableHost(address))) {
      throw new TypeError(
        "Metadata hostname must resolve only to public-routable addresses.",
      );
    }

    const headers = Object.fromEntries(webRequest.headers.entries());
    headers.host = url.host;

    return new Promise<Response>((resolve, reject) => {
      const request = dependencies.requestHttps(
        url,
        {
          agent: false,
          headers,
          lookup: createPinnedPreviewLookup(addresses),
          method: webRequest.method,
          servername:
            isIP(url.hostname.replace(/^\[|\]$/gu, "")) === 0
              ? url.hostname
              : undefined,
          signal,
        },
        (response) => {
          const status = response.statusCode ?? 500;
          const body =
            webRequest.method === "HEAD" ||
            BODY_FORBIDDEN_RESPONSE_STATUSES.has(status)
              ? null
              : (Readable.toWeb(response) as unknown as BodyInit);
          resolve(
            new Response(body, {
              headers: responseHeaders(response.headers),
              status,
              statusText: response.statusMessage,
            }),
          );
        },
      );
      request.once("error", reject);
      request.end();
    });
  };
}

export const fetchPreviewClientMetadataResource = createPreviewCimdTransport();
