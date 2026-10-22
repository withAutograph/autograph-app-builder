import { connect } from "node:net";

type BrowserApiConfig = { host?: string | boolean; port?: number };
type BrowserProjectLike = { config: { browser: { api: BrowserApiConfig } } };
type BrowserRequest = {
  failure: () => { errorText?: string | null } | null;
  url: () => string;
};
type BrowserPage = {
  on: (event: "requestfailed", listener: (request: BrowserRequest) => void) => void;
};
type BrowserProviderLike = {
  getCommandsContext: (sessionId: string) => unknown;
  openPage: (sessionId: string, url: string, options: { parallel: boolean }) => Promise<void>;
};
type BrowserProviderOptionLike = {
  providerFactory: (...arguments_: never[]) => unknown;
};

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

export type BrowserFailureDiagnostic = {
  apiListener: ApiListenerStatus;
  browserNetwork: BrowserNetworkStatus;
  event: "vitest_browser_loopback_request_failed";
  host: "ipv4_loopback" | "ipv6_loopback" | "localhost";
};

const defaultApiPort = 63_315;
const networkStatuses: Record<string, BrowserNetworkStatus> = {
  ERR_ABORTED: "aborted",
  ERR_ADDRESS_UNREACHABLE: "address_unreachable",
  ERR_CONNECTION_REFUSED: "connection_refused",
  ERR_CONNECTION_RESET: "connection_reset",
  ERR_FAILED: "failed",
  ERR_NAME_NOT_RESOLVED: "name_resolution_failed",
  ERR_TIMED_OUT: "timed_out",
};

export const classifyBrowserNetworkFailure = (errorText: string | null | undefined) => {
  const code = /^net::(ERR_[A-Z0-9_]+)$/u.exec(errorText ?? "")?.[1];
  return code ? (networkStatuses[code] ?? "unclassified") : "unclassified";
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
  createSocket: typeof connect = connect,
): Promise<ApiListenerStatus> =>
  await new Promise((resolve: (status: ApiListenerStatus) => void) => {
    let settled = false;
    const socket = createSocket({ host, port });
    const timer = setTimeout(() => finish("timed_out"), 500);
    timer.unref();
    const finish = (status: ApiListenerStatus) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(status);
    };
    socket.once("connect", () => finish("listening"));
    socket.once("error", (error: Error & { code?: string }) => {
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

/** Adds failure-only, allowlisted diagnostics to the Vitest Playwright provider. */
export const withVitestBrowserFailureDiagnostics = <TOption extends BrowserProviderOptionLike>(
  option: TOption,
  hooks: {
    probe?: typeof probeVitestApiListener;
    report?: (diagnostic: BrowserFailureDiagnostic) => void;
  } = {},
): TOption => {
  const originalFactory = option.providerFactory as unknown as (
    project: BrowserProjectLike,
  ) => BrowserProviderLike;
  const providerFactory = ((project: Parameters<TOption["providerFactory"]>[0]) => {
    const provider = originalFactory(project as unknown as BrowserProjectLike);
    const originalOpenPage = provider.openPage.bind(provider);
    const browserProject = project as BrowserProjectLike;
    const configuredPort = browserProject.config.browser.api.port ?? defaultApiPort;
    const reported = new Set<string>();

    provider.openPage = (async (sessionId: string, url: string, options: { parallel: boolean }) => {
      await originalOpenPage(sessionId, url, options);
      const context = provider.getCommandsContext(sessionId) as { page?: BrowserPage };
      const page = context.page;
      if (!page) {
        return;
      }
      page.on("requestfailed", (request) => {
        const target = matchingLoopbackTarget(request.url(), configuredPort);
        if (!target) {
          return;
        }
        const browserNetwork = classifyBrowserNetworkFailure(request.failure()?.errorText);
        const key = `${target.host}:${browserNetwork}`;
        if (reported.has(key)) {
          return;
        }
        reported.add(key);
        const probe = hooks.probe ?? probeVitestApiListener;
        void probe(target.host, target.port)
          .then((apiListener) => {
            const diagnostic: BrowserFailureDiagnostic = {
              apiListener,
              browserNetwork,
              event: "vitest_browser_loopback_request_failed",
              host: loopbackLabel(target.host),
            };
            try {
              (hooks.report ?? ((entry) => console.info(JSON.stringify(entry))))(diagnostic);
            } catch {
              // Diagnostics must never change the browser test result.
            }
          })
          .catch(() => {
            // A failed diagnostic probe must not affect the browser test result.
          });
      });
    }) as BrowserProviderLike["openPage"];
    return provider;
  }) as TOption["providerFactory"];
  return { ...option, providerFactory } as TOption;
};
