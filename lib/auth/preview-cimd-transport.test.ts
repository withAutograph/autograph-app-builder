import type { LookupAddress, LookupOptions } from "node:dns";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  createPinnedPreviewLookup,
  createPreviewCimdTransport,
} from "./preview-cimd-transport";

const publicAddresses: LookupAddress[] = [
  { address: "93.184.216.34", family: 4 },
  { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
];

function runLookup(options: LookupOptions) {
  return new Promise<{
    address: string | LookupAddress[];
    family?: number;
  }>((resolve, reject) => {
    createPinnedPreviewLookup(publicAddresses)(
      "client.example.com",
      options,
      (error, address, family) => {
        if (error) reject(error);
        else resolve({ address, family });
      },
    );
  });
}

function requestFixture(input: {
  lookupOptions: LookupOptions;
  responseStatus?: number;
}) {
  const observed: { options?: RequestOptions; url?: URL } = {};
  const requestHttps = vi.fn(
    (
      url: URL,
      options: RequestOptions,
      responseListener: (response: IncomingMessage) => void,
    ) => {
      observed.url = url;
      observed.options = options;
      const request = new EventEmitter() as ClientRequest;
      request.end = () => {
        options.lookup!(url.hostname, input.lookupOptions, (error, address) => {
          if (error) {
            request.emit("error", error);
            return;
          }
          if (input.lookupOptions.all) {
            expect(address).toEqual(publicAddresses);
          } else {
            expect(address).toBe(publicAddresses[0].address);
          }
          const response = Readable.from([
            Buffer.from("metadata-body"),
          ]) as IncomingMessage;
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
      const resolveHostname = vi.fn(async () => publicAddresses);
      const fixture = requestFixture({ lookupOptions });
      const fetchMetadata = createPreviewCimdTransport({
        resolveHostname,
        requestHttps: fixture.requestHttps,
      });

      const response = await fetchMetadata(
        "https://client.example.com:8443/metadata.json",
        { method: "GET" },
      );

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
      resolveHostname: vi.fn(async () => [
        publicAddresses[0],
        { address: "169.254.169.254", family: 4 },
      ]),
      requestHttps,
    });

    await expect(
      fetchMetadata("https://client.example.com/metadata.json"),
    ).rejects.toThrow("public-routable");
    expect(requestHttps).not.toHaveBeenCalled();
  });

  it("applies the internal timeout while DNS resolution is pending", async () => {
    const timeout = new AbortController();
    const timeoutSignal = vi.fn(() => timeout.signal);
    const requestHttps = vi.fn();
    const fetchMetadata = createPreviewCimdTransport({
      resolveHostname: vi.fn(
        () => new Promise<LookupAddress[]>(() => undefined),
      ),
      requestHttps,
      timeoutSignal,
    });

    const rejection = expect(
      fetchMetadata("https://client.example.com/metadata.json"),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    timeout.abort(new DOMException("Timed out.", "TimeoutError"));

    await rejection;
    expect(timeoutSignal).toHaveBeenCalledWith(5_000);
    expect(requestHttps).not.toHaveBeenCalled();
  });

  it("honors caller abort while DNS resolution is pending", async () => {
    const controller = new AbortController();
    const requestHttps = vi.fn();
    const fetchMetadata = createPreviewCimdTransport({
      resolveHostname: vi.fn(
        () => new Promise<LookupAddress[]>(() => undefined),
      ),
      requestHttps,
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
        resolveHostname: vi.fn(async () => publicAddresses),
        requestHttps,
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
      resolveHostname: vi.fn(async () => publicAddresses),
      requestHttps: fixture.requestHttps,
    });

    const response = await fetchMetadata(
      "https://client.example.com/metadata.json",
    );

    expect(response.status).toBe(302);
    expect(fixture.requestHttps).toHaveBeenCalledOnce();
  });
});
