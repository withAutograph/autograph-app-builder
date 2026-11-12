# Local development lifecycle

`mise run dev` is the fast, live-code loop: edit the checkout, let Next HMR or the affected Eve/package process reload, and retry the behavior. Do not rebuild artifacts, reinstall the plugin, run broad suites, publish, or deploy after each edit.

This is the default development loop for Builder itself, not only generated app
work. Implement and verify shared workflow repairs locally before requesting a
reviewed release. A pull request, shared Preview/Production deployment, plugin
publication, or hosted acceptance run is not a prerequisite for an ordinary edit
or debugging iteration. Local operation does not authorize outward provider
mutations; provider resources and release effects retain their concrete approvals.

## Repair and release loop

Reproduce concrete failures locally when feasible, through the real serialization
or command path and controlled test-owned fixtures. Make the smallest functional
repair and add focused regressions before deploying the shared Builder. Preserve
credential, tenant-isolation, approval and cancellation boundaries throughout.

Once related changes are integrated and ready, run applicable local validation
once. Reuse evidence for unchanged behavior; repeat checks for changed behavior,
a failure or an unresolved concern. Exact-head CI supplies broad deterministic
verification rather than repeating broad suites after each edit.

Use hosted runs to verify actual provider credentials and bindings, native
deployment, and authenticated acceptance. If a failure is hosted-only or a local
reproduction is impractical, state the evidence gap and use a targeted diagnostic
deployment to resolve it. This does not require exhaustive local proof before a
release or add a mandatory qualification gate to generated apps.

Eve derives and persists tool identifiers from `agent/tools/*.ts` filenames.
Keep existing kebab-case and snake_case tool names stable when updating source;
the lint configuration enforces those two conventions only in that directory.

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

A native checker panic records a tooling failure. Builder retains the actual
exit status and bounded sanitized log references. A historical lint checker
panic stays in the session history while Builder continues ordinary delivery
with the selected repository's native app build and declared tests. An exit
code such as 134 alone gives no cause for the failure. Use the actual diagnostic
to investigate a checker when the user requests it.

For an explicitly selected investigation of a qualifying checker failure, the read-only
`prepare_app_creation({privateCompute: "private-checks-16gib-v1"})` path can offer
the supported larger profile. It must resolve the current Sandbox/Drive,
maintained check task and linked-team capacity, then obtain a fresh Build card
for 8 vCPU/16 GiB and ephemeral billing before applying that same proposal.
Failure to qualify remains a visible prerequisite; it never authorizes a blind
retry, silent resize or replacement app.

Ordinary hosted app creation uses its standard workspace if the optional local
checker profile is requested by mistake. That request does not allocate compute
or block the Build card. A retained profile or an explicit same-app repair still
has to satisfy the existing profile requirements.

Both fresh and reused private-compute plans expose the canonical reviewed check
task as ready-to-submit `implementationFiles`, with its SHA-256 in separate
metadata. Builder can pass those exact bytes through the ordinary apply or
validation-repair input without guessing a replacement recipe. This read-only
projection must match the frozen profile's approved after-hash. It does not
change the profile or proposal, edit source, or authorize an effect; a new plan
still needs its ordinary Build approval.

The approved check-policy apply changes only the exact frozen task preimage (or
verifies its exact installed replacement). It retains executable mode `0755` and
reads back bytes and mode before acknowledging application. A missing task,
symlink, changed task, failed command, or invalid readback fails the apply; it
does not recreate an absent task or grant permission to edit a custom task.
Existing failed receipts remain historical facts. A normal newly approved apply
can consume the repaired implementation. Existing approved private builds can
use the ordinary explicit validation-repair input under their exact retained
app, proposal, session and workspace authority; a reused apply receipt alone
performs no recovery and proves no later filesystem state.

Local source planning distinguishes the historical source receipt from the full
captured working-tree baseline. Snapshot Git staging uses the exact already
captured source inventory, retaining originally tracked files even if the
snapshot's ignore rules would hide them. It does not recursively force-add
ignored dependency, credential, or runtime directories.

