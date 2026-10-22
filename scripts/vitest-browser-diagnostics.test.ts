import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { connect } from "node:net";

import { describe, it } from "vitest";
import {
  classifyBrowserNetworkFailure,
  probeVitestApiListener,
  withVitestBrowserFailureDiagnostics,
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
    const connectSocket = (outcome: "connect" | "refused"): typeof connect =>
      ((options: { host: string; port: number }) => {
        assert.deepEqual(options, { host: "127.0.0.1", port: 63315 });
        const socket = Object.assign(new EventEmitter(), { destroy() {} });
        queueMicrotask(() => {
          if (outcome === "connect") {
            socket.emit("connect");
          } else {
            socket.emit(
              "error",
              Object.assign(new Error("private-sensitive"), { code: "ECONNREFUSED" }),
            );
          }
        });
        return socket as unknown as ReturnType<typeof connect>;
      }) as unknown as typeof connect;
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
    type FakeRequest = { failure: () => { errorText: string }; url: () => string };
    type FakePage = {
      listener?: (request: FakeRequest) => void;
      on: (_event: "requestfailed", listener: (request: FakeRequest) => void) => void;
    };
    const page: FakePage = {
      on(_event, listener) {
        this.listener = listener;
      },
    };
    let originalOpenCalls = 0;
    const option = {
      providerFactory: (_project: {
        config: { browser: { api: { host?: string | boolean; port?: number } } };
      }) => ({
        async openPage(_sessionId: string, _url: string, _options: { parallel: boolean }) {
          originalOpenCalls += 1;
        },
        getCommandsContext(_sessionId: string) {
          return { page };
        },
      }),
    };
    const reports: unknown[] = [];
    const probes: Array<[string, number]> = [];
    const instrumented = withVitestBrowserFailureDiagnostics(option, {
      async probe(host, port) {
        probes.push([host, port]);
        return "connection_refused";
      },
      report(diagnostic) {
        reports.push(diagnostic);
      },
    });
    const provider = instrumented.providerFactory({
      config: { browser: { api: { host: "127.0.0.1", port: 63_315 } } },
    });
    await provider.openPage("test-session", "http://127.0.0.1:63315/", { parallel: false });
    assert.equal(originalOpenCalls, 1);
    assert.ok(page.listener);
    page.listener({
      failure: () => ({ errorText: "net::ERR_CONNECTION_REFUSED" }),
      url: () => "http://127.0.0.1:63315/private/path?token=fixture-secret",
    });
    page.listener({
      failure: () => ({ errorText: "net::ERR_CONNECTION_RESET" }),
      url: () => "https://external.example/private/path?token=fixture-secret",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
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
