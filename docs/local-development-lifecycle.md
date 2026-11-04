# Local development lifecycle

`mise run dev` is the fast, live-code loop: edit the checkout, let Next HMR or the affected Eve/package process reload, and retry the behavior. Do not rebuild artifacts, reinstall the plugin, run broad suites, publish, or deploy after each edit.

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
   Builder to debug it. Use an explicit endpoint client with installation disabled,
   or select an isolated client profile before enabling installation.
2. From the Builder checkout, run this command, substituting the Arrusted path
   and unused ports and durable private directories for your instance. Important
   app and session work must survive a restart; use a persistent checkout and
   state outside operating-system temporary directories. On macOS, for example:

   ```sh
   builder_instance_root="$HOME/Library/Application Support/Autograph Builder/development/local"
   mkdir -p "$builder_instance_root"
   chmod 700 "$builder_instance_root"
   builder_instance_root="$(cd "$builder_instance_root" && pwd -P)"
   mise run dev -- --arrusted-root /absolute/path/to/durable/arrusted --next-port 3100 --eve-port 2100 --state-root "$builder_instance_root/state" --destination-root "$builder_instance_root/apps" --install-plugin false
   ```

   Leave this terminal running. Wait for the ready message and the printed
   loopback endpoint. By default this is the HTTP MCP development loop, for
   example `http://127.0.0.1:3100/mcp`; it is not the synthetic authenticated web
   product. The command above leaves plugin registrations unchanged. Omit
   `--install-plugin false` only when you want to install `app-builder@autograph-dev`
   in the selected client profile, disabled globally and enabled by this
   repository's `.codex/config.toml`.
   If Turbopack reports a resolver failure on linked dependencies, rerun the
   same command with `--next-bundler webpack`; this is the supported development
   fallback and does not require a package rebuild or hosted deployment.

3. Connect a supported explicit MCP client to the printed `/mcp` endpoint.
   If you enabled plugin installation, open a fresh Codex task in this checkout
   and select **Autograph App Builder (Development)** instead. Before submitting
   a brief, verify the selected server uses this instance's loopback host/port,
   not the hosted Builder URL or another worktree's endpoint. Connecting explicitly
   does not itself disable installation; use `--install-plugin false` to preserve
   the selected profile.
4. Submit an ordinary product brief. Use the same public Builder interaction as
   a user: answer product questions and concrete approval requests, inspect the
   preview, and retain the returned session ID and cursor. With an explicit MCP
   client, start with `autograph_start`, read with `autograph_get`, answer the
   complete current input batch with `autograph_respond`, and send ordinary
   follow-ups with `autograph_send` only when waiting without unresolved input.
   Do not force internal stages or finish the generated app manually.
5. Edit local Builder or Arrusted source, let HMR or the affected process reload,
   then retry the affected behavior. Restart only the process that needs it;
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

## Durable state and recovery

Use temporary directories only for explicitly disposable exercises. Do not put
an important checkout, saved app, generated destination, local session state or
its recovery evidence under `/tmp`, `/private/tmp` or another location that may
be cleared on restart or cleanup. A local Git commit in a discarded temporary
checkout is not a source backup. Preserve completed source changes through the
normal Git workflow without making publication a prerequisite for every edit.

The default non-emulated launcher state at `.artifacts/development` is durable
only when its checkout is durable and retained. An explicit durable
`--state-root` keeps instance state independent of checkout retirement. The
emulated web mode still has a temporary default; pass durable state and
destination paths explicitly for any work that matters. These storage choices
do not change the launcher's defaults or add a backup service.

Treat one instance's recovery material as a unit: its original state root,
native journals, original cycle and custody, retained source generation,
compiled-artifact/log records, and public request/session/cursor records. Keep
the selected Builder and Arrusted checkouts and generated destination with that
same instance. Do not combine a journal, cycle, source or public projection from
different instances or transfer an old approval to another target. Where the
current adapter holds the public request index only in memory, a filesystem copy
does not make that index durable; the limitations below still apply.

Before moving an existing instance, stop only that owned instance and preserve
its complete original state and destination. Use a genuine recoverable checkpoint
or backup and the recovery flow supported by the selected Builder version.
Resume with the original state root, destination and exact saved cycle; do not
start a replacement cycle and insert old records into it. Use `--resume-cycle` only in a qualified Builder version that actually
implements that option, with the original cycle path. Earlier versions may not
support it. Never infer recovery support from a folder name or from these storage
examples.