If the exact original baseline cannot be proven, Builder records a typed source
prerequisite bound to the current app, session, source, workspace, and proposal.
That observation stops automatic retries of an older app-validator failure.
Original validation and approval facts remain retained. Normal explicit user
turns can recover the immutable source and prepare a fresh plan. A successful
same-scope reconciliation records resolution; it does not transfer the old Build
approval to changed source.

Local source reconciliation must use the saved planning workspace's exact file
inventory digest as its original merge base. A Git commit alone omits initial
dirty or untracked source. If candidate Git metadata is absent, Builder may
recover a distinct original snapshot commit from its own private retained run
sources only when file bytes, modes and the complete inventory match that frozen
digest. Snapshot Git objects supply committed bytes; originally tracked paths
omitted when snapshot Git applied ignore rules may use their actual retained
source files. Those extra bytes are captured into a distinct private commit and
must pass the same complete frozen digest check. Current app files cannot
establish the old baseline. The historical source commit remains unchanged and is retained
separately from the recovered snapshot commit/tree. Installing that proven Git
metadata does not check out or replace candidate files. Missing or mismatched
original artifacts remain an explicit prerequisite; an old approval never
acquires a changed source or destination.

Before freezing a local workspace receipt, Builder now retains the exact selected
live source as an immutable private source baseline, including its raw byte
inventory and distinct snapshot commit/tree. This happens at preparation time;
the launcher's earlier copy is not assumed to contain later host edits. Baselines
live under the instance's `source-baselines/<original-source-sha>/<workspace-digest>/` namespace. They
are source artifacts only, never a restored native checkpoint or transferred
approval. Recovery requires the same historical source identity and exact frozen
workspace digest before the ordinary new-plan workflow can continue.

Transferred Sandbox file bytes are independently checked against the frozen
inventory before preparation writes the workspace receipt. A mixed or corrupt
transfer remains a visible failure. Historical regular-file digests cannot prove
dirty symlink targets; legacy symlink recovery fails closed. New preparation
artifacts separately retain their exact captured Git tree, and a conflicting tree
cannot replace an existing original-source/digest artifact.

Local Builder workflow qualification includes the installed Eve authored-channel
bundle and Workflow bundle build. Relative lazy imports can create unsupported
split authored modules even when TypeScript and focused unit tests pass. Shared
source custody uses a static, acyclic module graph; qualify that actual compiler
boundary before restarting a saved development cycle.

The same custody rule applies after each local source reconciliation, before its
new generation becomes a frozen planning baseline. Builder reuses the verified
capture rather than rereading the large source tree. Each artifact names that
new generation's actual source commit and inventory digest; future metadata
recovery uses that exact tuple, while earlier source receipts and approvals
remain historical facts.

Development transport receipts use the captured generation's eligibility identity
(`sha256(sourceSha)`), including receipts produced by reconciliation. The reviewed
SourceReceipt separately retains its canonical SHA/Git-tree identity. An already
frozen reconciliation that used that canonical identity remains readable only
when its exact current workspace, parsed SourceReceipt and completed private
Native call match the trusted reconciliation history. Reading it neither rewrites
the receipt nor carries an old Build approval into a new plan. Ordinary moving
host source is observed by the next planning reconciliation. Local schema
compilation and validation run against the selected applied workspace even if
separate host source has moved.
When planning observes unchanged source, it retains that workspace without
reading native transport history.
Private preview and browser tasks can run an existing app in the selected
GitHub checkout before a Build or an app-spec marker exists. The repository's
launch or test command reports actual runtime prerequisites. Hosted continuity planning also
uses the selected checkout and app with the operator's verified prepared runtime.
It does not require an app-spec marker in the checkout.

