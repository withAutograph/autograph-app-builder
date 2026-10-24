import assert from "node:assert/strict";

import type { BrowserProvider } from "vitest/node";
import { describe, it } from "vitest";
import type { BrowserFailureDiagnostic } from "./vitest-browser-diagnostics";
import {
  attachVitestBrowserFailureDiagnostics,
  classifyBrowserNetworkFailure,
  probeVitestApiListener,
} from "./vitest-browser-diagnostics";

describe("Vitest browser failure diagnostics", () => {
  it("maps browser network errors to a closed category", () => {
    assert.equal(
      classifyBrowserNetworkFailure("net::ERR_CONNECTION_REFUSED"),
      "connection_refused",
    );
    assert.equal(classifyBrowserNetworkFailure("net::ERR_TIMED_OUT"), "timed_out");
    assert.equal(classifyBrowserNetworkFailure("private-sensitive-endpoint"), "unclassified");
  });

  it("classifies loopback listener outcomes using only fixed statuses", async () => {
    class FakeSocket {
      private connectListener: (() => void) | undefined;
      private errorListener: ((error: Error & { code?: string }) => void) | undefined;

      destroy(): void {
        this.connectListener = undefined;
        this.errorListener = undefined;
      }

      once(event: "connect", listener: () => void): this;
      once(event: "error", listener: (error: Error & { code?: string }) => void): this;
      once(
        event: "connect" | "error",
        listener: (() => void) | ((error: Error & { code?: string }) => void),
      ): this {
        if (event === "connect") {
          // SAFETY: The overload above pairs "connect" only with a zero-argument listener.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- overload correlation is not retained in the implementation signature.
          this.connectListener = listener as () => void;
        } else {
          this.errorListener = listener;
        }
        return this;
      }

      emitConnect(): void {
        this.connectListener?.();
      }

      emitRefused(): void {
        this.errorListener?.(
          Object.assign(new Error("private-sensitive"), { code: "ECONNREFUSED" }),
        );
      }
    }

    const connectSocket =
      (outcome: "connect" | "refused") => (options: { host: string; port: number }) => {
        assert.deepEqual(options, { host: "127.0.0.1", port: 63_315 });
        const socket = new FakeSocket();
        queueMicrotask(() => {
          if (outcome === "connect") {
            socket.emitConnect();
          } else {
            socket.emitRefused();
          }
        });
        return socket;
      };
    assert.equal(
      await probeVitestApiListener("127.0.0.1", 63_315, connectSocket("connect")),
      "listening",
    );
    assert.equal(
      await probeVitestApiListener("127.0.0.1", 63_315, connectSocket("refused")),
      "connection_refused",
    );
  });

  it("reports only allowlisted failures for the Vitest loopback API", async () => {
    interface FakeRequest {
      failure: () => { errorText: string };
      url: () => string;
    }
    interface FakePage {
      listener?: (request: FakeRequest) => void | Promise<void>;
      on: (
        _event: "requestfailed",
        listener: (request: FakeRequest) => void | Promise<void>,
      ) => void;
    }
    const page: FakePage = {
      on(_event, listener) {
        this.listener = listener;
      },
    };
    let originalOpenCalls = 0;
    const provider: BrowserProvider = {
      name: "playwright",
      supportsParallelism: false,
      openPage() {
        originalOpenCalls += 1;
        return Promise.resolve();
      },
      getCommandsContext() {
        return { page };
      },
      close() {
        return Promise.resolve();
      },
    };
    const reports: BrowserFailureDiagnostic[] = [];
    const probes: [string, number][] = [];
    const instrumented = attachVitestBrowserFailureDiagnostics(provider, 63_315, {
      probe(host, port) {
        probes.push([host, port]);
        return Promise.resolve("connection_refused");
      },
      report(diagnostic) {
        reports.push(diagnostic);
      },
    });
    await instrumented.openPage("test-session", "http://127.0.0.1:63315/", { parallel: false });
    assert.equal(originalOpenCalls, 1);
    assert.ok(page.listener);
    await page.listener({
      failure: () => ({ errorText: "net::ERR_CONNECTION_REFUSED" }),
      url: () => "http://127.0.0.1:63315/private/path?token=fixture-secret",
    });
    await page.listener({
      failure: () => ({ errorText: "net::ERR_CONNECTION_RESET" }),
      url: () => "https://external.example/private/path?token=fixture-secret",
    });
    assert.deepEqual(probes, [["127.0.0.1", 63_315]]);
    assert.deepEqual(reports, [
      {
        apiListener: "connection_refused",
        browserNetwork: "connection_refused",
        event: "vitest_browser_loopback_request_failed",
        host: "ipv4_loopback",
      },
    ]);
    assert.equal(JSON.stringify(reports).includes("fixture-secret"), false);
    assert.equal(JSON.stringify(reports).includes("private/path"), false);
  });
});
