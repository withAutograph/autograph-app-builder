# Local development lifecycle

`mise run dev` is the fast, live-code loop: edit the checkout and use Next HMR and live Arrusted inputs. Eve retains the worker that owns existing sessions. Do not rebuild artifacts, reinstall the plugin, run broad suites, publish, or deploy after each edit.

This is the default development loop for Builder itself, not only generated app
work. Implement and verify shared workflow repairs locally before requesting a
reviewed release. A pull request, shared Preview/Production deployment, plugin
publication, or hosted acceptance run is not a prerequisite for an ordinary edit
or debugging iteration. Local operation does not authorize outward provider
mutations; provider resources and release effects retain their concrete approvals.

## Run and use the local Builder

1. Open the Builder checkout/worktree you are developing. Use its installed
   dependencies and repository tools, an absolute path to the selected Arrusted
   checkout, and the existing project-scoped Vercel OIDC setup. The launcher
   checks/refreshes that OIDC setup; do not supply static provider keys. Missing
   dependencies or credentials are concrete setup work, not a reason to deploy
   Builder to debug it. If another local Builder is running, select an isolated
   supported client profile **before launch** as described below.
2. From the Builder checkout, run this command, substituting the Arrusted path
   and unused ports and private directories for your instance:

   ```sh
   mise run dev -- --arrusted-root /absolute/path/to/arrusted --next-port 3100 --eve-port 2100 --state-root /private/tmp/builder-local-state --destination-root /private/tmp/builder-local-apps
   ```

   Leave this terminal running. Wait for the ready message and the printed
   loopback endpoint. By default this is the HTTP MCP development loop, for
   example `http://127.0.0.1:3100/mcp`; it is not the synthetic authenticated web
   product. Unless `--install-plugin false` is passed, the launcher installs `app-builder@autograph-dev` in the
   active client profile, disabled globally and enabled by the repository's
   `.codex/config.toml`.
   If Turbopack reports a resolver failure on linked dependencies, rerun the
   same command with `--next-bundler webpack`; this is the supported development
   fallback and does not require a package rebuild or hosted deployment.

3. Open a fresh Codex task in this Builder checkout and select **Autograph App
   Builder (Development)**. A supported explicit MCP client may instead connect
   to the printed `/mcp` endpoint. Before submitting a brief, verify the selected
   server uses this instance's loopback host/port, not the hosted Builder URL or
   another worktree's endpoint. For an explicit endpoint client, pass `--install-plugin false` so the launcher
   leaves existing profile registrations alone. Otherwise use profile isolation below.
4. Submit an ordinary product brief. Use the same public Builder interaction as
   a user: answer product questions and concrete approval requests, inspect the
   preview, and retain the returned session ID and cursor. With an explicit MCP
   client, start with `autograph_start`, read with `autograph_get`, answer the
   complete current input batch with `autograph_respond`, and send ordinary
   follow-ups with `autograph_send` only when waiting without unresolved input.
   Do not force internal stages or finish the generated app manually.
5. Edit local Builder or Arrusted source and keep Next.js HMR running. Active
   and waiting Eve sessions retain their pinned worker across runtime edits.
   To exercise changed agent/runtime code, launch a separate isolated instance,
   or explicitly end the original instance's runs before stopping/restarting it;
   do not open a PR, deploy Preview/Production, or reinstall the plugin for each
   iteration. Run focused checks for concrete repairs and one final local
   walkthrough when ready. A reviewed shared release and hosted acceptance come
   afterward. Stop the launcher with Ctrl+C when finished; retain saved session
   identities and state for supported recovery rather than silently replacing
   an interrupted session.

