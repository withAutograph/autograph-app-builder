# Codex Deep-Link Handoff Findings

## Deep linking

Codex supports the `codex://` URL scheme on macOS.

The confirmed working format is:

```text
codex://new?prompt=<URL-encoded-prompt>
```

Example:

```text
codex://new?prompt=Create%20a%20harmless%20test%20app%20named%20Deep%20Link%20Probe.
```

This opens Codex, selects the current project/worktree, and pre-fills the
composer. The user must still review the task and click Send.

## Tested URL variants

- `codex://` launches or focuses Codex.
- `codex://open?...` was not confirmed for creating a task.
- `codex://new?...` opens a new task with the prompt pre-filled.
- `codex://task?...` opens the URL in Codex's browser pane instead of creating
  the desired task.

## Starting the chat automatically

There is no confirmed supported parameter for automatically submitting the
prompt. The handoff should stop at:

> Open Codex -> pre-fill the prompt -> user reviews -> user sends.

This lets the user verify the repository, worktree, model, permissions, and
requested action before execution.

## Plugin installation

Codex can be instructed to install a plugin, but installation cannot reliably
happen invisibly through the deep link.

A pre-filled task could say:

```text
If the Autograph App Builder plugin is not installed, install it first, then use it for this request.
```

Installation may still require:

- approval to run the install command;
- authentication or workspace authorization; and
- a reload or fresh task before the plugin becomes available.

There is no confirmed deep link that silently installs a plugin.

For Autograph, the fallback installation command is:

```bash
codex plugin add autograph-app-builder@autograph
```

OpenAI's plugin guidance also states that installation and any required
authorization must be completed before the plugin can be used.

## Recommended product flow

1. The user clicks **Create App**.
2. Autograph prepares the app brief and copies it as a fallback.
3. Autograph opens `codex://new?prompt=<URL-encoded-app-builder-prompt>`.
4. Codex opens a new task with the prompt pre-filled.
5. The user reviews and sends it.
6. If the plugin is missing, Codex is instructed to install it or the UI
   provides the installation command.
7. The user starts a fresh task if Codex requires a reload after installation.

## Current implementation status

The prototype includes an experiment panel that tests candidate URL forms with
a harmless prompt. The confirmed production candidate is
`codex://new?prompt=...`; the clipboard fallback should remain available, and
the UI should make clear that the user must send the task manually.

## Cursor handoff

Cursor has documented deep-link support for pre-filled prompts.

The prompt format is:

```text
cursor://anysphere.cursor-deeplink/prompt?text=<URL-encoded-prompt>
```

Example:

```text
cursor://anysphere.cursor-deeplink/prompt?text=Create%20a%20harmless%20test%20app%20named%20Deep%20Link%20Probe.
```

The link opens the prompt in Cursor chat. The user must still review and submit
it; Cursor deeplinks do not automatically execute prompts.

### Cursor MCP installation

Cursor also supports MCP installation deeplinks:

```text
cursor://anysphere.cursor-deeplink/mcp/install?name=<NAME>&config=<BASE64-ENCODED-CONFIG>
```

The `config` value is the base64-encoded JSON server configuration. Cursor
prompts the user to install the server and may require authentication or a
project-versus-user scope choice.

### Recommended Cursor flow

1. Offer an **Add Autograph to Cursor** link using the MCP installation format.
2. The user approves installation, authentication, and scope if requested.
3. Offer the prompt deeplink using
   `cursor://anysphere.cursor-deeplink/prompt?text=...`.
4. Cursor opens a chat with the Autograph request pre-filled.
5. The user reviews and submits the request.

Cursor also supports installing Agent Plugins and Cursor Plugins through its
Customize and marketplace surfaces. Installation and any required app
authorization remain user- or workspace-controlled.

### Cursor references

- [Cursor deeplinks](https://cursor.com/docs/reference/deeplinks)
- [Cursor MCP install links](https://cursor.com/docs/mcp/install-links)
- [Cursor plugins](https://cursor.com/docs/plugins)
