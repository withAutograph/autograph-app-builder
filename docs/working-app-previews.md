# Working app previews

The shared `start_app_preview` tool opens the applied implementation in the current user's Vercel Sandbox. It accepts the repository's discovered development command as an executable and argument array, a listening port, an optional repository-relative working directory, and an optional nested landing path. Build approval and an applied implementation are required. The tool does not publish the app or provision its external resources.

The backend supplies the provider Sandbox identity; the model cannot choose another Sandbox or supply a preview URL. The official Sandbox SDK uses the project's existing OIDC credentials. Runtime scripts and access configuration live outside the applied repository under `/workspace/.autograph-working-preview`.

Startup closes ingress, starts a gateway that initially denies all requests, waits for its listener, exposes only that port, and activates access using the actual provider URL. The application port is never exposed. The gateway exchanges a temporary bearer launch link for an HttpOnly, Secure, host-only cookie and removes the launch token before loading the app. The generated app uses a separate browser origin from App Builder. Platform headers and the gateway cookie are removed upstream; the application's own bearer authentication and cookies remain available. Do not inject App Builder credentials into preview requests. The launch link is shareable by its owner until it expires; this is capability access, not identity-bound access after sharing.

A ready receipt requires a successful same-origin HTTP navigation to an HTML page. Spawn success, a fixture prototype, and a model-supplied URL do not qualify. HTTP readiness does not prove authentication, persistence, orchestration, accessibility, visual parity, or browser cookie behavior. Those need product acceptance against the running app.

The preview access window is ten minutes. The supervisor terminates the app process group when that window expires. Normal agent completion retains only the same live provider process; cancellation and failure stop it. Existing provider timeouts and lease reconciliation clean up the Sandbox. Startup cancellation propagates through provider operations and polling, so cancelled polling cannot resume stopped compute. A new start operation can reopen a stopped Sandbox and start a fresh preview through the normal agent workflow.

Public session results distinguish `workingPreview` from fixture `uiPreview`. New startup requests, failed startup, cancellation, and expired access invalidate the current public preview. Explicit invalidation survives checkpoint recovery. Stored receipts remain historical evidence, not permanent availability promises.

## Startup ownership and diagnostics

A sandbox-local attempt journal records ownership before the supervisor starts.
This runtime state lives outside the generated repository. Eve state projects
pending ownership for lifecycle cleanup; a step checkpoint alone does not
serialize an in-flight provider operation. A pending live attempt prevents a
second listener from starting. Replacement waits for the old command to exit,
and journal updates cannot publish readiness for an obsolete attempt.

Readiness polling has a deadline that also reaches SDK file reads and HTTP
requests. Failed startup retains a bounded private stdout/stderr tail, and the
returned diagnostic redacts URLs and common credential forms. Redaction is
best-effort; private runtime logs are not public evaluation artifacts. These
messages help the normal Builder agent recover without evaluator instructions.

The journal uses Node's built-in SQLite in the supported Node 24 Sandbox
runtime. Its transactions release locks and roll back interrupted writes when
the journal process exits. Recovery does not take over a live supervisor merely
because polling timed out. When command dispatch did not return an identity,
ownership remains pending until expiry and termination can be established.

Provider updates have no compare-and-swap API. Ownership checks and supervisor
activation prevent competing listeners, but cannot retract a remote operation
already accepted by Vercel. Recovery stops the previous command and conditionally
releases its identity; it does not close a newer attempt's ingress.

## Limitations and acceptance

The gateway is not an isolation boundary against malicious generated code running under its own OS user in the same Sandbox. Cross-user isolation belongs to the authenticated Builder session and Sandbox boundary. Cross-origin unsafe requests are denied; generated apps must not mutate state through GET requests. WebSocket upgrades are currently unavailable.

Focused tests cover actual gateway HTTP traffic, delayed activation, application authentication forwarding, real supervisor process-group shutdown, provider identity binding, cancellation, startup failures, and public receipt recovery. The 2026-09-14 public-entrypoint acceptance failed startup and recovery; see `docs/reports/self-reproduction/2026-09-14-working-preview-acceptance.md` and `docs/reports/self-reproduction/2026-09-14-recovery-acceptance.md`. Startup timeouts now distinguish listener startup from application HTTP readiness and report only safe status observations. A new live acceptance is still required to establish that App Builder starts a real generated app and hands its working URL to the user. Do not count a direct infrastructure probe as self-reproduction evidence.
