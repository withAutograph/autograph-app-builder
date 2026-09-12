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
  )
    throw new Error("handoff-id-invalid");
  const setup =
    destination === "codex"
      ? `Use the official Autograph App Builder plugin to continue this app.

First check whether app-builder@autograph is installed and enabled and whether its autograph_start tool is callable. If callable, immediately use the start input below. Do not reinstall or upgrade a working plugin.

If the official plugin is missing, disabled, or outdated, you are authorized to install, enable, or update it automatically. Run the necessary commands yourself, subject to native client approval requirements:

${codexInstallCommand}

Verify that app-builder@autograph is enabled, then rediscover its tools and continue with autograph_start.

If the official plugin is installed and enabled but its tools remain unavailable, treat this as a connection or tool-loading problem, not proof that an update is needed. Use available supported reconnect or reload capabilities and retry discovery. Do not substitute the development plugin or another app builder, and do not edit a repository directly.

Do not ask the user to run installation or upgrade commands. If recovery requires a user-only action, explain the specific blocker and request only that minimal action. Never claim the handoff has started until autograph_start succeeds.`
      : `Use the Autograph MCP connection in Cursor. If it is unavailable, return to the prepared app's web handoff page and use “Add Autograph to Cursor”, then enable the connection and resend this prompt.`;
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
  if (!ready) return;
  const url = new URL(mcpUrl);
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
    url.pathname !== "/mcp" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("mcp-url-invalid");
  const config = JSON.stringify({
    url: url.href,
    auth: { CLIENT_ID: "autograph-cursor-desktop" },
  });
  const encoded = btoa(
    Array.from(new TextEncoder().encode(config), (byte) => String.fromCodePoint(byte)).join(""),
  );
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=Autograph&config=${encodeURIComponent(encoded)}`;
}
