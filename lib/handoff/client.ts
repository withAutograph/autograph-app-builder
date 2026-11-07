/** Destination adapters only. Never put provider credentials or app content in a link. */
export type HandoffDestination = "codex" | "cursor";

export const codexInstallCommand = `codex plugin marketplace add withAutograph/marketplace --ref main
codex plugin marketplace upgrade autograph
codex plugin add app-builder@autograph`;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function buildAppHandoffPrompt(
  handoffId: string,
  destination: HandoffDestination = "codex",
) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(handoffId)
  ) {
    throw new Error("handoff-id-invalid");
  }
  const setup =
    destination === "codex"
      ? `Use the official Autograph App Builder plugin to continue this app.

First check whether app-builder@autograph is installed and enabled and whether its autograph_start tool is callable. If callable, immediately use the start input below. Do not reinstall or upgrade a working plugin.

If the official plugin is missing or outdated, install or update it automatically. Use supported Codex plugin controls or run the necessary commands yourself, subject to native client approval requirements. Add the marketplace only if missing, refresh it if an update is needed, and install the official plugin:

${codexInstallCommand}

Verify the effective plugin status in this workspace. If it is installed but disabled, use a supported Codex enable control if available. Otherwise tell the user to open Plugins in Codex, enable Autograph App Builder, and reopen this prepared app. If it still shows disabled in this workspace, explain that its workspace settings may override the user setting. Recheck tool availability before continuing.

If the official plugin is installed and enabled but its tools remain unavailable, treat this as a connection or tool-loading problem, not proof that an update is needed. Run codex mcp login app-builder yourself if the connection needs sign-in or its authorization status is unknown. Let Codex open the browser or share the authorization URL it prints. Ask the user only to complete the browser authorization using the same Autograph account as the web form. Keep the login command running until it reports success, then use supported reconnect or reload capabilities and rediscover the tools. If the current session cannot load newly authorized tools, ask the user to reopen this same prepared handoff after reloading Codex. Continue with the same start input below. Do not substitute the development plugin or another app builder, and do not edit a repository directly.

Try every applicable supported setup step yourself before handing anything back to the user. If a command is unavailable, try the equivalent supported Codex control. Do not ask the user to run installation or upgrade commands. If neither route can install the plugin, direct the user to Plugins in Codex to install Autograph App Builder from the Autograph marketplace. If a step requires the user, explain the specific blocker, give only the next action, and preserve this handoff for continuation. Never claim the handoff has started until autograph_start succeeds.`
      : `Use the Autograph MCP connection in Cursor. If autograph_start is available, continue immediately. Otherwise use supported Cursor controls to add or enable the Autograph connection, start sign-in if needed, and reload the tools. If a step requires the user, give only that next action. If you cannot add the connection, direct the user to “Add Autograph to Cursor” on the prepared app’s handoff page. If the connection is disabled, guide them to enable Autograph in Cursor’s MCP settings. If browser authorization is required, open it and let the user approve it with the same Autograph account. Resume this same prepared handoff after the tools load.`;
  return `${setup}

Continue the prepared app by calling autograph_start with {"handoffId":"${handoffId}","clientRequestId":"web-handoff:${handoffId}"}.

Use the same Autograph account as the web form. Reuse its saved GitHub and Vercel connections and selected resources through Autograph. Do not request provider tokens or separate provider logins. If access needs attention, use Autograph's recovery flow. If autograph_start remains unavailable after the destination-specific recovery above, explain the specific blocker and stop. This handoff does not approve building, publishing, or deploying; retain the normal approval flow.`;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function buildAppHandoffUrl(destination: HandoffDestination, handoffId: string) {
  const prompt = encodeURIComponent(buildAppHandoffPrompt(handoffId, destination));
  return destination === "codex"
    ? `codex://new?prompt=${prompt}`
    : `cursor://anysphere.cursor-deeplink/prompt?text=${prompt}`;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function buildCursorInstallUrl(mcpUrl: string, ready: boolean) {
  let result: string | undefined;
  if (ready) {
    const url = new URL(mcpUrl);
    if (
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
      url.pathname !== "/mcp"
    ) {
      throw new Error("mcp-url-invalid");
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("mcp-url-invalid");
    }
    const config = JSON.stringify({
      auth: { CLIENT_ID: "autograph-cursor-desktop" },
      url: url.href,
    });
    const encoded = btoa(
      Array.from(new TextEncoder().encode(config), (byte) => String.fromCodePoint(byte)).join(""),
    );
    result = `cursor://anysphere.cursor-deeplink/mcp/install?name=Autograph&config=${encodeURIComponent(encoded)}`;
  }
  return result;
}
