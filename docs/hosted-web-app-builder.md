# Hosted Web App Builder

Status: Proposed implementation contract

Audience: Product, design, application, platform, and release engineering

Decision: Make the hosted guided workbench the default App Builder experience
after Preview acceptance, while retaining ChatGPT / Codex and Cursor as
optional destinations.

## Summary

Autograph must let a signed-in user design, build, validate, and deliver an app
without leaving the web product for Codex, Cursor, or another development
environment. The hosted experience is a guided product workbench, not a cloud
IDE: it combines a product-facing conversation, an isolated live preview, and
the current build and delivery state.

The workbench reuses the existing hosted Eve session service, durable
PostgreSQL checkpoints, Vercel Sandbox execution, repository-access flow, and
signed preview route. It does not introduce another agent runtime or broaden
the five-tool public MCP contract. First-party browser routes adapt the same
session service to the existing Better Auth web session.

Draft pull request publication and hosted deployment are equal delivery paths.
The user may choose either or both, but each is a separate consequential effect
with its own proposal, explicit approval, execution record, provider readback,
and retry boundary.

## Goals and non-goals

### Goals

- Complete the full App Builder lifecycle in one authenticated browser surface.
- Keep the conversation about the product rather than exposing agent mechanics.
- Show every prototype revision in an isolated, interactive preview.
- Preserve work across refreshes, devices, expired compute, and recoverable
  runtime interruptions.
- Build and validate with the existing hosted sandbox execution path.
- Let the user independently approve a draft pull request, a hosted deployment,
  or both.
- Keep ChatGPT / Codex and Cursor available for users who prefer an external
  client.
- Meet the existing tenant isolation, idempotency, repository authority, and
  public-event disclosure contracts.

### Non-goals

- A browser file explorer, source editor, terminal, or general-purpose cloud
  IDE.
- A second orchestration runtime, session store, or app-generation workflow.
- Direct browser access to Eve, PostgreSQL, GitHub credentials, Vercel
  credentials, workload identity, or sandbox control APIs.
- Changing the public `/mcp` endpoint or its exact five tools.
- Treating an accepted prototype or plan as a completed build.
- Publishing, deploying, provisioning, or modifying a repository from an
  inferred approval.
- Inventing App Builder usage, spend, membership, workspace, or concurrency
  quotas. Provider capacity is observed when an operation runs.

## Current state

The following capabilities already exist and are inputs to this proposal:

- The create-app form gathers the brief, repository, provider choices, and a
  required **Build with** destination.
- ChatGPT / Codex is the current default, Cursor is selectable, and Web Chat is
  rendered as a disabled **Coming soon** option when the feature is exposed.
- The web flow can provision selected GitHub and Vercel resources and create an
  opaque handoff for an external client.
- The hosted Eve core supports tenant-scoped start, get, send, respond, and
  cancel operations with durable PostgreSQL state, idempotent mutations,
  checkpoints, and recovery.
- Public session projection already separates product-facing events, input
  requests, prototypes, UI previews, and implementation-plan summaries from
  private runtime events.
- Prototype bytes can be served from a session- and digest-bound isolated
  preview route.
- Repository access uses the signed-in user's GitHub App installation and
  requires live provider readback before repository work.
- Vercel Sandbox is the execution backend and project-scoped Vercel OIDC is the
  credential boundary.

These source capabilities are not evidence that the hosted web workbench has
been activated or proven in Preview or Production. The browser session API,
workbench UI, hosted delivery coordination, and end-to-end acceptance described
below remain proposed work.

## Product requirements

### Primary journey

1. A signed-in user enters an app brief, chooses storage and deployment
   providers, and keeps **Web** as the default **Build with** destination.
2. **Create App** completes the selected pre-build provider setup and starts a
   durable App Builder session in the same site. It does not create an opaque
   external-client handoff for the Web path.
3. The browser navigates to the session workbench. The user sees the product
   conversation immediately and can safely refresh or open the same session on
   another device.
