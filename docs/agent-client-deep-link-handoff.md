# Web-to-client handoff

The form prepares the selected resources, saves an owner-bound handoff, and
navigates to `/handoff/[id]`. Preparation does not launch a client or copy text.
The durable page loads from the authenticated server record, so reloading or
opening its URL in another tab preserves the app brief, repository, Vercel
project/team, connection choices, and provisioning outcomes.

## Continue in Codex or Cursor

1. Review the saved app and select a destination (the form's choice is the default).
2. If needed, expand **Set up Autograph** for that destination. Use the same
   Autograph account and browser profile that signed into the form.
3. Click **Open in Codex** or **Open in Cursor**. Review and send the prepared
   prompt in the native client.
4. The client invokes `autograph_start` with the opaque `handoffId`. Its
   Autograph connection authenticates the request and the server resolves the
   saved intent and existing provider connections.

A new client may ask the user to allow Autograph once. GitHub and Vercel
credentials stay server-side; provider CLI logins and separate provider plugins
are not part of this flow. Expired browser sessions, a different browser
profile/account, revoked credentials, and missing permissions can require
authentication again. Handoff does not grant build, publication, or deployment
approval.

The page shows **Launch requested** after invoking the custom protocol. A
browser cannot confirm that the app opened or the user submitted the prompt.
**Continued in your app** appears only when the owner-authorized status endpoint
reports a bound session. Status refresh runs while the page is visible, pauses
and cancels in-flight reads when hidden, and stops after confirmed continuation.
A status outage remains retryable and does not trigger a provider login.

The user can switch clients and reopen the same handoff. This retains the same
server reference; server-side start idempotency owns session reuse.

## Destination adapters

`lib/handoff/client.ts` generates distinct prompts and deep links. Prompts carry
the opaque handoff ID and destination-specific setup guidance; they do not
carry app content, provider credentials, resource receipts, or browser cookies.

Codex uses `codex://new?prompt=<URL-encoded-prompt>`. Its setup guidance retains
the official App Builder plugin:

```sh
codex plugin marketplace add withAutograph/marketplace --ref main
codex plugin marketplace upgrade autograph
codex plugin add app-builder@autograph
```

Cursor uses
`cursor://anysphere.cursor-deeplink/prompt?text=<URL-encoded-prompt>`.
Its prompt does not contain Codex installation commands. Cursor requires the
user to review and submit the prefilled prompt; automatic execution is not
requested. See [Cursor deeplinks](https://cursor.com/docs/reference/deeplinks).

**Add Autograph to Cursor** is rendered only when the server reports
`cursorInstallReady: true`. Its `mcp/install` deep link carries a Base64 JSON
configuration with exactly:

```json
{
  "url": "<canonical Autograph MCP URL>",
  "auth": { "CLIENT_ID": "autograph-cursor-desktop" }
}
```

This is a public OAuth client; there is no secret in the configuration.
Registration must be deployed before the server marks installation ready.
When it is not ready, an existing Cursor connection can still use the prompt;
the page offers Codex or returning later for fresh setup.
See [Cursor static OAuth configuration](https://cursor.com/docs/mcp).

## Recovery and API contract

- `GET /api/builder/handoffs/[id]` returns sanitized public page data with
  `version`, `handoffId`, `expiresAt`, `status` (`prepared`, `continued`,
  or `expired`), `intent`, `destination`, `cursorInstallReady`, and `mcpUrl`.
- The server page calls `getBuilderHandoffPageData({ environment, headers,
handoffId })`. No browser session redirects to sign-in with the handoff path
  preserved. Missing ownership or an unavailable record produces generic
  same-account guidance without owner details.
- Expired handoffs disable launch and offer **Renew handoff**. The control posts
  `{ creationRequestId: uuid }` to `/api/builder/handoffs/[id]/renew`, then
  immediately refreshes status when the returned `handoffId` is unchanged, or
  navigates when it differs. An expiry extension re-enables launch without a
  remount; a concurrent session binding shows server-confirmed continuation.
  Retries reuse the request ID, including
  after a reload when session storage is available. Renewal never calls resource
  provisioning or launches a client.
- Credential-unavailable and inactive-installation setup outcomes offer
  `/github/installations?returnTo=/handoff/<id>` or the equivalent Vercel route
  (URL encoded). Reconnection returns to the same saved handoff. Provider setup
  outcomes are historical; current credential/resource readbacks belong to the
  authenticated Autograph recovery flow.
- **Copy prompt** is separate from launch. Clipboard denial retains a selectable
  prompt for manual copy. A blocked or suppressed custom protocol remains
  retryable and never changes the server continuation status.
- A lost web login retains a sign-in link back to this handoff. Unauthorized
  status responses hide the prompt and disable client actions.

## Verification boundary

Focused UI tests cover destination payloads, explicit launch, visible-only
polling, confirmation from the server, blocked launch/copy, client-registration
readiness, lost renewal responses, access failures, and recovery links.
`e2e/builder/builder-handoff.spec.ts` exercises the durable page through the
emulated web flow, including reload, explicit launch/copy, and reset.

UI tests simulate the OS launch boundary. They do not prove native client
installation or provider credential reuse. Those claims require the real OAuth
and provider integration harness, followed by fresh-profile Codex and Cursor
acceptance on Preview with the observed client versions recorded.
