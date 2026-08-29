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