4. The builder infers reversible defaults and asks only product questions that
   materially affect the result. All questions in one outstanding batch are
   answered together.
5. When a prototype is ready, the workbench loads its exact signed revision in
   the preview pane. The user can interact with it and request changes from the
   conversation pane.
6. The user explicitly finalizes the current UI revision before the builder
   defines production behavior. A later visual revision invalidates that
   acceptance.
7. The builder prepares a read-only implementation proposal for the current,
   live-revalidated repository state.
8. After a separate build authorization, the existing hosted sandbox applies
   the proposed changes in its isolated execution workspace and runs the
   focused validation flow.
9. The workbench presents the resulting change summary, validation results,
   preview, and independent delivery actions.
10. The user may approve **Open draft pull request**, **Deploy hosted app**, or
    both. Each action settles independently and is successful only after the
    corresponding provider readback is projected as a public receipt.

### Guided workbench

The desktop layout has three coordinated regions:

1. **Conversation** contains the product timeline, composer, question batches,
   repository authorization cards, cancellation, and recovery actions.
2. **Preview** is the primary region once a prototype exists. It contains the
   isolated app frame, route selector when applicable, revision identity,
   loading and stale state, refresh, and an open-in-new-tab action.
3. **Build and delivery** contains stage, implementation proposal, validation
   summary, changed-file summary, provider resources, delivery proposals, and
   terminal receipts.

Before a preview exists, the conversation is primary and the preview region
shows a product-facing preparation state. The user may collapse the build and
delivery region, but outstanding input and approval requests must remain
visible.

On a narrow viewport, the regions become **Build**, **Preview**, and **Details**
tabs. **Build** contains the conversation and input controls; **Details**
contains implementation, validation, and delivery state. The selected tab must
not reset when new events arrive. A badge announces unseen input or completed
work without moving focus.

### Conversation behavior

- Display only allowlisted public events and product-facing status. Do not show
  reasoning, system instructions, raw tool calls or results, internal setup,
  receipts under construction, digests, or adapter identifiers.
- Permit a freeform follow-up only when the session is waiting and has no
  unresolved input batch or consequential approval.
- Submit every non-authorization request in the current input batch in one
  ordered operation, preserving every request ID. Do not partially submit a
  batch.
- Render authorization requests as server-provided connection or access-update
  actions. A redirect, callback, click, or typed confirmation is never evidence
  that access was granted.
- Refresh the same session automatically after an authorization window returns
  focus. **Check access** is the explicit fallback.
- Treat cancellation as cooperative. Show **Cancelling** until a public
  `cancelled` or failure event settles the request.
- Prevent duplicate submits while a mutating continuation is reserved. A
  competing continuation receives a retryable busy result and never forks the
  visible history silently.

### Preview behavior

- The preview is a pure product surface. It must not contain conversation,
  implementation plans, validation details, receipts, or editor controls.
- Load only the server-provided HTTPS preview URL for the exact session and
  digest. Do not copy prototype HTML into the workbench document.
- Sandbox the frame and retain the preview route's restrictive security and
  no-store headers. Do not grant same-origin privileges that allow the preview
  to inspect the workbench.
- Show the current revision and an explicit stale state when a newer prototype
  event exists but the new frame has not loaded successfully.
- Keep the last successfully loaded revision visible while the next revision
  loads. Never label it current until its frame load succeeds.
- Preserve route and viewport selections across compatible revisions. Reset a
  route only when the new preview no longer declares it.
- A design change after UI finalization revokes the visible finalization state
  and returns the product flow to preview review.

### Build, validation, and delivery

- Implementation begins only from the exact accepted UI revision and
  build-ready product specification.
- Before repository reads, build execution, publication, or deployment, the
  server re-resolves the current user, organization, workspace, provider
  installation, repository, permissions, default branch, SHA, and tree.
- Ordinary source movement refreshes planning input. It is not by itself a
  tenant or credential failure. If the prior proposal is stale, the builder
  prepares a new proposal and requests approval for the new effect.