Keep owner-only access on state and backups. Do not commit private journals,
actor sessions or credentials to Git. Verify that a backup contains the actual
native journals and cycle custody before relying on it; a transcript, command
log, provider workspace or code archive alone cannot reconstruct them. A retained
Sandbox/Drive can preserve app files while local Builder authority is missing.
Report that distinction and retain uncertain operations; do not fabricate their
settlement or replay them. Confirm recovery through an accepted continuation of
the same session before calling it resumed.

## Parallel branch instances

Use a separate checkout/worktree for each branch instance. Give each instance its
own Next and Eve ports, durable owner-only state root and generated destination
root. Use distinct instance directories under persistent storage, including for
the worktrees themselves; different names under a temporary directory do not
make the work durable. Its checkout also owns its build outputs (including
`.next`); do not share build output directories or writable runtime state between instances. Read-only package
caches may be reused under the ordinary dependency lifecycle.

Use `--install-plugin false` for explicit endpoint clients so parallel launchers
cannot replace each other's shared plugin registration. If installation is wanted,
select a different supported isolated client profile for each launcher first.
Ports and filesystem paths alone do not isolate a shared client profile.

Install the repository-pinned dependencies once inside each Builder and Arrusted
checkout. Package-manager download caches may be reused, but do not link a
checkout's `node_modules` to a different checkout: development snapshots reject
source links that escape their own checkout, and another branch's install must
not rewrite this instance's dependencies. Restarts reuse that instance's install.

Then, in two different worktrees with their selected Arrusted checkout:

```sh
builder_a_root="$HOME/Library/Application Support/Autograph Builder/development/branch-a"
mkdir -p "$builder_a_root"
chmod 700 "$builder_a_root"
builder_a_root="$(cd "$builder_a_root" && pwd -P)"
mise run dev -- --arrusted-root /absolute/path/to/durable/arrusted-a --next-port 3100 --eve-port 2100 --state-root "$builder_a_root/state" --destination-root "$builder_a_root/apps" --install-plugin false
```

```sh
builder_b_root="$HOME/Library/Application Support/Autograph Builder/development/branch-b"
mkdir -p "$builder_b_root"
chmod 700 "$builder_b_root"
builder_b_root="$(cd "$builder_b_root" && pwd -P)"
mise run dev -- --arrusted-root /absolute/path/to/durable/arrusted-b --next-port 3200 --eve-port 2200 --state-root "$builder_b_root/state" --destination-root "$builder_b_root/apps" --install-plugin false
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
version distinguish ports. The commands above disable plugin installation and
bind each explicit client to its intended endpoint. If you enable installation,
use supported isolated profiles; never globally swap another running task's
registration to point at this instance.

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
its local queue. App Builder runtime edits and child lifecycle events retain
their existing restart behavior. Snapshot identities remain diagnostics and do
not gate live source reads or dependency setup.

Vercel Sandbox is the execution backend. Use project-scoped OIDC, supported Sandbox source/file APIs, and structured commands. Do not add static keys, fallback runtimes, shell wrappers, or provider-internals checks. The checkout and generated files are writable.

Dependency setup is runtime work, not a source-integrity proof. Reuse caches when convenient; misses and stale entries rebuild normally. App or Arrusted edits do not require dependency rebuilding. New source snapshots are expected, not drift failures.

Only protect credentials and cross-user session data, obtain approval before outward effects, and report actual Sandbox/GitHub/Git/repository-command failures. There are no exact template, SHA/tree, package-layout, tool-version, manifest, path, receipt, digest, quota, or cache gates in local development. Inspection is best-effort and must not become a blocker.

Acceptance task selection keeps the app identity from the accepted session or
explicitly selected existing repository app. For a prepared Preview, Builder
recovers its compatible owned checkout before reading the app contract. A missing
contract in a stale existing checkout must not prevent that recovery. Preparation,
browser testing and managed continuity planning use the same selection path;
recovery preserves private work and does not grant publication or execution
approval.

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

## Access to an existing hosted session

Use `mise run dev -- --arrusted-root /absolute/arrusted
--hosted-session-resource https://<original-builder-origin>/mcp` to expose existing
hosted sessions through a local native stdio connector. The ordinary local HTTP
`/mcp` and isolated local Eve store remain available. The installed development
connector is labelled Existing session when this mode is selected. If the
project-selected client does not support native MCP calls, select an existing
installed client with `--hosted-session-codex-bin /absolute/path/to/codex`. This
does not install or upgrade software.

