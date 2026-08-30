import { App } from "@modelcontextprotocol/ext-apps";
import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import packageManifest from "../../../package.json";
import type { EveSessionResult } from "../contracts";
import { SessionAppView, type SessionResponse } from "./view";

const app = new App(
  { name: "Autograph App Builder", version: packageManifest.version },
  {},
  { autoResize: true, strict: true },
);
let latestResult: EveSessionResult | undefined;
const resultListeners = new Set<() => void>();

function publishResult(result?: EveSessionResult) {
  latestResult = result;
  resultListeners.forEach((listener) => listener());
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

  async function refresh() {
    if (!result || !capabilities?.serverTools) return;
    const response = await app.callServerTool({
      name: "autograph_get",
      arguments: {
        sessionId: result.sessionId,
        cursor: result.cursor,
        limit: 100,
      },
    });
    if (response.structuredContent)
      publishResult(response.structuredContent as EveSessionResult);
  }

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
    if (response.structuredContent)
      publishResult(response.structuredContent as EveSessionResult);
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

const root = document.getElementById("root");
if (!root) throw new Error("Missing MCP App root.");
createRoot(root).render(<SessionAppContainer />);
void app.connect();