- Validation results identify the exact proposed change revision and classify
  checks as passed, failed, or unavailable. Unavailable proof is never shown as
  passed.
- Draft-PR and deployment cards remain independent. A failure or denial in one
  does not invalidate a successful result in the other.
- A retry reuses the same approved proposal only when the proposal digest and
  live provider target still match. Otherwise, the server prepares a new
  proposal and requires a new approval.
- The delivery area links to the provider result only after a provider readback
  proves the expected repository/ref or deployment identity and outcome.

### Resume and recovery

- Authenticated sessions are listed newest-first with title, app identity,
  stage, updated time, resumability, and whether attention is required.
- Opening a session loads its durable checkpoint first, then reconnects to live
  events from the checkpoint cursor.
- A healthy Eve session continues directly. An expired compute lease or
  recoverable interruption fences the prior adapter generation and resumes
  from the last settled checkpoint.
- Refresh, navigation, network loss, and cross-device resume must not duplicate
  a mutating operation. The browser retains the client request ID until a
  terminal response is observed.
- If the event connection drops, keep the last durable state visible, announce
  **Reconnecting**, and resume from the last accepted cursor with bounded
  exponential backoff.
- If an event cursor is no longer retained, return a fresh checkpoint and its
  cursor rather than replaying private history or failing the session.
- Deleted and cross-tenant session identifiers share the same not-found
  response. A user must never learn whether another tenant owns a handle.

## Architecture decision

### Decision

Add a first-party, same-origin web adapter over the existing hosted session
service. The adapter authenticates with the Better Auth browser session,
constructs the same tenant-scoped principal used by hosted App Builder, and
invokes the existing service methods. It exposes browser-safe JSON and SSE; it
does not route browser traffic through the public MCP protocol and does not
duplicate Eve orchestration.

The request flow is:

```text
Browser workbench
  -> same-origin Builder route
  -> Better Auth session and live workspace membership
  -> tenant-scoped hosted session service
  -> PostgreSQL session/checkpoint store
  -> same-project Eve transport
  -> Vercel Sandbox and approved provider adapters
```

The browser receives only the public projection. The server retains provider
credentials, project OIDC, forwarded principal metadata, raw Eve events,
adapter session IDs, tool inputs and outputs, repository command output, and
private receipts.

### Alternatives considered

**Continue external-client handoff only.** This preserves the current model but
does not meet the requirement to build in place and forces the user to repeat
context and authorization across surfaces.

**Embed a cloud IDE.** Files, terminals, and editors offer flexibility but
replace the product-guided App Builder with a general development environment,
increase the exposed execution surface, and make mobile and non-engineer use
substantially worse.

**Create a browser-specific agent runtime.** This could simplify an isolated
prototype, but would split session semantics, checkpoints, approvals,
observability, and quality between MCP and web. The existing hosted service is
the canonical orchestration boundary and must be reused.

## Web server contract

All routes below are proposed. They are first-party application interfaces, not
new public MCP tools. They live under `/api/builder/sessions`, require the
existing Better Auth session, derive tenant authority on the server, reject
cross-origin mutation requests, and set `Cache-Control: no-store`.

| Method | Route                                                  | Behavior                                                                             |
| ------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `POST` | `/api/builder/sessions`                                | Start a session from the validated web intent and an idempotent `clientRequestId`.   |
| `GET`  | `/api/builder/sessions?cursor=&limit=`                 | List recent tenant-scoped session summaries.                                         |
| `GET`  | `/api/builder/sessions/{sessionId}`                    | Read the latest durable public checkpoint and current cursor.                        |
| `GET`  | `/api/builder/sessions/{sessionId}/events?cursor=`     | Stream public events as same-origin SSE from an absolute cursor.                     |
| `POST` | `/api/builder/sessions/{sessionId}/messages`           | Send a follow-up with an idempotent `clientRequestId`.                               |
| `POST` | `/api/builder/sessions/{sessionId}/responses`          | Submit the complete outstanding response batch with an idempotent `clientRequestId`. |
| `POST` | `/api/builder/sessions/{sessionId}/cancel`             | Request cooperative cancellation.                                                    |
| `POST` | `/api/builder/sessions/{sessionId}/delivery-proposals` | Prepare a read-only `draft_pull_request` or `hosted_deployment` proposal.            |
| `POST` | `/api/builder/sessions/{sessionId}/delivery-approvals` | Approve or deny one exact delivery proposal; approval starts only that effect.       |

