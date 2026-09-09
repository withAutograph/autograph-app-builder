/** Destination adapters only. Never put provider credentials or app content in a link. */
export type HandoffDestination = "codex" | "cursor";

export const codexInstallCommand = `codex plugin marketplace add withAutograph/marketplace --ref main
codex plugin marketplace upgrade autograph
codex plugin add app-builder@autograph`;

export function buildAppHandoffPrompt(
  handoffId: string,
  destination: HandoffDestination = "codex",
) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      handoffId,
    )
  )
    throw new Error("handoff-id-invalid");
  const setup =
    destination === "codex"
      ? `Use the Autograph App Builder plugin. If it is unavailable, install the official plugin first:\n\n${codexInstallCommand}\n\nEnable app-builder@autograph and connect it to Autograph. Open a fresh task if installation requires it, then resend this prompt.`
      : `Use the Autograph MCP connection in Cursor. If it is unavailable, return to the prepared app's web handoff page and use “Add Autograph to Cursor”, then enable the connection and resend this prompt.`;
  return `${setup}

Continue the prepared app by calling autograph_start with {"handoffId":"${handoffId}"}.

Use the same Autograph account as the web form. Reuse its saved GitHub and Vercel connections and selected resources through Autograph. Do not request provider tokens or separate provider logins. If access needs attention, use Autograph's recovery flow. If autograph_start is unavailable, explain the setup step and stop. This handoff does not approve building, publishing, or deploying; retain the normal approval flow.`;
}

export function buildAppHandoffUrl(
  destination: HandoffDestination,
  handoffId: string,
) {
  const prompt = encodeURIComponent(
    buildAppHandoffPrompt(handoffId, destination),
  );
  return destination === "codex"
    ? `codex://new?prompt=${prompt}`
    : `cursor://anysphere.cursor-deeplink/prompt?text=${prompt}`;
}

export function buildCursorInstallUrl(mcpUrl: string, ready: boolean) {
  if (!ready) return undefined;
  const url = new URL(mcpUrl);
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )) ||
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
    Array.from(new TextEncoder().encode(config), (byte) =>
      String.fromCharCode(byte),
    ).join(""),
  );
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=Autograph&config=${encodeURIComponent(encoded)}`;
}