A later no-op preparation may return the same frozen receipt under a new Native
call ID. Compatibility still requires the original completed reconciliation call
and its identical receipt in the same complete owned history; the later no-op
does not create or replace that historical proof.

A historical `mise ERROR no task //apps/<selected-app>:check found` receipt
records that the old checker task could not run. Resume ordinary validation with
the current native app build and declared tests. For an explicitly selected
checker investigation, inspect the selected task's source and executable mode
before retrying that task. Use the normal Builder edit or planning path for a
source repair.

For an already approved private-check profile, ordinary
`validate_app_creation` repair may explicitly upsert that same app's reviewed
check task. The supplied content must match its frozen old or new recipe; Builder
rechecks the exact retained Build scope before writing and before reasserting the
policy, including executable mode. No-files validation, deletion, another path,
custom recipe, or changed app/proposal/workspace cannot trigger this repair. It
creates no approval and cannot resize compute or change provider resources.

A tooling failure in the current native build or test still needs diagnosis.
An explicit `validate_app_creation` retry runs current validation and records
its own result while preserving the earlier receipt.

Private browser tasks use the checked `app:describe` catalog entry independently
of the exact Auth origin. A restored private runtime projects that entry even
without a public-delivery binding; an explicit public-delivery entry retains its
meaning. Unknown entries remain a browser prerequisite. The repository's normal
`app:runtime run <app> test-e2e` path supplies the same catalog-derived
`APP_TEST_ENTRY_PATH` for local execution. Existing authored tests must opt into
`appTestPath()` and the normal actor fixture where their scenario requires them;
a supplied environment does not rewrite navigation or authenticate an anonymous
Playwright `page` fixture.

When an explicit reviewed check-task upsert has incorrect bytes, the normal
validation tool returns the exact installed canonical recipe and path as repair
guidance only after rechecking the retained app/spec/proposal/workspace/session
approval and the recipe's frozen after-hash. It writes no source and opens no
Sandbox for that response. Foreign scope or a mismatched installed policy cannot
obtain this guidance; the agent must submit the explicit normal repair again.

### Frozen private compute check integrity

A selected `private-checks-16gib-v1` plan binds its app-owned executable check recipe as well as the compute resources. Validation rejects an explicit deletion of that task before writing any implementation files. After an explicit repair and policy readback, and before technical setup or checks, Builder reads the actual `mise tasks info //apps/<app>:check --json` projection and independently checks the frozen task bytes and executable mode. A TOML override, changed task source or working directory, missing file, or changed recipe returns a tooling prerequisite requiring an explicit Builder repair. Unrelated app repairs remain available; plans without this profile do not use this guard. A changed check policy requires a new plan and ordinary fresh approval. Historical receipts are preserved.

This read-only prerequisite check does not run the app task or establish lint, type, test, browser, or hosted acceptance. Those observations remain separate.

## Observing Builder runtime edits

The local source observer must cover every shared Builder library and maintained
dependency patch, including provisioning, Auth, provider adapters and workflow
recovery. A source-change notice means the existing Eve worker is still pinned
to its loaded generation; it does not mean that new code is executing. Next's
page/component HMR remains independent.

To exercise changed Builder runtime code, use a separate branch/checkout, ports
and state root for parallel work, or deliberately stop an owned idle instance
and resume its exact saved cycle with the qualified checkout. Install changed
pinned dependencies before launching it. Verify the copied authored modules and
the installed dependency modules actually used by that cycle, then continue the
saved session through ordinary public controls. Never replace a running worker
mid-effect, copy another instance's journal, or repeat an uncertain operation.

### Resume the selected dependency installation with the saved cycle

A cycle retains native `.eve` sessions, queues and workflow data. Its application
code and dependency binding come from the deliberately selected Builder checkout.
When resuming a stopped cycle, Builder atomically rebinds only its owned
`node_modules` link to that checkout's canonical owner-bound installation. An
intentional owner-bound dependency cache at the selected checkout is supported;
it must not leave Eve resolving from an ancestor or a stale per-package link in
another checkout. Native session bytes and ownership do not change.

