import { App } from "@modelcontextprotocol/ext-apps";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import packageManifest from "../../../package.json";
import type { EveSessionResult } from "../contracts";
import { createBoundedAuthorizationRefresh } from "./automatic-refresh";
import { SessionAppView } from "./view";
import type { SessionResponse } from "./view";

const app = new App(
  { name: "Autograph App Builder", version: packageManifest.version },
  {},
  { autoResize: true, strict: true },
);
let latestResult: EveSessionResult | undefined;
const resultListeners = new Set<() => void>();

function publishResult(result?: EveSessionResult) {
  latestResult = result;
  for (const listener of resultListeners) listener();
}

app.ontoolresult = ({ structuredContent }) => {
  publishResult(structuredContent as EveSessionResult | undefined);
};

function SessionAppContainer() {
  const result = useSyncExternalStore(
    (listener) => {
      resultListeners.add(listener);
      return () => resultListeners.delete(listener);
    },
    () => latestResult,
    () => latestResult,
  );
  const capabilities = app.getHostCapabilities();
  const automaticRefresh = useRef(createBoundedAuthorizationRefresh());
  const authorizationRequestKey =
    result?.inputRequests
      ?.filter((request) => request.kind === "authorization")
      .map((request) => request.requestId)
      .toSorted()
      .join(":") ?? "";

  const refresh = useCallback(async () => {
    if (!result || !capabilities?.serverTools) return;
    const response = await app.callServerTool({
      name: "autograph_get",
      arguments: {
        sessionId: result.sessionId,
        cursor: result.cursor,
        limit: 100,
      },
    });
    if (response.structuredContent) publishResult(response.structuredContent as EveSessionResult);
  }, [capabilities?.serverTools, result]);

  useEffect(() => {
    automaticRefresh.current.reset(authorizationRequestKey);
  }, [authorizationRequestKey]);

  useEffect(() => {
    if (!authorizationRequestKey || !capabilities?.serverTools) return;
    const checkAfterReturn = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (!automaticRefresh.current.claim(authorizationRequestKey, now)) return;
      // Refresh is deliberately fire-and-forget from the focus handler.
      // oxlint-disable-next-line promise/prefer-await-to-then
      void refresh().catch(() => undefined);
    };
    window.addEventListener("focus", checkAfterReturn);
    document.addEventListener("visibilitychange", checkAfterReturn);
    return () => {
      window.removeEventListener("focus", checkAfterReturn);
      document.removeEventListener("visibilitychange", checkAfterReturn);
    };
  }, [authorizationRequestKey, capabilities?.serverTools, refresh]);

  async function respond(responses: SessionResponse[]) {
    if (!result || !capabilities?.serverTools) return;
    const response = await app.callServerTool({
      name: "autograph_respond",
      arguments: {
        sessionId: result.sessionId,
        responses,
        clientRequestId: crypto.randomUUID(),
      },
    });
    if (response.isError) throw new Error("response rejected");
    if (response.structuredContent) publishResult(response.structuredContent as EveSessionResult);
  }

  return (
    <SessionAppView
      result={result}
      canCallTools={Boolean(capabilities?.serverTools)}
      canOpenLinks={Boolean(capabilities?.openLinks)}
      onOpenLink={async (url) => {
        await app.openLink({ url });
      }}
      onRefresh={refresh}
      onRespond={respond}
    />
  );
}

const root = document.querySelector("#root");
if (!root) throw new Error("Missing MCP App root.");
createRoot(root).render(<SessionAppContainer />);
void app.connect();