The existing `/preview/{sessionId}/{digest}` route remains the preview content
boundary. Session responses return its server-generated URL and metadata; the
browser never constructs a preview URL from untrusted identifiers.

### Request rules

- Mutation requests require `Content-Type: application/json`, an accepted
  same-origin request, and a UUID `clientRequestId` when the operation supports
  idempotency.
- The client never sends an issuer, audience, user ID, organization ID,
  workspace ID, provider installation ID, repository ID, credential, or
  adapter session ID as authority.
- `sessionId`, cursor, request IDs, proposal IDs, and selected option IDs are
  opaque references. The server rebinds every reference to the authenticated
  tenant before use.
- A response submission must contain exactly the complete set of current
  non-authorization request IDs. Missing, additional, duplicated, or stale IDs
  fail without advancing the session.
- A delivery approval identifies one server-stored proposal and repeats its
  confirmation digest. The server verifies the digest and all live target
  authority immediately before execution.
- Reusing a client request ID with different canonical request bytes returns an
  idempotency conflict. A retry with identical bytes returns the settled public
  result.

### Browser-safe models

The web adapter should define closed, versioned schemas equivalent to these
logical models:

```ts
type WebBuilderSessionSummary = {
  version: 1;
  sessionId: string;
  title: string;
  appId?: string;
  stage:
    | "designing"
    | "needs_attention"
    | "preview"
    | "planning"
    | "building"
    | "validating"
    | "delivery"
    | "complete";
  resumability: "live" | "checkpoint" | "needs_attention";
  updatedAt: string;
};

type WebBuilderCheckpoint = {
  version: 1;
  session: WebBuilderSessionSummary;
  status: "working" | "input_required" | "waiting" | "completed" | "failed" | "cancelled";
  cursor: number;
  events: WebBuilderPublicEvent[];
  inputRequests?: WebBuilderInputRequest[];
  preview?: WebBuilderPreview;
  implementation?: WebBuilderImplementationSummary;
  validation?: WebBuilderValidationSummary;
  delivery?: WebBuilderDeliveryState[];
};

type WebBuilderPreview = {
  appId: string;
  revision: string;
  digest: string;
  url: string;
  routes: string[];
  fidelity: "arrusted-component-catalog";
  functionality: "fixtures-only" | "implemented";
};

type WebBuilderDeliveryState = {
  kind: "draft_pull_request" | "hosted_deployment";
  state:
    "not_prepared" | "proposal_ready" | "approved" | "running" | "succeeded" | "failed" | "denied";
  proposal?: {
    proposalId: string;
    confirmationDigest: string;
    summary: string;
    targetLabel: string;
    expiresAt: string;
  };
  receipt?: {
    outcome: "succeeded" | "failed";
    provider: "github" | "vercel";
    resultUrl?: string;
    completedAt: string;
  };
};
```

`WebBuilderPublicEvent`, input request, implementation, validation, proposal,
and receipt schemas must be closed discriminated unions. Renderers must switch
exhaustively on their types. Unknown event or receipt variants fail closed and
are not displayed as successful progress.

The public models must not contain prompts, full AppSpec contents, raw source,
prototype HTML, provider tokens, token claims, database addresses, environment
variables, tool output, workload-identity headers, internal operation IDs, or
adapter session IDs. A bounded product-facing change summary is allowed; source
diff review belongs on the approved provider surface unless a separately
designed safe diff model is added later.

### SSE semantics

- Emit an initial `checkpoint` event, followed by ordered `session_event`
  records and periodic comment heartbeats.
- Every data event includes the absolute session cursor as its SSE ID. Accept
  `Last-Event-ID` and the explicit `cursor` query only when they agree.
