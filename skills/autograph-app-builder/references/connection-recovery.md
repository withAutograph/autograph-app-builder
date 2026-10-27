# Recover the App Builder connection

Use this when public tools are absent or a call reports a transport or OAuth
failure. Connection repair is part of the requested app work; do not send the
user away with a generic instruction to reinstall or reconnect.

## Preserve the work

Retain the user's goal, exact `sessionId` and lineage, largest cursor for that
session, pending input request IDs, and any unresolved call's `clientRequestId`
and original arguments. Keep earlier transcripts and completed evidence intact.
Connection repair does not create an app, change its resources, grant a new
provider scope, or replay an approval. Never read or copy stored tokens.

## Discover and verify

- Look for the public `autograph_*` tools, including host-prefixed names. Use
  the host's tool discovery when available before declaring a connection absent.
  A loaded skill does not prove its MCP tools are loaded.
- When `autograph_get` is callable, inspect the saved session with its saved
  cursor, or list sessions if none is established. This read-only call checks
  access without resuming stopped work or creating another build.
- A successful public response verifies access. A session-not-found, permission,
  busy or other application error is not proof of a broken connection; preserve
  it and follow the normal session workflow. Do not reconnect to bypass denial
  or change the selected account.
- An OAuth challenge or expired connection belongs to the host's authentication
  flow. Let the host refresh credentials or present its sign-in/consent UI.
  Retain the goal while the user completes that UI; do not ask for pasted tokens,
  callback URLs, passwords or a typed claim that authentication succeeded.

## Ask the host to repair it

Use an exposed host-native connect/reconnect or plugin-install action when it
exists. Discover the actual action and exact Autograph plugin identity first;
never invent a tool, plugin ID, management URL or slash command. If the plugin is
missing, use the host's verified Autograph listing and native installation
suggestion. Do not substitute another app builder if that listing is unavailable.

For local Codex, supported CLI management can help when no native action is
exposed. Check the installed CLI's help first. `codex mcp list` and
`codex plugin list --json` can identify the existing connection/plugin; keep
configuration and credential-bearing output private. If a separately registered
OAuth MCP server is identified, Codex may run
`codex mcp login <discovered-server-name>` to open its native authorization flow.
Do not assume a bundled plugin's display name is a CLI server name. Do not add a
duplicate MCP server or guess an endpoint to make login work.

Preserve the selected deployment, account and permissions. Do not uninstall,
log out, delete credentials, edit plugin caches, switch to localhost, or replace
marketplace configuration as an automatic repair. A failed marketplace lookup
is a distinct installation problem, not proof that the user's OAuth grant is
invalid. Report its concrete cause instead of repeating authentication.

After the host reports a successful repair, rediscover the tools and verify
with `autograph_get` against the same saved session/cursor. Continue from its
returned state. For an unresolved mutation, inspect/reconcile the original call
under the session semantics; never replay it with a new request ID.

If the host cannot repair or reload this connection in the current chat, explain
that specific limit and offer one next action, such as “Connect Autograph App
Builder to continue your saved app,” using the native control when available.
Do not say a reconnect succeeded until verified. If the host requires a fresh
chat, retain a concise continuation handoff with the goal, exact saved session,
cursor and unresolved request identities, without credentials. A fresh Codex
chat must continue the same Builder session; it is not a new app build. Do not
create another chat without the user's request.

Stop automatic recovery when the host requires user interaction, returns a
concrete failure, or the repaired connection still fails the read-only check.
Keep the work available to resume; do not loop reconnects or hide an outage.

## Supported host behavior

- [Codex MCP management](https://developers.openai.com/codex/mcp): explicit
  OAuth login for configured servers and plugin-provided MCP configuration.
- [Plugins in Codex](https://developers.openai.com/codex/plugins): installation
  and authentication are host-owned; newly installed tools can require a fresh
  chat. A skill cannot promise to hot-load tools into an existing chat.
- [MCP authentication](https://developers.openai.com/plugins/build/auth):
  protected-resource metadata, security schemes and authentication challenges
  let the host present its linking UI. User consent remains with the host.
