import { connect } from "node:net";

import type { BrowserProvider, BrowserProviderOption, TestProject } from "vitest/node";

type BrowserNetworkStatus =
  | "connection_refused"
  | "connection_reset"
  | "timed_out"
  | "name_resolution_failed"
  | "address_unreachable"
  | "aborted"
  | "failed"
  | "unclassified";
type ApiListenerStatus = "listening" | "connection_refused" | "timed_out" | "probe_error";
type LoopbackHost = "127.0.0.1" | "localhost" | "::1";
interface ProbeSocket {
  destroy: () => void;
  once: {
    (event: "connect", listener: () => void): ProbeSocket;
    (event: "error", listener: (error: Error & { code?: string }) => void): ProbeSocket;
  };
}

interface ProbeTimerReference {
  handle: NodeJS.Timeout | null;
}

export interface BrowserFailureDiagnostic {
  apiListener: ApiListenerStatus;
  browserNetwork: BrowserNetworkStatus;
  event: "vitest_browser_loopback_request_failed";
  host: "ipv4_loopback" | "ipv6_loopback" | "localhost";
}

const defaultApiPort = 63_315;
const networkStatuses = new Map<string, BrowserNetworkStatus>([
  ["ERR_ABORTED", "aborted"],
  ["ERR_ADDRESS_UNREACHABLE", "address_unreachable"],
  ["ERR_CONNECTION_REFUSED", "connection_refused"],
  ["ERR_CONNECTION_RESET", "connection_reset"],
  ["ERR_FAILED", "failed"],
  ["ERR_NAME_NOT_RESOLVED", "name_resolution_failed"],
  ["ERR_TIMED_OUT", "timed_out"],
]);

export const classifyBrowserNetworkFailure = (
  errorText: string | null | undefined,
): BrowserNetworkStatus => {
  const code = /^net::(?<code>ERR_[A-Z0-9_]+)$/u.exec(errorText ?? "")?.groups?.code;
  if (code === undefined) {
    return "unclassified";
  }
  return networkStatuses.get(code) ?? "unclassified";
};

const loopbackHost = (hostname: string): LoopbackHost | undefined => {
  if (hostname === "127.0.0.1" || hostname === "localhost") {
    return hostname;
  }
  if (hostname === "::1" || hostname === "[::1]") {
    return "::1";
  }
  return undefined;
};

const loopbackLabel = (host: LoopbackHost): BrowserFailureDiagnostic["host"] => {
  if (host === "127.0.0.1") {
    return "ipv4_loopback";
  }
  if (host === "::1") {
    return "ipv6_loopback";
  }
  return "localhost";
};

export const probeVitestApiListener = async (
  host: LoopbackHost,
  port: number,
  createSocket: (options: { host: string; port: number }) => ProbeSocket = (options) =>
    connect(options),
): Promise<ApiListenerStatus> =>
  // oxlint-disable-next-line promise/avoid-new -- Node's socket API reports completion through events.
  await new Promise((resolve: (status: ApiListenerStatus) => void) => {
    let settled = false;
    const timeout: ProbeTimerReference = { handle: null };
    const socket = createSocket({ host, port });
    const finish = (status: ApiListenerStatus) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout.handle !== null) {
        clearTimeout(timeout.handle);
      }
      socket.destroy();
      resolve(status);
    };
    timeout.handle = setTimeout(() => {
      finish("timed_out");
    }, 500);
    timeout.handle.unref();
    socket.once("connect", () => {
      finish("listening");
    });
    socket.once("error", (error) => {
      finish(error.code === "ECONNREFUSED" ? "connection_refused" : "probe_error");
    });
  });

const matchingLoopbackTarget = (requestUrl: string, configuredPort: number) => {
  try {
    const url = new URL(requestUrl);
    const host = loopbackHost(url.hostname);
    const port = Number(url.port);
    return host && url.protocol === "http:" && port === configuredPort ? { host, port } : null;
  } catch {
    return null;
  }
};

const reportBrowserFailure = (diagnostic: BrowserFailureDiagnostic): void => {
  console.info(JSON.stringify(diagnostic));
};

const browserApiPort = (project: TestProject): number =>
  project.config.browser?.api?.port ?? defaultApiPort;

/** Instruments the provider after its existing page-open behavior completes. */
export const attachVitestBrowserFailureDiagnostics = (
  provider: BrowserProvider,
  configuredPort: number,
  hooks: {
    probe?: typeof probeVitestApiListener;
    report?: (diagnostic: BrowserFailureDiagnostic) => void;
  } = {},
): BrowserProvider => {
  const originalOpenPage = provider.openPage.bind(provider);
  const reported = new Set<string>();

  provider.openPage = async (sessionId, url, options) => {
    await originalOpenPage(sessionId, url, options);
    const commands = provider.getCommandsContext(sessionId);
    if (commands.page === undefined) {
      return;
    }
    // SAFETY: The caller uses the Playwright provider, whose command context page is a Playwright Page.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- provider contract establishes the Page type.
    const page = commands.page as BrowserProviderPage;
    page.on("requestfailed", async (request) => {
      const target = matchingLoopbackTarget(request.url(), configuredPort);
      if (target === null) {
        return;
      }
      const browserNetwork = classifyBrowserNetworkFailure(request.failure()?.errorText);
      const key = `${target.host}:${browserNetwork}`;
      if (reported.has(key)) {
        return;
      }
      reported.add(key);
      try {
        const apiListener = await (hooks.probe ?? probeVitestApiListener)(target.host, target.port);
        const diagnostic: BrowserFailureDiagnostic = {
          apiListener,
          browserNetwork,
          event: "vitest_browser_loopback_request_failed",
          host: loopbackLabel(target.host),
        };
        (hooks.report ?? reportBrowserFailure)(diagnostic);
      } catch {
        // Diagnostics must never change the browser test result.
      }
    });
  };
  return provider;
};

/** Adds failure-only, allowlisted diagnostics to the Vitest Playwright provider. */
export const withVitestBrowserFailureDiagnostics = (
  option: BrowserProviderOption,
  hooks: {
    probe?: typeof probeVitestApiListener;
    report?: (diagnostic: BrowserFailureDiagnostic) => void;
  } = {},
): BrowserProviderOption => {
  const originalFactory = option.providerFactory;
  return {
    ...option,
    providerFactory(project) {
      const provider = originalFactory(project);
      return attachVitestBrowserFailureDiagnostics(provider, browserApiPort(project), hooks);
    },
  };
};

interface BrowserProviderPage {
  on: (
    event: "requestfailed",
    listener: (request: {
      failure: () => { errorText?: string | null } | null;
      url: () => string;
    }) => void | Promise<void>,
  ) => void;
}
