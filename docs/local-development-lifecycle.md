# Local development lifecycle

`mise run dev` is the fast, live-code loop: edit the checkout, let Next HMR or the affected Eve/package process reload, and retry the behavior. Do not rebuild artifacts, reinstall the plugin, run broad suites, publish, or deploy after each edit.

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
