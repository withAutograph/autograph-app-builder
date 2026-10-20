# Managed app continuity exercise

This optional manual workflow runs one app-authored browser suite against an
owned app process behind the real Preview Gateway. The suite can stop that
process, wait for its exit, start the same environment, and observe readiness.
It uses the already approved persistent app resources and normal QA sessions.
It does not restart a hosted Vercel deployment or replace later native deployment
acceptance.

## Request and approval

Continue the original public Builder session with an ordinary product request
for the continuity outcome. App fixture changes belong to that same Builder
session. The evaluator does not edit the generated app or direct private stages.

The agent's optional `plan-app-hosted-runtime` tool accepts `operation:
"continuity"` for the selected Preview app. Planning resolves the current owned
checkout, original approved setup, app resources, Gateway delivery source,
participant scope, and actual Builder project/team. It observes two local ports;
it does not allocate resources or create accounts. Review the concrete returned
plan and request through the separate `run-app-continuity-tests` approval.
The human-visible plan is an echo; the operator's saved plan and exact
owner-authenticated approval receipt provide authority.

Approval covers the named app/session, existing resources and actors, owned
Sandbox process, temporary worker-asset transfer/disposal, one app-authored
suite, and an isolated managed Gateway target with its normal refresh and
cleanup. Review the app suite's actual business-write scope before approving.
No extra account, role grant, membership change, fixture seed, or data mutation
is implied by this shared capability.

## Deployment-owned worker setup

The deployment owner explicitly assembles Builder's worker entry with Arrusted's
real Gateway verification adapter. From the Builder repository root, the
existing build entrypoint is:

```sh
bun scripts/build-managed-runtime-worker.mjs <arrusted-source-root> <output-executable> [bun-target]
```

The optional target defaults to `bun-linux-x64`. The script emits JSON metadata
containing `compiler`, `target`, `sha256`, and `bytes`; it does not publish a
release or configure a deployment. Keep the output outside application source.
The owner packages the executable into the configured operator image/snapshot
and sets `sandbox.managedRuntimeWorker` in
`PROTECTED_HOSTED_OPERATOR_CONFIGURATION`: `id`, `executablePath`, the actual
`sha256`, `operationScope: "managed-app-runtime-v1"`, and
`subcommand: "protected-managed-app-runtime"`. Building is local preparation. Packaging into provider resources, deployment
configuration and activation remain deployment-owner actions under the applicable
existing approval.

The asset helper uses native **operator-host project OIDC** to open a temporary,
credential-free source VM from that configured image/snapshot. It supplies no
environment variables or ports and uses `allow-all` networking. It copies only
the configured executable's verified binary bytes through supported file APIs,
writes mode `0755`, verifies target readback, and disposes only its owned source
VM without deleting the shared snapshot. Unknown creation outcomes reconnect by
the same owned name; they do not create another VM blindly.

Access to the existing target Sandbox instead uses the exact verified incoming
**Builder workload carrier**, retained in a request-bound private closure. The
Builder token is never sent to the source VM. Provider credentials, Auth SQL
connections, Gateway signing keys, and private JWKs are not copied into the
worker input or app environment. The app receives its existing restricted app
database binding and public Gateway verification configuration; private suite
capabilities and normal QA session material remain in their dedicated custody.

The owned app receives `PLATFORM_MANAGED_GATEWAY_PUBLIC_PROFILE`, serialized from
the owner-validated public profile (`version`, `appId`, `publicOrigin`, `jwksUrl`,
and public Ed25519 `keys`). It is written to the private runtime environment file
and reused unchanged on process replacement. Apps must explicitly select
Arrusted's `@autograph/platform-microfrontends/managed-gateway-verification`
consumer for this managed environment: parse with
`managedGatewayVerificationProfileSchema`, then call
`createManagedGatewayVerification({ profile, appId, publicOrigin, jwksUrl })`
using the app's expected identity and Gateway endpoint. Its returned
`audience`, `publicOrigin`, `jwksUrl`, and `loadJwks` options support the existing
Next ingress/data-context verification. A supplied invalid or mismatched profile
fails closed; absence retains the app's native verification path. This does not
relabel the runtime as local, fetch OIDC, or copy a signer. The similarly named
`APP_TEST_MANAGED_PUBLIC_PROFILE` belongs to the suite; private suite selectors
and lifecycle capabilities are never app environment variables.

## Managed execution and routing

Ports are server-derived by one fixed structured Node command holding two
simultaneous `127.0.0.1:0` listeners and excluding actual provider public routes.
Both listeners close before planning returns. These observations are not port
reservations: a later real bind can fail normally. Callers supply neither ports,
custom commands nor environment overrides for this observation.

The worker launches the selected app through the supported
`mise run app:runtime run <app-id> dev` lifecycle. Private suite IPC supports
`status`, `stop-and-wait`, `start-same-environment`, and `observe-readiness`.
Mutating lifecycle commands retain their command IDs for uncertain-I/O recovery;
callers cannot supply a PID, replacement command, signer, or replacement data
binding. The approved suite runs through the existing prepared browser-test
execution against the Gateway origin, with the same approved normal QA actors.
A retained ready file is accepted only after checking that its actual owned
runtime command is still running; a stale file cannot prove process liveness.

The local owner file uses the existing 60-second lease, refreshed every 15 seconds
under a fresh owner fence. This renewable owner lease is separate from the
immutable Gateway/supervisor expiry bound captured from the approved provider
session. Refreshing the owner file does not extend that provider bound.

Only suite-selected requests use the managed target. They still pass real normal
Gateway authentication and signed method/body/target/app/actor/organization
verification. Ordinary native requests without a selector retain native routing;
an invalid supplied selector is denied. The suite selector, private Gateway to
bridge transport capability, and lifecycle capability have separate purposes.
Public verification keys do not grant signing authority. Published target/current
metadata is a trusted projection, not a claim that the Gateway performs a fresh
provider observation on every request.

## Unknown outcomes and cleanup

Retain the same intent, request, approved plan, command IDs and private journal
after a lost response. Status is read-only and does not start a process, publish
rows, or rerun a suite. Unknown suite-command outcomes read the saved command
before any further dispatch. Starting a replacement intent is not recovery.

If Gateway publication fails or remains unknown and the runtime is closed, the
saved intent enters revocation-only recovery. It reconciles and deletes only its
exact owned environment rows, then records terminal revocation with the explicit
failure. That recovery never republishes the target or runs the suite.

Cleanup closes the owned app/bridge/supervisor first, then deletes and reads back
only that intent's exact owned Gateway environment pair. It does not touch
native project bindings or issue a second Gateway deployment. An already active
Gateway deployment may retain the optional projection until a normal refresh or
expiry; row deletion does not prove active configuration removal. The closed
bridge, private transport boundary and lease/revocation checks prevent continued
forwarding. Uncertain cleanup remains incomplete and must reconcile.

## Evidence and limits

Controlled source fixtures prove the exercised contracts, not hosted continuity.
Hosted acceptance must observe the same real business record and authorized
session across the suite-controlled process replacement, with independent
restricted readback. A subsequent native deployment must separately prove that
record/session continuity on the same intended persistent resources.

This feature adds no app admission rule, fixed role shape, source/path/version
freeze, or usage quota. Ordinary app edits remain planning input; they do not
require rebuilding a Sandbox or rewriting issued schemas. Product-specific
assertions and fixture authoring remain app-owned through the original Builder
session.

## Source map

- Planning/approval: `agent/tools/plan-app-hosted-runtime.ts`,
  `agent/tools/run-app-continuity-tests.ts`, `lib/eve/private-continuity-approval.ts`.
- Configuration/build: `lib/provisioning/hosted-operator-source-configuration.ts`,
  `scripts/build-managed-runtime-worker.mjs` and its `.mts` implementation.
- Execution/asset custody: `lib/agent/managed-runtime-execution.ts`,
  `lib/agent/managed-runtime-worker-asset.ts`, `lib/agent/managed-runtime-entry.ts`.
- Lifecycle and Gateway publication: `lib/sandbox/managed-runtime-ipc.ts`,
  `lib/sandbox/managed-runtime-supervisor.ts`,
  `lib/provisioning/hosted-operator-managed-runtime-projection.ts`,
  `lib/provisioning/hosted-operator-continuity.ts`.
