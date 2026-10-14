---
name: next-dev-loop
description: >
  Optionally inspect Next.js runtime behavior in a running app. Use the
  available framework and browser diagnostics that help verify the changed
  behavior; this workflow is not required for unrelated source edits.
---

# next-dev-loop

## project policy and scope

Use this workflow only as a task-relevant way to inspect Next.js behavior. The
repository's local-development and focused-validation policy takes precedence:
no source edit, route layout, framework version, cache state, receipt, or exact
tool shape is a gate for unrelated work. CI should verify task-relevant
functionality and security properties, not incidental source shapes. Keep
credential, tenant-isolation, and approval protections intact.

This is an optional diagnostic workflow for changes whose behavior benefits
from Next.js runtime introspection. Follow the repository's supported local
development and validation policy first. For an ordinary edit, keep working
with the running development app and the focused checks relevant to that edit;
missing optional tools or diagnostics do not block source work. Report what was
and was not verified.

You verify through two views of the same running app:

- **`/_next/mcp`** — an HTTP endpoint Next.js exposes about itself.
  Knows framework-specific things: routes, segments, RSC, server
  actions, server logs, and errors as Next.js saw them. Call
  `tools/list` for the current surface.
- **`agent-browser`** — a CLI that drives a real Chrome. Knows
  framework-agnostic browser things: DOM, console, network, React
  fiber, vitals. Before driving it, run `agent-browser skills get core`
  once for the version-matched usage guide — don't guess subcommands
  from memory.

The two views cross-check each other.

## optional diagnostics

- Next.js **16.3+** with **Turbopack** provides `/_next/mcp` plus the
  proactive compile check via `get_compilation_issues`.
- `agent-browser` **>= 0.31.1** provides React introspection, worktree-scoped
  `session id`, idempotent `--restore`, and launch flag reconciliation.

These versions describe the capabilities covered by this workflow, not gates
for ordinary edits. If a capability is unavailable, use a supported browser,
existing test, direct observation, or focused source check that can establish
the changed behavior. Identify the narrower evidence in your report; do not
upgrade frameworks or install tools solely to satisfy this optional workflow.

- If a requested Next.js feature itself requires an unavailable framework
  capability, explain that feature-specific limitation and ask before an
  upgrade that changes project dependencies. Do not upgrade to run this optional
  diagnostic workflow.
  Docs: https://nextjs.org/docs/app/getting-started/upgrading
  (version-16 guide:
  https://nextjs.org/docs/app/guides/upgrading/version-16)
- Use `agent-browser` when it is already available and useful. Do not install a
  global CLI for this workflow; the integrated Browser or the project's
  existing Playwright setup can provide browser evidence.

## preflight

When these diagnostics are useful and available, confirm the views you plan to
use. Skip unavailable optional probes and continue with the best focused check.

1. **Open `agent-browser` at the target URL, restoring saved
   login state when present.** First derive one stable session id for
   this checkout and use it for every `agent-browser` command:

   ```bash
   SESSION="$(agent-browser session id --scope worktree --prefix next-dev-loop)"
   export AGENT_BROWSER_SESSION="$SESSION"
   export AGENT_BROWSER_RESTORE="$SESSION"
   ```

   Then open the target URL:

   ```bash
   agent-browser --session "$SESSION" --restore --headed --enable react-devtools open <url>
   ```

   `--scope worktree` keeps parallel worktrees and copied checkouts
   from colliding. Bare `--restore` uses the session id as the
   persistence key, loads saved cookies/localStorage before navigation
   when present, and auto-saves state on close. Always pass the desired
   launch flags on `open`; agent-browser will reuse, relaunch, or restart
   its scoped background state as needed.

   The browser is the user's. If state was not restored (first run,
   expired session) and the page is gated, the user drives the login —
   pause until they confirm. After login, continue using the same session
   and restore context; `agent-browser close` saves the cookie state so
   the next `open` restores it.

2. Probe `/_next/mcp` (`tools/list`) — confirm it's reachable and
   lists `get_compilation_issues`. First read the port off the
   `next dev` banner; if it isn't 3000, set
   `NEXT_MCP_URL=http://localhost:<port>/_next/mcp` before probing:
   - Unreachable → either `next dev` isn't running, or Next.js is
     below 16.3. Check `package.json` if that distinction matters to the
     diagnostic; otherwise use the available browser or project check.
   - `get_compilation_issues` not in the list → Next.js below 16.3.
     The diagnostic is unavailable on this version; continue with other
     relevant verification.