Before launch, the supervisor reports `[builder:development:dependencies]` with
the selected modules root, source/installed lock SHA256 values and actual resolved
Eve package path. A fresh metadata-only Node process verifies resolution from the
cycle and selected checkout, avoiding stale in-process symlink caches. This
prevents a new CLI and old authored-tool dependency tree from being mixed. It
does not claim that every previous harness invocation used the same tree.

If the actual installed pnpm lock differs from the selected lock, run
`pnpm install --frozen-lockfile` in that selected checkout, then resume the
stopped cycle normally. This is an actionable installation mismatch, not a
source/template/SHA drift gate; ordinary app and platform edits remain valid
planning input. The separate Arrusted dependency cache key does not certify the
Builder's installed runtime. Neither a copied source fingerprint nor a READY
message replaces actual dependency-resolution readback. Do not copy or rewrite
native state to repair a dependency installation.

### Amending a prepared, unapproved existing-app plan

An explicit app-file change may replace an existing-app plan before its Build
approval has executed. This is planning only: retain prior grants and terminal
decisions across later approval, and produce a proposal with current workspace
preimages. The new proposal requires its own ordinary Build approval. Do not manufacture a settled apply receipt or
borrow a different proposal's repair history.

The producer includes the unique planning call ID in every proposal digest.
Apply records that exact proposal's grant before any execution I/O, and cannot
approve another proposal while this exact planned workflow remains current.
Therefore this amendment is permitted only for a current planned iteration with
no matching repair-history entry, no pending approval in any scope, no grant
for the current proposal, and the same workflow, authority, and workspace
throughout planning. If a prepared repair's preimages changed, plan again
from the current checkout. A matching grant can represent an
unresolved execution and remains blocked; missing or conflicting required
state is not evidence of an unapplied plan. Existing settled repairs continue
to require their exact approved base and receipt binding. Compare the app and
selected workspace's source identity for that binding. Optional AppSpec
metadata, a relocated host source path, and workspace eligibility metadata do
not invalidate the retained approval scope by themselves.

### Inspect the current unapplied proposal

`inspect_existing_app` reads the applied Sandbox by default. When reviewing an
existing-app repair before its Build approval, explicitly select
`source: "current-proposal"`. The first read returns the proposal digest.
This reads only that session's current planned change
inventory, labels the result `UNAPPLIED`, verifies full proposal and file hashes,
and reports deletions explicitly. A path absent from that inventory is not read
from the Sandbox. It cannot recover an older proposal from history.

List without `paths`/`contentPath`; continue with `pathIndex`. Read app-relative
or exact app-owned repository paths. Large files return a full-file digest and
UTF-8 byte offset; use `contentPath`, `expectedDigest`, `offsetBytes`, and the same
`expectedProposalDigest` for every continuation. If the current proposal changes,
restart from its actual new digest. Reading grants no approval, executes no code,
and never applies, publishes, acquires or reconfigures a Sandbox.

### Accepted app drafting before Build approval

An accepted AppSpec remains unfinished work when the native agent completes after
only inspecting source. A separate **preapproval authoring** decision binds that
intent to its original logical session, accepted artifact revision, source receipt,
workspace and planning progress. It may queue a drafting turn through the existing
public session. It grants no Build, application write, publication or provider
permission. A proposal or pending input stops this continuation; normal fresh Build
approval remains mandatory.

The local owner files and hosted canonical store reserve the exact internal SEND
before dispatch. An uncertain acknowledgement is observed without resending.
Cancellation, failed or unfinished native calls, changed ownership or source, and
retained source prerequisites block dispatch. Authenticated internal markers do
not become product requirements; user-supplied lookalike text remains ordinary
input. Recovery preserves the accepted logical identity and rebinds only its
independently proven physical owner.

