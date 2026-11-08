import type { LookupAddress, LookupOptions } from "node:dns";
import { EventEmitter, once } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { createPinnedPreviewLookup, createPreviewCimdTransport } from "./preview-cimd-transport";

const publicAddresses: LookupAddress[] = [
  // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Public IPv4 fixture verifies pinned DNS.
  { address: "93.184.216.34", family: 4 },
  // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Public IPv6 fixture verifies pinned DNS.
  { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
];

// oxlint-disable-next-line typescript/promise-function-async, eslint/func-style -- Preserve this test double's existing promise and synchronous behavior. Preserve function declaration hoisting and initialization timing.
function runLookup(options: LookupOptions) {
  const lookup = new EventTarget();
  let lookupAddress: string | LookupAddress[] | undefined;
  let lookupError: Error | null = null;
  let lookupFamily: number | undefined;
  const result = once(lookup, "result");
  createPinnedPreviewLookup(publicAddresses)(
    "client.example.com",
    options,
    // Node's dns.lookup contract is callback-based.
    // oxlint-disable-next-line promise/prefer-await-to-callbacks
    (error, address, family) => {
      lookupAddress = address;
      lookupError = error;
      lookupFamily = family;
      lookup.dispatchEvent(new Event("result"));
    },
  );
  // oxlint-disable-next-line github/no-then -- Preserve the existing promise sequencing and settlement behavior.
  return result.then(() => {
    if (lookupError) {
      throw lookupError;
    }
    if (lookupAddress === undefined) {
      throw new Error("Expected a DNS lookup address.");
    }
    return { address: lookupAddress, family: lookupFamily };
  });
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function requestFixture(input: { lookupOptions: LookupOptions; responseStatus?: number }) {
  // oxlint-disable-next-line anti-slop/no-known-value-widening -- Keep the declared shape for values assigned later.
  const observed: { options?: RequestOptions; url?: URL } = {};
  const requestHttps = vi.fn(
    (url: URL, options: RequestOptions, responseListener: (response: IncomingMessage) => void) => {
      observed.url = url;
      observed.options = options;
      // ClientRequest is a Node EventEmitter by contract.
      // oxlint-disable-next-line unicorn/prefer-event-target, anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing type assertion at this boundary.
      const request = new EventEmitter() as ClientRequest;
      request.end = () => {
        // Node's dns.lookup contract is callback-based.
        const { lookup } = options;
        if (!lookup) {
          throw new Error("Expected the transport to provide a DNS lookup function.");
        }
        // oxlint-disable-next-line promise/prefer-await-to-callbacks
        lookup(url.hostname, input.lookupOptions, (error, address) => {
          if (error) {
            request.emit("error", error);
            return;
          }
          if (input.lookupOptions.all === true) {
            expect(address).toEqual(publicAddresses);
          } else {
            expect(address).toBe(publicAddresses[0].address);
          }
          // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- Preserve the existing type assertion at this boundary.
          const response = Readable.from([Buffer.from("metadata-body")]) as IncomingMessage;
          response.statusCode = input.responseStatus ?? 200;
          response.statusMessage = "Fixture";
          response.headers = { "content-type": "application/json" };
          responseListener(response);
        });
        return request;
      };
      return request;
    },
  );
  return { observed, requestHttps };
}

describe("Preview CIMD transport", () => {
  it("returns the pinned array when Node requests all lookup results", async () => {
    await expect(runLookup({ all: true })).resolves.toEqual({
      address: publicAddresses,
      // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
      family: undefined,
    });
  });

  it("returns a pinned scalar when Node requests the scalar signature", async () => {
    await expect(runLookup({ all: false })).resolves.toEqual({
      address: publicAddresses[0].address,
      family: publicAddresses[0].family,
    });
  });

  it.each([{ all: true }, { all: false }])(
    "resolves once and preserves host and SNI for lookup options %o",
    async (lookupOptions) => {
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      const resolveHostname = vi.fn(async () => publicAddresses);
      const fixture = requestFixture({ lookupOptions });
      const fetchMetadata = createPreviewCimdTransport({
        requestHttps: fixture.requestHttps,
        resolveHostname,
      });

      const response = await fetchMetadata("https://client.example.com:8443/metadata.json", {
        method: "GET",
      });

      expect(await response.text()).toBe("metadata-body");
      expect(resolveHostname).toHaveBeenCalledOnce();
      expect(resolveHostname).toHaveBeenCalledWith("client.example.com", {
        all: true,
        verbatim: true,
      });
      expect(fixture.observed.options).toMatchObject({
        agent: false,
        headers: { host: "client.example.com:8443" },
        method: "GET",
        servername: "client.example.com",
      });
      expect(fixture.observed.options?.signal).toBeInstanceOf(AbortSignal);
    },
  );

  it("rejects a private DNS answer before opening a connection", async () => {
    const requestHttps = vi.fn();
    const fetchMetadata = createPreviewCimdTransport({
      requestHttps,
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      resolveHostname: vi.fn(async () => [
        publicAddresses[0],
        // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Reject the link-local metadata address.
        { address: "169.254.169.254", family: 4 },
      ]),
    });

    await expect(fetchMetadata("https://client.example.com/metadata.json")).rejects.toThrow(
      "public-routable",
    );
    expect(requestHttps).not.toHaveBeenCalled();
  });

  it("applies the internal timeout while DNS resolution is pending", async () => {
    const timeout = new AbortController();
    const timeoutSignal = vi.fn(() => timeout.signal);
    const requestHttps = vi.fn();
    const fetchMetadata = createPreviewCimdTransport({
      requestHttps,
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
      resolveHostname: vi.fn(() => Promise.withResolvers<LookupAddress[]>().promise),
      timeoutSignal,
    });

    const rejection = expect(
      fetchMetadata("https://client.example.com/metadata.json"),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    timeout.abort(new DOMException("Timed out.", "TimeoutError"));

    await rejection;
    expect(timeoutSignal).toHaveBeenCalledWith(5000);
    expect(requestHttps).not.toHaveBeenCalled();
  });

  it("honors caller abort while DNS resolution is pending", async () => {
    const controller = new AbortController();
    const requestHttps = vi.fn();
    const fetchMetadata = createPreviewCimdTransport({
      requestHttps,
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
      resolveHostname: vi.fn(() => Promise.withResolvers<LookupAddress[]>().promise),
    });

    const rejection = expect(
      fetchMetadata("https://client.example.com/metadata.json", {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();

    await rejection;
    expect(requestHttps).not.toHaveBeenCalled();
  });

  it.each(["http://client.example.com/metadata.json", "POST"])(
    "rejects unsupported transport input %s",
    async (input) => {
      const requestHttps = vi.fn();
      const fetchMetadata = createPreviewCimdTransport({
        requestHttps,
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        resolveHostname: vi.fn(async () => publicAddresses),
      });
      const request =
        input === "POST"
          ? new Request("https://client.example.com/metadata.json", {
              method: input,
            })
          : input;

      await expect(fetchMetadata(request)).rejects.toThrow();
      expect(requestHttps).not.toHaveBeenCalled();
    },
  );

  it("returns redirects without following them", async () => {
    const fixture = requestFixture({
      lookupOptions: { all: true },
      responseStatus: 302,
    });
    const fetchMetadata = createPreviewCimdTransport({
      requestHttps: fixture.requestHttps,
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      resolveHostname: vi.fn(async () => publicAddresses),
    });

    const response = await fetchMetadata("https://client.example.com/metadata.json");

    expect(response.status).toBe(302);
    expect(fixture.requestHttps).toHaveBeenCalledOnce();
  });
});
