# Agent Client Deep-Link Handoff

## Production behavior

The app creation form has one required **Build with** destination. **ChatGPT /
Codex** is selected by default, **Cursor** is selectable, and **Web Chat** is
visible as a disabled **Coming soon** option.

When the user clicks **Create App**, Autograph builds one canonical prompt from
the app name, repository, selected model, provider and connection selections,
and app brief. It then:

1. copies that prompt to the clipboard as a fallback;
2. requests a launch of the selected client with the same prompt encoded in its
   deep link; and
3. continues to the Ready screen whether or not the browser permits the custom
   URL.

The Ready screen retains the copied brief, installation guidance, and a
destination-specific retry button. Deep links only prefill a composer; they do
not submit or execute the task.

## ChatGPT / Codex deep link

Codex supports the `codex://` URL scheme on macOS.

The production format is:

```text
codex://new?prompt=<URL-encoded-prompt>
```

This opens Codex, selects the current project/worktree, and pre-fills the
composer. The user must still review the task and click Send.

## Starting the chat automatically

There is no confirmed supported parameter for automatically submitting the
prompt. The handoff should stop at:

> Open Codex -> pre-fill the prompt -> user reviews -> user sends.

This lets the user verify the repository, worktree, model, permissions, and
requested action before execution.

## Plugin installation

Codex can be instructed to install a plugin, but installation cannot reliably
happen invisibly through the deep link.

A pre-filled task instructs the client:

```text
If the Autograph App Builder plugin is unavailable, stop and explain how to install it. Do not use another app builder or edit the target repository directly.
```

Installation may still require:

- approval to run the install command;
- authentication or workspace authorization; and
- a reload or fresh task before the plugin becomes available.

There is no confirmed deep link that silently installs a plugin.

For Autograph, the fallback installation command is:

```bash
npx plugins add withAutograph/autograph-app-builder
```

OpenAI's plugin guidance also states that installation and any required
authorization must be completed before the plugin can be used.

## ChatGPT / Codex flow

1. The user clicks **Create App**.
2. Autograph prepares the app brief and copies it as a fallback.
3. Autograph opens `codex://new?prompt=<URL-encoded-app-builder-prompt>`.
4. Codex opens a new task with the prompt pre-filled.
5. The user reviews and sends it.
6. If the plugin is missing, Codex is instructed to stop and explain how to
   install it; the UI also provides the installation command.
7. The user starts a fresh task if Codex requires a reload after installation.

## Cursor handoff

Cursor has documented deep-link support for pre-filled prompts.

The prompt format is:

```text
cursor://anysphere.cursor-deeplink/prompt?text=<URL-encoded-prompt>
```

The link opens the prompt in Cursor chat. The user must still review and submit
it; Cursor deeplinks do not automatically execute prompts.

### Cursor flow

1. The user selects **Cursor** under **Build with**.
2. **Create App** copies the canonical prompt and opens the prompt deeplink
   using
   `cursor://anysphere.cursor-deeplink/prompt?text=...`.
3. Cursor opens a chat with the Autograph request pre-filled.
4. The user reviews and submits the request.
5. If Autograph is unavailable, the user can separately approve MCP or plugin
   installation, authentication, and scope.

Installation and any required app authorization remain user- or
workspace-controlled.

## Failure handling

Browsers do not provide reliable confirmation that a custom-protocol handler
opened successfully. The Ready screen therefore treats the launch as a request,
keeps the retry action available, and tells the user that the prompt was copied.
If clipboard access is denied, the status explains how to retry after granting
access. Prompts whose encoded URL exceeds the conservative client-link limit are
not launched; the Ready screen instead directs the user to paste the copied
prompt manually.

### Cursor references

- [Cursor deeplinks](https://cursor.com/docs/reference/deeplinks)