If that authenticated drafting turn completes with the same accepted/planning
state and still has no proposal, Builder reports
`preapproval_authoring_no_progress`. It leaves the app unfinished and waiting for
an ordinary user continuation instead of repeatedly queuing inspection-only turns.
Actual dependency or identity progress is distinct from this no-progress boundary.

### Repository inspection paths

`inspect_repository.path` retains explicit local repository-root inspection. The
virtual `/workspace/repository` root selects the current source overview; a
singular path below that virtual root inspects the selected Sandbox entry,
including immediate directory entries. Omitted mode never resolves that virtual
descendant on the Builder host. Explicit `mode: repository` retains allowed local
host-root inspection even when a physical host path resembles the virtual
namespace; explicit `mode: workspace` inspects the selected Sandbox entry (including
the root directory) and never falls back to the host. Repository mode cannot be
combined with workspace file paths or a directory continuation. Directory results return a `directoryOffset` continuation;
repeat the same path with that offset until continuation is absent. Entries are
paged to the native result envelope without a total directory-size limit.

Read source bytes with `paths`, using repository-relative file names or absolute
paths under `/workspace/repository`. Package exports determine actual `.js`,
`.d.ts`, or other file names; a missing guessed file does not mean its directory
or package is absent. Workspace entry inspection retains selected-baseline
archive filtering and rejects paths or symlinks escaping the selected root.

The approved checkout install preserves the source mode of existing workspace
bin targets. Bun can set an executable workspace file to `0777` when linking
it into `node_modules/.bin`. Before the apply snapshot, Builder restores the
original executable mode only when the repository-declared target still has
the same file identity and bytes. An existing bin must be an owned,
regular file in its package. Other changes to those preimages fail the
install boundary and remain visible for diagnosis.

A local public read of a recovered session checks the receipt-bound lineage and
reads its physical histories concurrently, then joins them in receipt order.
Each read still verifies the canonical history against retained events. When
neither local continuation decision is runnable, the public read skips the
additional dispatch preflight. A possible continuation still requires a fresh
native observation and the existing durable decision and reservation checks.
Each recovered message or input response resolves its physical response stream
once for that request. The logical control endpoint still checks the current
owner before dispatch.

Private browser results classify the legacy preview-refresh prerequisite only
from its exact standalone reporter line on a failed test command. Test titles
and bounded stage diagnostics do not set the prerequisite classification.

A completed local planning reconciliation supersedes earlier source transports
for that exact saved workspace and source. Builder uses the matching native
result in the owned history to order those receipts and verifies the current
workspace manifest before replacing source. Later completed transports still require their exact manifests. A missing or failed
reconciliation result cannot supersede a transport.

Local database and Auth preparation can retain a private remote Auth origin.
A browser test at that origin requires an active owner-bound working preview.
Without it, the browser tool returns the preview prerequisite before starting
Playwright. Ordinary local and prepared hosted browser tasks keep their
existing execution paths.

While a newer existing-app plan remains unapplied,
`start_app_preview` and `run_app_browser_tests` can select
`artifact: "prior-validated"` for the same private local session. The selection
requires the exact prior validated repair base, its prior approval and
no unresolved Build approval or apply for the newer draft. It uses
a fresh comparison of source paths and content against the retained apply
receipt. File permission changes do not affect this comparison. Start this
preview with the repository’s actual development command. Browser tests use a private preview started for that same apply
and validation receipt. Selecting it leaves the newer draft and both
receipts in place and grants no publication authority.

A prior validated preview reuses available checkout dependencies. Builder
restores missing dependencies from the frozen lockfile and checks the retained
source before launching the preview.

Builder's checkout dependency installation attempts to preserve the original
modes of workspace bin files when Bun widens them. Permission differences
alone do not change a successful installation result. Ordinary preview
reconciliation, frozen dependency restoration, validation recovery and the
UI preview renderer fallback use the same guard as apply. Dependency receipts
keep the Bun recipe and record the digest of the actual wrapped command.
