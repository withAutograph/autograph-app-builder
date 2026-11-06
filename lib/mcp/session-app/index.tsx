import { App } from "@modelcontextprotocol/ext-apps";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import packageManifest from "../../../package.json";
import { eveSessionResultSchema, retainPublicSessionCursor } from "../contracts";
import type { EveSessionResult } from "../contracts";
import {
  createBoundedAuthorizationRefresh,
  sessionAuthorizationRefreshKey,
} from "./automatic-refresh";
import { SessionAppView } from "./view";
import { reduceIdentityInvitations } from "./identity-invitation";
import type { IdentityInvitationState } from "./identity-invitation";
import type { SessionResponse } from "./view";

const app = new App(
  { name: "Autograph App Builder", version: packageManifest.version },
  {},
  { autoResize: true, strict: true },
);
let latestResult: EveSessionResult | undefined;
let identityInvitationState: IdentityInvitationState | undefined;
const resultListeners = new Set<() => void>();

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function publishResult(result?: EveSessionResult) {
  identityInvitationState = result
    ? reduceIdentityInvitations(identityInvitationState, result)
    : undefined;
  latestResult = result === undefined ? undefined : retainPublicSessionCursor(latestResult, result);
  for (const listener of resultListeners) {
    listener();
  }
}

app.addEventListener("toolresult", ({ structuredContent }) => {
  const parsedResult = eveSessionResultSchema.safeParse(structuredContent);
  publishResult(parsedResult.success ? parsedResult.data : undefined);
});

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function SessionAppContainer() {
  const result = useSyncExternalStore(
    (listener) => {
      resultListeners.add(listener);
      return () => {
        resultListeners.delete(listener);
      };
    },
    () => latestResult,
    () => latestResult,
  );
  const capabilities = app.getHostCapabilities();
  const automaticRefresh = useRef<ReturnType<typeof createBoundedAuthorizationRefresh> | null>(
    null,
  );
  const refreshController = (automaticRefresh.current ??= createBoundedAuthorizationRefresh());
  const authorizationRequestKey = sessionAuthorizationRefreshKey(
    result,
    identityInvitationState?.invitations ?? [],
  );

  const refresh = useCallback(async () => {
    if (!result || !capabilities?.serverTools) {
      return;
    }
    const response = await app.callServerTool({
      arguments: {
        cursor: result.cursor,
        limit: 100,
        sessionId: result.sessionId,
      },
      name: "autograph_get",
    });
    if (response.structuredContent) {
      const parsedResult = eveSessionResultSchema.safeParse(response.structuredContent);
      if (parsedResult.success) {
        publishResult(parsedResult.data);
      }
    }
  }, [capabilities?.serverTools, result]);

  useEffect(() => {
    refreshController.reset(authorizationRequestKey);
  }, [authorizationRequestKey, refreshController]);

  useEffect(() => {
    const checkAfterReturn = () => {
      if (
        !authorizationRequestKey ||
        !capabilities?.serverTools ||
        document.visibilityState === "hidden"
      ) {
        return;
      }
      const now = Date.now();
      if (!refreshController.claim(authorizationRequestKey, now)) {
        return;
      }
      // Refresh is deliberately fire-and-forget from the focus handler.
      void (async () => {
        try {
          await refresh();
        } catch (error) {
          void error;
        }
      })();
    };
    window.addEventListener("focus", checkAfterReturn);
    document.addEventListener("visibilitychange", checkAfterReturn);
    return () => {
      window.removeEventListener("focus", checkAfterReturn);
      document.removeEventListener("visibilitychange", checkAfterReturn);
    };
  }, [authorizationRequestKey, capabilities?.serverTools, refresh, refreshController]);

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  async function respond(responses: SessionResponse[]) {
    if (!result || !capabilities?.serverTools) {
      return;
    }
    const response = await app.callServerTool({
      arguments: {
        clientRequestId: crypto.randomUUID(),
        responses,
        sessionId: result.sessionId,
      },
      name: "autograph_respond",
    });
    const responseRejected = response.isError === true;
    if (responseRejected) {
      const publicResult = eveSessionResultSchema.safeParse(response.structuredContent);
      throw new Error(
        (publicResult.success ? publicResult.data.error?.message : undefined) ??
          "Builder could not submit this response. Check chat for the specific diagnostic before retrying.",
      );
    }
    if (response.structuredContent) {
      const parsedResult = eveSessionResultSchema.safeParse(response.structuredContent);
      if (parsedResult.success) {
        publishResult(parsedResult.data);
      }
    }
  }

  return (
    <SessionAppView
      result={result}
      identityInvitations={identityInvitationState?.invitations ?? []}
      canCallTools={Boolean(capabilities?.serverTools)}
      canOpenLinks={Boolean(capabilities?.openLinks)}
      onOpenLink={async (url) => {
        await app.openLink({ url });
      }}
      onRespond={respond}
    />
  );
}

const root = document.querySelector("#root");
if (!root) {
  throw new Error("Missing MCP App root.");
}
createRoot(root).render(<SessionAppContainer />);
void app.connect();