3. `get_compilation_issues` doubles as a Turbopack probe. An error
   response of `"Turbopack project is not available..."` means the
   user is on webpack. Skip this Turbopack-only probe and use other available
   diagnostics.
4. `get_routes` → your route map for the rest of the session.

## loop

### before the edit — narrow the scope

Ask the running app, not the codebase. `/_next/mcp` knows which
files rendered the current route; use those as your search scope.
Runtime introspection stays cheap as the codebase grows; agentic
search doesn't.

### after the edit — verify

Four failure modes. Check each:

- **Compiles** — `get_compilation_issues`.
- **Runs without errors** — `/_next/mcp` (server and bubbled-up
  browser errors both surface here).
- **Behaves as intended** — `agent-browser` drives the page; assert
  what the user actually sees.
- **React-level behavior** — `agent-browser` with react-devtools
  enabled exposes the component tree, props, state, and render
  counts. Anchor framework-level checks here (extra renders,
  server/client boundary shifts, suspense fallbacks) — DOM asserts
  alone miss them.

Pick the specific tool from `tools/list` or the agent-browser
manual rather than from memory.

## gotchas

- **Preserve `.next` while the development server is running.** Moving or
  deleting it disconnects the server from its generated state and discards
  incremental caches. Moving it to a backup is still a reset. If a production
  build needs isolated output, configure a separate `distDir`.
- **Every `agent-browser` command must know your session and restore
  key, or it may use an empty default browser or fail to save login
  state.** Easiest: export both `AGENT_BROWSER_SESSION="$SESSION"` and
  `AGENT_BROWSER_RESTORE="$SESSION"` at the top of each shell you run
  agent-browser in. If you do not export them, pass
  `--session "$SESSION" --restore` on every command.
- **When the two views disagree, suspect the tooling first.** If
  `agent-browser` says a route is broken but `/_next/mcp` and the
  server say it rendered cleanly, a stale or misdirected browser
  session is the likelier cause than a real bug — reconcile the views
  before debugging the app.
- Confirming a click or navigation: the page settles a beat later, so
  wait with `wait --load networkidle` (no path to get wrong), then
  snapshot/read to confirm the page. Avoid `wait --url` unless you pass
  the link's exact href — a guessed or placeholder path won't match the
  real URL and times out after 25s.
- A blank read, empty snapshot, `about:blank`, or a "no browser
  session" error — right after `open` or after a click (even if `open`
  reported the page) — is the browser dropping the page (a stale
  session), not a broken route. Reopen your session at the URL with
  `--session "$SESSION" --restore` and re-snapshot; if still blank,
  run `agent-browser --session "$SESSION" --restore close`, then open
  again. Don't fall back to `curl`; it bypasses the browser you're
  testing.
- React introspection output is stale after navigation. Re-run.
- `/_next/mcp` replies are SSE — read the JSON off the `data:` line
  with `sed -n 's/^data: //p'` (a plain `sed 's/^data: //'` leaves the
  `event:` line and the parse fails).
- `get_errors` and `get_page_metadata` need at least one navigation
  to populate.

## reference

The following tools may be available in `/_next/mcp`; use only the diagnostics
that this app version exposes. A missing optional tool does not block the edit
or other verification.

```
# /_next/mcp                 notes
get_project_metadata         projectPath, devServerUrl, bundler
get_routes                   fs-scan; no browser session needed
get_errors                   runtime + build; needs a browser session;
                             includes browser-side errors caught by the
                             dev server
get_page_metadata            segment trie + routerType; needs a browser
                             session; use as a discovery shortcut for
                             which files power a route
get_logs                     returns logFilePath
get_server_action_by_id      hashed id → file + functionName
get_compilation_issues       Turbopack only; errors on webpack
                             ("Turbopack project is not available")
```

## teardown

Close the session with the same session and restore context:
`agent-browser --session "$SESSION" --restore close`. `close` saves
that session's cookies and storage so the next loop's `--restore` open
keeps the user logged in. Leave `next dev` up for the next loop.