- Deliver only events strictly after the accepted cursor. Duplicate transport
  delivery is harmless because the client de-duplicates by cursor.
- Close or rotate the stream before the hosting platform timeout. The client
  reconnects from the last accepted cursor.
- Emit `session_settled` before closing after completed, failed, or cancelled
  state.
- Return an ordinary authenticated JSON error before streaming begins. After
  streaming begins, emit only a safe `stream_error` code and close; never emit
  exception text.
- SSE is observational and cannot refresh a mutating execution lease.

## State model

The user-facing workbench state is derived from the durable session result and
delivery records; it is not an independent source of truth.

| State               | User-visible meaning                                                  | Permitted next action                                                              |
| ------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `working`           | Autograph is shaping the product or continuing approved work.         | Observe or request cooperative cancellation.                                       |
| `input-required`    | Product answers or authorization are required.                        | Submit the complete answer batch or complete the indicated authorization.          |
| `preview-ready`     | A new interactive product revision is ready.                          | Review, send feedback, or explicitly finalize that revision.                       |
| `plan-ready`        | The accepted experience has a read-only implementation proposal.      | Review and authorize the exact build proposal.                                     |
| `building`          | Approved changes are being prepared in hosted sandbox execution.      | Observe or request cooperative cancellation where supported.                       |
| `validating`        | Focused checks are running against the exact change revision.         | Observe; failed or unavailable checks return actionable recovery.                  |
| `approval-required` | A draft-PR or deployment proposal is ready.                           | Approve or deny each proposal independently.                                       |
| `publishing`        | The approved draft-PR effect is running.                              | Observe; retry only after a settled failure.                                       |
| `deploying`         | The approved hosted-deployment effect is running.                     | Observe; retry only after a settled failure.                                       |
| `completed`         | Requested build and selected delivery effects have proven outcomes.   | Open results, start another delivery path, or continue with a new product request. |
| `failed`            | The active operation settled unsuccessfully and work remains durable. | Use the offered retry or recovery action.                                          |
| `cancelled`         | Cooperative cancellation has been publicly confirmed.                 | Resume from the last safe checkpoint or start a new session.                       |

Delivery substates may progress independently while the main session is
waiting. The overall session is not `completed` merely because one optional
delivery path is unrequested. It is complete when implementation and validation
have settled and every user-approved delivery operation has a terminal public
outcome.

## Security and authority

- Resolve the Better Auth session and its active organization on every request.
  Recheck exact subject/workspace membership before store, Eve, repository, or
  provider access.
- Use the resolved subject and sole active workspace to construct the hosted
  principal. Do not accept an alternate workspace in a header, query, path, or
  JSON body.
- Retain tenant-scoped store predicates for every session, checkpoint,
  operation, proposal, and delivery receipt.
- Require CSRF protection through strict same-origin validation for mutations
  in addition to secure session-cookie policy.
- Keep GitHub and Vercel credentials in their existing server-side credential
  boundaries. Provider actions use current scoped credentials and current
  provider readback, not checkpointed authority.
- Keep workload identity between trusted server components. Never forward a
  browser credential to Eve or a project OIDC token to the browser.
- Continue sanitizing public events. Add disclosure tests for web JSON, SSE,
  rendered HTML, browser logs, and provider-log evidence.
- Rate-limit authentication abuse and bound untrusted body, message, option,
  event-page, and preview sizes. Do not convert those security limits into
  invented product quotas.
- Store delivery approval and execution records durably outside normal session
  event retention so a lost approval response cannot redispatch an effect.

## Accessibility and responsive behavior

- All workbench functions must be operable with a keyboard and visible focus.
- Conversation updates use a polite live region; errors and newly required
  input use an assertive alert only once. Streaming progress must not repeatedly
  interrupt assistive technology.
- New events never steal focus, change tabs, scroll the user away from their
  reading position, or reload the preview automatically while it has focus.