For the full local web UI with synthetic sign-in and provider emulators, append
`--emulated-web true`. That mode uses `https://localhost:<next-port>` for the UI
and `/mcp`, requires Docker and existing trusted localhost certificates/CA, and
has separate database/emulator ports. Follow
[synthetic web setup](#synthetic-web-authentication-and-provider-connections).
Do not treat the default HTTP MCP endpoint as an authenticated web acceptance
run or disable TLS verification to make the HTTPS mode work.

Local startup cannot publish, deploy, or mutate live providers. Keep hosted
sessions and their journals separate: never transplant their checkpoints or
approvals into local state, replay an uncertain request, or claim a local test
continued the saved hosted creation journey. See
[interrupted public sessions](#interrupted-public-sessions) for recovery limits.

## Parallel branch instances

Use a separate checkout/worktree for each branch instance. Give each instance its
own Next and Eve ports, owner-only state root and generated destination root.
Its checkout also owns its build outputs (including `.next`); do not share build
output directories or writable runtime state between instances. Read-only package
caches may be reused under the ordinary dependency lifecycle.

For explicit MCP clients, pass `--install-plugin false` in both instances and
connect each client to its own printed endpoint. This avoids modifying the
shared active plugin profile. If using plugin installation instead, select a
different supported isolated client profile for each launcher. Never replace
another task's active registration.

Then, in two different worktrees with their selected Arrusted checkout:

```sh
mise run dev -- --arrusted-root /absolute/path/to/arrusted-a --next-port 3100 --eve-port 2100 --state-root /private/tmp/builder-a-state --destination-root /private/tmp/builder-a-apps --install-plugin false
```

```sh
mise run dev -- --arrusted-root /absolute/path/to/arrusted-b --next-port 3200 --eve-port 2200 --state-root /private/tmp/builder-b-state --destination-root /private/tmp/builder-b-apps --install-plugin false
```

The paths and ports are examples. Check availability first; choose other unused
ports instead of killing another task's process. Keep each selected Arrusted
checkout isolated when its source is also being edited. For emulated web stacks,
also configure distinct `APP_BUILDER_DATABASE_PORT` and `EMULATE_BASE_PORT` values
and non-overlapping emulator port ranges through that instance's mise environment.
Separate Next/Eve ports alone do not isolate its database or emulators.

Connect the browser and public-tool client explicitly to the intended instance's
loopback origin and `/mcp` endpoint (HTTPS in emulated web mode). Confirm the
endpoint before starting or continuing a session. Development MCP identity and
version already distinguish ports; the launcher nevertheless installs the same
`app-builder@autograph-dev` plugin selector into the active client profile.
Concurrent launchers must not silently replace that shared registration. Use
supported isolated client profiles for installation, and bind each client to its
intended endpoint. Do not globally swap a running task's plugin registration to
point at another instance. A client connected directly to `/mcp` still requires
the launcher's installation to have used an isolated profile; it is not a
no-install launch option on current main.

For an explicit-endpoint client, add `--install-plugin false` to `mise run dev`.
The launcher still prepares the local package and checks MCP readiness, but it
does not execute Codex registration commands or read/write the client profile.
It prints the endpoint for the client to connect to explicitly. Omit the option
or use `--install-plugin true` for the existing profile installation behavior.

When qualifying parallel-instance support, run instances A and B from different
branches with clients bound to their explicit endpoints. Demonstrate that each
consumes its own branch's source and retains its own session state. Start,
cancel and restart A while B continues working, then verify B's endpoint,
source and saved session are unchanged. Record the actual outcomes; distinct
flags or this documentation alone do not establish that isolation was tested.

Local sessions and controlled product exercises are local evidence. Retain saved
hosted sessions and their operation journals unchanged; do not copy checkpoints,
approvals or request records into a local instance, replay uncertain requests,
or claim a local run continued a hosted session. A transfer requires a supported,
independently verified recovery/handoff flow. A local repair can later be released
and exercised against the original hosted session through its normal public
interface, with original request IDs and uncertain states preserved.

Next uses Turbopack by default. If its module resolver fails on the actual linked
dependency layout, use `mise run dev -- --arrusted-root /absolute/path/to/arrusted
--next-bundler webpack` to select Next's supported Webpack development bundler.
This keeps HMR and the same Eve, Sandbox, credential, and session boundaries;
it does not install packages or change the execution backend.

Eve reads the canonical `--arrusted-root` checkout directly. Ordinary Arrusted
source edits become the next planning input without cycling Eve or replacing
its local queue. Builder agent/runtime/skill edits produce a notification only:
the existing Eve instance stays pinned to its original runtime so active and
waiting sessions retain their worker. To exercise changed agent/runtime code,
launch a separate isolated branch instance and explicit client endpoint, or
explicitly stop and restart after choosing to end that instance's runs. Next HMR
continues independently. The watcher updates its observed baseline after each
edit; a notification or observation error is never a worker shutdown condition.
Snapshot identities remain diagnostics and do not gate live source reads or
dependency setup.

This retention prevents new source edits from killing local sessions; it does
not restore an already lost worker. Preserve such sessions and report recovery
unavailable unless a supported recovery is independently verified. Do not enable
an undocumented recovery flag, transplant hosted state, replay approvals, or
silently start a replacement session.

Vercel Sandbox is the execution backend. Use project-scoped OIDC, supported Sandbox source/file APIs, and structured commands. Do not add static keys, fallback runtimes, shell wrappers, or provider-internals checks. The checkout and generated files are writable.

Dependency setup is runtime work, not a source-integrity proof. Reuse caches when convenient; misses and stale entries rebuild normally. App or Arrusted edits do not require dependency rebuilding. New source snapshots are expected, not drift failures.

Only protect credentials and cross-user session data, obtain approval before outward effects, and report actual Sandbox/GitHub/Git/repository-command failures. There are no exact template, SHA/tree, package-layout, tool-version, manifest, path, receipt, digest, quota, or cache gates in local development. Inspection is best-effort and must not become a blocker.

## Checks follow functionality

Normal app changes are supported input, including new files, routes, metadata,
package names, schemas, and layouts. Builder consumes the repository's actual
command results instead of comparing them with fixture conventions. Missing or
stale caches trigger ordinary setup or recovery; optional inspection does not
decide whether work may proceed.

CI should verify executed commands and user behavior: task completion,
persistence, authentication, tenant isolation, approvals, cancellation, retries,
and recovery. Assertions should describe those outcomes. Source spelling, prose,
CSS selectors, complete metadata shapes, fixed archive sizes, and the last
internal mock call are not substitutes for them. Extra diagnostic fields or a
refactor must not break a test whose protected behavior still works. Exact
identity, cursor, or ordering assertions belong only to a real functional or
security contract.

Platform CI tests Builder and shared runtime behavior using controlled inputs.
Generated apps are custom, changing outputs, not platform test fixtures. Do not
copy a live app and assert that it has particular roles (or no roles), a fixed
schema, routes, release version, layout, or business workflow. Test how Builder
handles supplied metadata and commands independently of any actual app's current
contents. Product behavior assertions belong to tests authored for that app.

Lint must not reject ordinary changes for object-key order, equivalent object
construction, or a blanket preference for null over undefined. Missing and
undefined inputs have real semantics and need coverage. Keep checks that detect
invalid values, unsafe operations, type errors, or broken behavior; remove
style-only restrictions instead of rewriting a valid behavior test around them.

Do not respond to a brittle test by pinning the implementation or adding a new
gate. Remove its incidental expectation and retain the behavior check. If the
behavior fails, repair it. Keep authentication, credential protection, ownership,
effect approval, and persistence checks intact.

Skill-specific tools, production rigs, baseline tests, and per-route builds are
optional diagnostic methods. They do not block unrelated changes or require a
fresh install or tool upgrade. Use available supported tools, run focused checks
for concrete repairs, and report unverified behavior honestly. Public MCP
contract discovery and release evidence belong to their dedicated acceptance
work, not every startup or edit.

Use the integrated Browser for loopback prototypes, never an MCP App preview. Run one final local walkthrough when ready; let CI perform broad verification.

## Interrupted public sessions

The development adapter keeps its public request index and buffered progress
across Next module reloads within the same process. When the Eve child changes,
nonterminal sessions read their saved stream before continuing. An empty or
missing stream is a recovery blocker, not a usable waiting session; it never
replaces buffered progress or exposes old approval controls. Eve's explicit
`session_not_active` rejection also fences subsequent continuations. Public
reads report `session_recovery_unavailable` with the original session ID.

Eve's supported snapshot API reads history and does not prove a worker is
active. A retained nonempty stream can still be read, but continuation is only
confirmed when Eve accepts the same session ID. Development deliberately uses
`WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS=0` and has no documented API that reconstructs
an inactive local worker. Retain the original session ID, start request ID,
cursor and transcript for operator recovery or an explicit blocked outcome;
do not silently create a replacement public request. A fresh Node process also
loses the local in-memory original-request index. Hosted checkpoint recovery is
a separate durable path described in the [public MCP contract](public-mcp-contract.md).

## Persistent Sandbox reattachment

Streaming source archives use bounded chunk uploads through the supported
Sandbox SDK. Builder assembles them with a structured Node command and
atomically replaces the target only after all bytes arrive; cancellation or
transfer failure leaves an existing target intact and attempts cleanup of the
owned staging files. This avoids the SDK `fs.appendFile` helper, which rereads and uploads the
entire growing file for each incoming stream chunk. The transfer holds the
normal active-command lease and keeps backpressure without limiting total
archive size. Source bytes and provider responses are not diagnostic logs.

The Eve 0.68 provider records the persistent Sandbox name as immutable session
state. Reopening that state uses `Sandbox.get({ name, resume: true })`; it does
not resolve a new Git source, upload new seeds, or repeat initialization.
Session stop and runtime shutdown stop compute while retaining provider state.
Explicit Sandbox deletion removes that state. A missing named Sandbox fails
reattachment rather than creating replacement compute.

New Builder sessions keep their repository, private worktrees, planning inputs,
and workspace dependency caches on a dedicated Vercel Drive mounted at
`/workspace`. Its binding is recorded with the server-owned Sandbox state and
reused across reattachment; startup does not depend on a public session ID that
has not been assigned yet. Legacy state without a Drive binding continues to
resume its existing Sandbox. Source acquisition stages and places the repository
inside the mounted workspace instead of renaming a checkout across filesystems.

Stop and runtime shutdown retain the Drive. Explicit owning-session deletion
removes workspace storage only after successful deletion of the current owned
Sandbox; a stale handle or uncertain provider outcome does not delete a Drive.
Never share writable workspace storage between unrelated sessions. Sandbox
snapshot restoration is not a rollback of a mounted Drive's contents.

If Sandbox deletion succeeds but Drive cleanup cannot finish, report incomplete
storage cleanup. The same live handle can retry it. After a complete process
restart, the missing Sandbox cannot be resumed through this adapter; its retained
Drive binding remains necessary for operator cleanup. Do not describe that case
as completed storage deletion or durable automatic cleanup recovery.

The persistent Sandbox still saves the surrounding runtime filesystem, including
state outside `/workspace`. Its base disk and temporary directories can fill
independently of the Drive. Keep existing cache reuse and safe unused-worktree
retirement; additional capacity does not replace lifecycle cleanup. Capacity and
maintenance results are advisory diagnostics, not admission thresholds or usage
quotas. See Vercel's [Drive lifecycle](https://vercel.com/docs/sandbox/concepts/drives)
and [current storage limits and billing](https://vercel.com/docs/sandbox/pricing).

Preview startup can resume a stopped VM through a new SDK handle. The owning
provider registration retains that current handle for file I/O, commands, and
cleanup, so stopping the session targets the resumed VM. An old registration
cannot replace, unregister, or stop a newer provider handle. Cleanup waits for
its owned in-flight resume before stopping that VM; the closing registration
rejects preview startup and further I/O.
An explicitly deleted handle can still remove its persistent Sandbox after
stop, provided a newer handle does not currently own the registration.

Focused adapter tests cover these transitions against the installed Eve 0.68
types, with the external Sandbox SDK boundary mocked. They establish the
Builder's request and cleanup behavior; they do not establish hosted filesystem
persistence or restoration after complete loss. External workspace recovery
remains the separate [draft preservation plan](plans/2026-09-29-sandbox-expiry-draft-preservation.md).

## Synthetic web authentication and provider connections

The default development command remains the fast HTTP MCP loop. For the normal
web product with synthetic authentication, add `--emulated-web true` to
`mise run dev -- --arrusted-root /absolute/arrusted --state-root /absolute/private/state`.
This reuses the existing emulated web acceptance preparation: local PostgreSQL
and migrations, GitHub/Vercel emulators, passkey onboarding and auth settings.
It preserves the local Eve adapter and project-scoped Sandbox OIDC. No live
provider connection or publication occurs during setup.

This mode uses `https://localhost:<next-port>` consistently for the web UI, MCP,
OAuth callbacks and passkeys. Docker and the repository's installed tools must
be available. Existing locally trusted TLS files are required: by default
`certificates/localhost.pem` and `certificates/localhost-key.pem`; override them
with `--web-certificate PATH` and `--web-key PATH`. Supply `--web-ca PATH` or reuse
`CAROOT`/the existing cached Next mkcert `-CAROOT`. This command never installs
system trust or disables TLS verification. Missing prerequisites report an
explicit setup error; the mode does not silently fall back to HTTP.

Runtime certificates, emulator configuration and persistent database files live
under the selected state root. When omitted in this mode, the state root defaults
to a stable private temporary directory outside the checkout. The development command stops its owned local
processes and any database it started, retaining data for the next invocation;
it does not stop a previously running database. The existing auth acceptance
lane keeps its original defaults and reset lifecycle. Configure its existing
local database/emulator port settings through mise when another local stack
already owns those ports. Separate clients must trust the supplied local CA;
browser trust alone does not establish Node/Codex client trust. Owned MCP
readiness verifies the explicit CA and never grants that CA to remote origins.

## Private compiled artifacts and validation logs

The default developer profile has no forwarded hosted principal or hosted
validation database. Its private capture uses the existing owner-only state
root supplied by the dev launcher. The runtime verifies the OS owner and
canonical 0700 directories; records use 0600 files and atomic publication.
Compiled releases remain bound to the actual approved Eve session, workspace,
app and proposal. Immutable completion records preserve selection order across
retries and concurrent publication. These private files stay outside the app
Sandbox and do not grant deployment or provider authority.

Normal local validation uses a real private file log store rather than requiring
`DATABASE_URL`. The existing streaming writer sanitizes output, saves acknowledged
chunks and publishes an integrity-checked manifest last. `get_validation_log`
reads those same owner/session-bound pages after compute cleanup. Interrupted
capture remains distinguishable from completed output. Hosted validation retains
its authenticated PostgreSQL store. Diagnostic simulated-target fixtures do not
publish app releases or stand in for hosted product qualification.
