# Normal platform control: machine-only Services composition

This refines [normal platform setup](2026-11-04-normal-platform-integrations-setup.md).
People manage connections through the generated app's authenticated Integrations
UI. The shared control deployment does not offer a second human application or
sign-in page. Its provider/data scope remains dedicated Development and QuickBooks
Sandbox, independently of the hosting environment.

## One recorded destination and three Services

Keep the existing owned platform Services project and the reviewed three-service
graph: Gateway, its selected configuration-only Shell slot, and Integrations.
The generated app retains its own recorded `apps-<app-id>` destination. This
change creates no additional project, integration backend, Auth project or
acceptance deployment. Existing customer Production configuration and data remain
outside this operation.

Use a distinct normal source configuration and receipt. Do not reinterpret the
legacy two-service isolated profile, its worker catalog, frozen plans or receipts.
The normal source inventory must include the actual selected entrypoints,
configuration and three fixed workers; stale extra authored files are rejected.

## Gateway and Shell boundaries

The normal control Gateway must use the maintained neutral request handler with
a closed machine access policy. It must not call the ordinary human Gateway
runtime, install default session loaders, or import the local Auth server during
startup or request handling. Supplying an unused global Auth environment is not a
valid substitute for this separation.

Only the maintained exact POST readiness and signed application-control paths
declared by the normal Integrations runtime can be forwarded to the Integrations
service. Validate the raw request target before URL normalization. Reject unknown
paths, query variants, wrong methods, duplicate security headers, upgrades and
human pages. A bearer-shaped string is only a transport prerequisite: the target
handler must independently verify the current inspector or app workload, signed
application identity, human delegation where required, resource and binding
authority, expiry and replay controls. A fabricated tenant or browser cookie
cannot grant control authority.

The selected Shell service is an explicit configuration-only, deny-all slot. It
must not build the interactive Shell's Auth routes, initialize an Auth pool, serve
sign-in pages or redirect to a customer/global Auth service. Its package-owned
entrypoint returns a bounded no-store denial for every HTTP request and rejects
upgrades. The existing neutral routing-only helper authorizes all configured
routes; using it unchanged does not satisfy this deny-all contract. Keep the
denial implementation in the maintained platform composition, not generated app
code or an evaluator fixture.

The Integrations service must also deny its own human pages in this normal
machine composition before invoking local Auth. Direct service access must still
enforce each handler's full machine authorization. Service routing and an outer
Vercel login page are not application authorization.

## Hosting, outer protection and public Auth

Control setup may retain its approved Preview branch and protection. A generated
app's Production server reaches it using a fresh provider SDK workload token in
`x-vercel-trusted-oidc-idp-token`, with the exact separately approved and read-back
Production-to-Preview Trusted Sources rule. The signed app/control credentials
remain separate from this outer transport admission. Do not forward a browser's
carrier, use a bypass secret, weaken protection, guess an alias or select a native
deployment from Git state.

Provider callbacks first reach the recorded public app origin and its maintained
callback handler. That handler verifies the provider delivery and forwards through
the same protected server transport. Neither browsers nor QuickBooks/Ampersand
are required to log in to the control Preview deployment.

The genuine shared Development Auth realm has its own separately approved public
Production host and scoped application transport. Control Preview is not that
realm host: it receives no realm database, migrator, master secret or fabricated
Shell enrollment. App login, session and assignment checks continue through the
real app-bound Auth transport. Resource-installed Auth custody alone does not
prove hosted activation or eligibility.

## Freeze and verification

Before preparing a normal setup approval, capture a new exact source/configuration
receipt and actual compiled startup proof for this machine composition. Bind both
to the immutable assembly and full normal plan digest. Do not reuse an interactive
Shell startup result, an isolated-profile receipt or placeholder hashes.

Focused source qualification must execute the compiled Gateway, configuration-only
Shell and relevant Integrations entrypoints with local/global Auth loader imports
made fatal. Prove denied human/unknown/direct-service routes, missing or foreign
machine identities, wrong method/environment and duplicate/escaped targets reach
no Auth pool and no provider/SQL effect. Prove a valid scoped readiness/application
request reaches its maintained full verifier; an injected verifier fixture alone
is not hosted acceptance. Retained artifacts contain bounded receipt hashes and
diagnostics, with no raw request tokens or private environment values.

Final hosted acceptance separately proves the actual current provider-owned
deployment, exact outer-protection grant, a positive app server request, negative
wrong-caller/environment requests, provider callback delivery and the user's
ordinary app BetterAuth login and persistent action. Passing source tests does not
complete these rows. Missing source, native activation or identity proof is a
typed prerequisite with zero effects; there is no legacy or global-Auth fallback.