- Question batches use semantic fieldsets, labels, descriptions, and one clear
  submit action. Validation identifies every unresolved answer.
- Approval cards state the exact effect, target, and consequence in text; color
  and icons are supplementary.
- Preview controls have accessible labels, and iframe titles include the app
  name and revision state.
- Desktop panes meet minimum usable widths. At narrower widths the tabbed
  layout preserves all actions without horizontal page scrolling.
- Loading, empty, disconnected, stale, failed, cancelled, and completed states
  have distinct text and do not rely on animation.
- Respect reduced-motion and contrast preferences and retain the existing
  Better Auth UI and theme boundaries.

## Observability

Emit structured, tenant-safe metrics and logs for:

- session starts, resumes, checkpoint recoveries, and terminal outcomes;
- time to first public response, first preview, accepted preview, build-ready
  proposal, validation settlement, and delivery settlement;
- input-batch submission failures, stale batches, busy continuations, and
  idempotency conflicts;
- SSE connections, reconnects, cursor resets, safe stream errors, and time to
  catch up;
- preview load success, failure, stale duration, and revision changes;
- repository authorization requirements and successful live readbacks;
- build and validation outcomes by safe error code;
- draft-PR and deployment proposal, approval, denial, dispatch, provider
  readback, retry, and terminal outcome.

Logs and metrics must not contain prompts, event text, AppSpec content, source,
credentials, session tokens, database addresses, provider response bodies, or
raw tenant identifiers. Use stable nonreversible operational correlation values
where correlation is required.

## Delivery plan

### Milestone 1: Read-only workbench and resume

- Add closed browser-safe session schemas and the authenticated list/read
  adapters over the hosted session service.
- Add the workbench route, durable session list, checkpoint rendering, and
  responsive three-region shell.
- Render public conversation, preview metadata, implementation summary, and
  existing terminal state without mutations.
- Prove tenant isolation, refresh, cross-device resume, and accessibility of
  the read-only experience.

Exit criterion: a signed-in Preview user can list and open only their sessions,
refresh safely, and inspect the latest public product result and preview.

### Milestone 2: Conversation and preview iteration

- Add start, message, complete-batch response, cancellation, and SSE adapters.
- Reuse the shared repository connection/access-update view model in the web
  workbench.
- Add preview loading, revision changes, stale handling, route selection, and
  open-in-new-tab behavior.
- Preserve client request IDs across connection loss and confirm idempotent
  recovery.

Exit criterion: a user can begin or resume a session, answer requests, iterate
the product preview, recover after refresh or disconnect, and cancel without an
external client.

### Milestone 3: Hosted implementation and validation

- Project build-ready and explicit build-approval state into the workbench.
- Invoke the existing sandbox target-execution path after exact approval and
  live repository revalidation.
- Project bounded change and validation summaries without exposing private
  execution output.
- Recover expired compute from the last settled checkpoint and fence stale
  execution generations.

Exit criterion: the accepted product can be implemented and validated in the
hosted flow, with exact revision binding and actionable public failure states.

### Milestone 4: Independent delivery paths

- Add durable read-only proposals and explicit approval endpoints for draft
  pull requests and hosted deployments.
- Reuse existing GitHub publication and Vercel provider boundaries rather than
  issuing browser-side provider calls.
- Add independent cards, terminal receipts, links, partial-failure handling,
  and safe retry or reproposal behavior.
- Prove lost-response recovery and non-redispatch for each outward effect.

Exit criterion: either or both delivery paths can settle independently, and no
effect is claimed until exact provider readback proves it.

### Milestone 5: Default-Web rollout

- Add a dedicated hosted-workbench feature flag and expose Web as an enabled
  destination only in eligible environments.
- Run internal and invited-user Preview acceptance, then make Web the selected
  default while keeping ChatGPT / Codex and Cursor available.
- Remove the **Coming soon** presentation only after the Web path meets every
  acceptance gate.
- Promote beyond Preview only with separate hosted authentication, persistence,
  execution, isolation, disclosure, repository, and delivery evidence.