This mode starts the official Codex app server and uses its direct
`mcpServer/tool/call` API against the original canonical HTTPS connection. It
starts no model turn or replacement Builder request, reads no credential files,
and creates no custom OAuth identity or cross-origin bearer relay. Normal
Codex authentication remains bound to the original resource. Only the five
public Builder tools are exposed; user, workspace and session authority and
existing effect approvals remain enforced by the hosted Builder. The native
client disables the Builder plugins in its own helper context to prevent recursion.

Transport attachment does not copy the hosted store or run local agent changes
against it. Hosted execution and local implementation evidence must remain
separate. Missing sign-in or unsupported native APIs return an actionable
connection error; never substitute another account/session, fabricate authority,
or loosen resource validation.

## Persistent Sandbox reattachment

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
to a stable private temporary directory outside the checkout. That default is
for disposable runs: its stable name does not guarantee survival across restart
or cleanup. Pass a durable private state root and destination for important
sessions. The development command stops its owned local processes and any
database it started, retaining data for the next invocation;
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

## Save a local app as portable source

Once the accepted app's apply or validation command has stopped, ask the same
Builder conversation to save its current app source. The internal
`export-application-source` tool captures the actual owning Sandbox workspace,
not the initial host checkout or an earlier compiled artifact. The five public
Builder lifecycle tools stay unchanged: use an ordinary `autograph_send` only
when that saved session is waiting without unresolved input.

The public session result exposes `applicationSource.downloadPath`. Open that
path on the same local Builder origin to download an attachment containing the
app-owned code, binary assets, executable-file modes and checked schema history.
The manifest reports omitted credentials, local runtime/session state,
dependencies/caches, symlinks and unsupported entries. A changing source or
cancelled owner produces no usable receipt. Inspect omissions before upload;
this is source transfer, not a database backup.

Downloads remain in the original owner-only local cycle state. They are served
as `application/octet-stream` attachments with `nosniff`, never inline HTML.
The download route is available only to the exact loopback development origin
and actual local cycle. This does not create an authenticated hosted principal.
A later authenticated Builder session receives these files as untrusted source;
its app registration, dependencies, identity, destination, resource setup,
approvals and publication remain ordinary fresh Builder work. No native journal,
provider installation, Auth session, data or old approval is transferred.

## Resumed local preview Auth origin

For a single-app local data runtime in a resumed private Sandbox, Builder reads
its exact private environment's previous Auth origin before accepting the new
provider-issued preview domain. The runtime reconciles that origin with an
explicit compare-and-swap and retains its owned cluster, credentials, identities,
and data. This handoff cannot rotate shared-context Auth or Production-bound
state. A stale checkpoint remains visible; retrying never resets it to localhost
or reprovisions resources to bypass the mismatch.

## Native checker prerequisites

A native validation-checker panic is a tooling prerequisite, not an app lint or
type failure. Builder retains the actual exit status and bounded sanitized log
references and stops automatic private-build continuation for that observation.
An exit code such as 134 without a positive panic diagnostic does not establish
a cause or prove an out-of-memory condition. Preserve the same app/session and
source; inspect the actual tooling/compute prerequisite and obtain the ordinary
fresh approval before changing a compute profile. A later ordinary user turn
may retry validation after that prerequisite is addressed. Existing failed
receipts are historical facts and are never rewritten to claim a later result.

For a qualifying native-checker failure, the read-only
`prepare_app_creation({privateCompute: "private-checks-16gib-v1"})` path can offer
the supported larger profile. It must resolve the current Sandbox/Drive,
maintained check task and linked-team capacity, then obtain a fresh Build card
for 8 vCPU/16 GiB and ephemeral billing before applying that same proposal.
Failure to qualify remains a visible prerequisite; it never authorizes a blind
retry, silent resize or replacement app.