Exit criterion: an eligible user can choose the default Web destination and
complete the representative acceptance journey without leaving Autograph.

## Test plan

### Unit and contract tests

- Closed request and response schemas reject unknown authority, private event,
  receipt, and identifier fields.
- Tenant derivation ignores and rejects caller-supplied workspace or provider
  authority.
- Complete response-batch validation rejects missing, extra, duplicate, and
  stale request IDs.
- Client request IDs return the settled result for identical retries and
  conflict for changed bytes.
- State projection covers every public status and delivery combination.
- Unknown event and receipt variants fail closed.
- Preview URLs, session IDs, cursors, and proposal references are server-bound
  and tenant-scoped.

### Service and integration tests

- Start, list, resume, get, send, respond, and cancel share the existing hosted
  service semantics.
- SSE reconnect resumes after the last cursor without missing or reordering
  events; duplicate transport delivery does not duplicate UI state.
- Cursor expiry returns a fresh safe checkpoint.
- Concurrent reads succeed while a second mutating continuation receives a
  retryable busy result.
- Expired compute resumes from the last settled checkpoint and fences the old
  generation before another command runs.
- Repository connect and update flows continue the same session only after a
  live GitHub readback.
- Repository rename, transfer, deletion, archival, permission loss, and
  installation suspension return to the access flow without discarding product
  work.
- Draft-PR and deployment proposals bind exact current targets and cannot grant
  authority to each other.
- Lost delivery responses recover the existing operation and never redispatch
  automatically.
- Public JSON, SSE, HTML, logs, and receipts pass disclosure scans.

### Browser acceptance scenarios

- Start a new app from the web form and arrive in its workbench without opening
  another application.
- Resume an existing session from the session list on another authenticated
  browser and see the same durable product state.
- Answer a multi-question batch, refresh during continuation, and observe one
  resulting mutation.
- Connect or update GitHub access, return to the same workbench, and continue
  automatically after provider verification.
- Review a prototype, navigate its routes, request an iteration, observe stale
  and new revision states, and explicitly finalize the current revision.
- Recover after network loss, SSE rotation, expired compute, and a browser
  restart.
- Cancel active work and wait for the terminal public cancellation state.
- Build and validate the representative app in hosted execution.
- Approve only a draft PR and verify that no deployment occurs.
- Approve only a hosted deployment and verify that no draft PR occurs.
- Approve both, force one provider failure, and verify that the successful path
  remains valid while only the failed path offers recovery.
- Revoke repository permission before publication and verify that publication
  parks on access recovery rather than writing.
- Exercise desktop, tablet, and mobile layouts with keyboard-only navigation,
  screen-reader announcements, reduced motion, zoom, and automated accessibility
  checks.

## Acceptance criteria

The hosted Web App Builder is ready to become the default only when all of the
following are true in an authorized Preview environment:

- A signed-in user can complete a representative app from brief through
  reviewed prototype, explicit functionality finalization, implementation, and
  validation without opening Codex, Cursor, a terminal, or another IDE.
- Refresh, disconnect, expired compute, and cross-device resume preserve one
  coherent tenant-owned session without duplicate mutations.
- The exact accepted preview revision is bound to the implementation proposal
  and validation result.
- Repository access is re-read live before source access and publication.
- Draft-PR and hosted-deployment effects require distinct explicit approvals,
  settle independently, and expose links only after provider readback.
- Cross-tenant session, preview, proposal, and delivery access fail closed.
- Public responses, SSE, workbench rendering, receipts, and provider evidence
  contain no private runtime or credential material.
- The responsive workbench passes its keyboard, screen-reader, contrast,
  reduced-motion, and viewport checks.
- Preview telemetry shows no unresolved correctness or isolation defect. No
  product quota is introduced as a substitute for provider-capacity evidence.
- ChatGPT / Codex and Cursor remain selectable alternatives.

Production activation is a separate decision. Passing local tests or Preview
acceptance does not, by itself, authorize deployment, provider configuration,
plugin publication, feature-flag promotion, or Production traffic.
