# Self-reproduction evidence

## Acceptance contract

This eval asks the ordinary App Builder product to create an independent replica
of App Builder from the checked-in
[product brief](../../evals/self-reproduction/brief.md). A qualifying baseline
uses the supported web application or the
[five public MCP tools](../public-mcp-contract.md). The evaluator may automate
those public interactions, but it must not call internal Eve stages, prepare a
candidate workspace, edit generated output, or give implementation advice from
the reference application or an evaluator.

After the initial brief, input is limited to ordinary product questions answered
from the [fixed answer sheet](../../evals/self-reproduction/answers.json) and
explicit approval replies. Record every response. Connection and authorization
cards use their normal product flow; a chat message cannot stand in for a
provider connection. Resume the same session after a question or recoverable
failure instead of selecting a better reroll.

The shared Builder workflow owns repository acquisition, dependency setup,
planning, implementation, recovery, validation, and delivery of a working
preview. The replica must have its own persistence and orchestration and must
create one small independent app through its own backend. Persistence may use a
repository-supported relational path or an application-owned durable local
store such as a file or SQLite database. Credit requires observable writes and
readback across the required lifecycle; a success-shaped response or source
claim is insufficient.

The evaluator may prepare isolated synthetic users and provider emulators,
observe the product workflow, and inspect unchanged exported output
afterward. Reference source, screenshots, evaluator findings, and comparison
fixtures remain outside generator input. The current acceptance run does not
create evaluator-owned hosting for the candidate.

Report every requirement as **passed**, **failed**, **blocked**, or
**unassessed**. Missing generated functionality is a failure. Unavailable
infrastructure is a blocker. A model claim, successful request submission, HTTP
readiness probe, build, or screenshot cannot substitute for the relevant user
behavior. Preserve partial results and explain missing evidence. Visual scores
remain advisory. Hosted publication and provisioning remain unverified unless
separately authorized and exercised.
Anonymous entry is excluded from the current repair and acceptance scope.

## Supported public driver

Use `mise run eval:self-reproduction` with `--endpoint` to run the checked-in
brief through the public Streamable HTTP MCP endpoint. The driver calls only
`autograph_start`, `autograph_get`, `autograph_respond`, and `autograph_send` as
needed by the conversation. It does not invoke internal workflow stages or
create an eval-specific candidate runtime.

For local development, start the normal stack with `mise run dev`, then run:

```sh
mise run eval:self-reproduction -- \
  --endpoint http://127.0.0.1:64613/mcp \
  --output-dir /absolute/external/evidence/public-baseline
```

Supply the actual MCP URL for the service under test. The same driver can target
a reachable GitHub acceptance environment; it does not depend on a local
candidate checkout. Keep its output directory outside the reference source
tree. A new baseline requires a new directory.

When the product returns structured `inputRequests`, create a JSON response file
containing an array with one entry for each exact request ID. Approval requests
use `{ "kind": "approve" }` or `{ "kind": "deny" }`; question responses use
`{ "kind": "answer", "value": "..." }` and may include an `optionId` from the
request. For example:

```json
[
  {
    "requestId": "request-from-inputRequests",
    "response": { "kind": "approve" }
  }
]
```

Then resume the same run:

```sh
mise run eval:self-reproduction -- \
  --endpoint http://127.0.0.1:64613/mcp \
  --output-dir /absolute/external/evidence/public-baseline \
  --resume \
  --responses-file /absolute/external/evidence/product-responses.json
```

If the Builder asks an ordinary chat question without an `inputRequests` card,
put only the user reply in a text file and resume with `--message-file` instead.
Do not include evaluator feedback, internal stage prompts, reference material,
or code repair instructions.

```sh
mise run eval:self-reproduction -- \
  --endpoint http://127.0.0.1:64613/mcp \
  --output-dir /absolute/external/evidence/public-baseline \
  --resume \
  --message-file /absolute/external/evidence/recovery-reply.txt
```

The public driver also accepts positive integer `--timeout-ms` and `--poll-ms`
values. It preserves private continuation state in `state.json` and writes
sanitized `report.json`, `report.md`, `index.html`, and public transcript
records. Do not publish private continuation state, bearer URLs, credentials, or
unsanitized transport data. A completed public session still needs independent
assessment of the delivered app.

## Observe the delivered preview

After the public session returns a working preview, use its private continuation
state to observe the existing URL before expiry:

```sh
mise run eval:self-reproduction-observe -- \
  --state-file /absolute/external/evidence/public-baseline/state.json \
  --output-dir /absolute/external/evidence/browser-observation
```

An optional `--brief-file /absolute/path/to/synthetic-brief.txt` fills a matching
accessible app-brief/description field and records its actual value and whether
Continue becomes enabled. It never clicks Create, connects providers, or
publishes. `--timeout-ms` bounds each browser operation.

This command captures the existing three desktop sizes, visible controls, and
browser failures, then writes sanitized HTML, Markdown, JSON, and screenshots.
It does not start a candidate runtime, install dependencies, modify generated
files, send another Builder message, or provide implementation feedback. Keep
`state.json` private: it contains the launch capability. Missing or expired
previews and partial browser failures remain explicit in the report.

These candidate-only observations do not earn paired visual, authenticated
workflow, persistence, child-creation, or framework credit. They provide a
repeatable first check of what the delivered app actually lets a user do.

## Observe final source without changing the candidate

After generation stops producing changes, resolve the delivered preview's
owner-scoped Sandbox name and applied repository root from its retained product
state. Observe that existing running Sandbox with:

```sh
mise run eval:self-reproduction-source -- \
  --sandbox-name EXISTING_PROVIDER_SANDBOX_NAME \
  --source-root ABSOLUTE_APPLIED_REPOSITORY_ROOT \
  --output-dir /absolute/external/new-source-observation
```

The observer uses managed project OIDC and supported filesystem reads. It does
not install, launch, repair, or send workflow instructions. A stopped Sandbox
blocks observation; the observer does not explicitly resume it. The SDK may
still auto-resume if the Sandbox stops between the state check and a read, and
that limitation is recorded. Preview lifecycle remains owned by the product.

The owner-private manifest inventories dotfiles, regular files, directories,
link targets, hashes, modes, and explicit runtime exclusions. It reads raw
bytes twice for comparison (only the first scan is saved) and reports changing
or unreadable source as incomplete. Links are not followed or recreated. A
stable result proves only the declared source scope, not an atomic snapshot or
unobserved dependency/link contents. Review and sanitize the retained material
before including it in a portable report; never publish private continuation
state or credentials.

Preview observation also writes a WebSocket lifecycle sidecar with sanitized
origins and creation/error/close events for each desktop capture. Playwright
creation is not proof of a successful handshake and exposes no close code.
Neither these events nor their absence establish HMR or functional correctness;
the report keeps that broader transport coverage unassessed.

## Comparison and supplementary assessment

Comparison is observation after generation. It must use the unchanged result
from the public session and equivalent synthetic states for the reference and
candidate. Functional receipts require evaluator-owned browser actions and
server readback where appropriate. Missing controls or effects fail; unavailable
fixtures block; states that were never exercised remain unassessed. Paired
captures may compare hierarchy, layout, typography, controls, spacing, desktop
resizing, keyboard interaction, and loading, empty, and error states without
turning visual similarity into functional credit.

The retained offline combiner consumes the legacy parity-report schema; it does
not accept a public driver's `report.json` directly. Once evaluator observation
has produced a retained run directory containing valid `parity-evidence.json`,
`report.json`, and `revisions.json`, combine it with a source-review directory
containing the `self-reproduction-source-review/v1` `observations.json` and its
referenced evidence without rerunning generation or either application:

```sh
mise run eval:self-reproduction-report -- \
  --run-dir /absolute/path/to/retained-run \
  --source-review-dir /absolute/path/to/evaluator-source-review \
  --output-dir /absolute/external/new-supplementary-report
```

`--reference-captures-dir`, `--reference-run-dir`, and
`--candidate-navigation-run-dir` may add separately retained evaluator evidence.
Reference captures must include `capture-provenance.json`. The combiner copies
provenance and referenced artifacts, retains conflicting failures, and cannot
award browser credit from source findings. Its JSON, Markdown, and HTML outputs
identify themselves as supplementary assessments.

## Historical diagnostic tooling

`scripts/eval-self-reproduction.mts`, its candidate/reference runtime launchers,
capability probes, capture adapters, workflow adapters, and the former
self-hosted generation workflow are retained for historical diagnostic evidence
and comparison implementation support. They are not the supported
self-reproduction acceptance driver and must not be used to generate or repair
a qualifying baseline. In particular, `--report-only`, `--candidate-runtime`,
`--reference-runtime`, URL injection, and adapter-selection flags belong to that
legacy harness rather than the public-user run above.

Historical transcripts, reports, probes, screenshots, and source revisions
remain useful when labeled with their original provenance. Do not relabel a
staged internal run, evaluator-hosted candidate, infrastructure probe, or
candidate-authored validation claim as out-of-box product evidence. They may
explain a failure or support a later comparison, while the public transcript and
delivered working preview remain the generation record.

Technical maintainers can find the retained paired-capture implementation in
`evals/support/self-reproduction-captures.ts`, the default semantic bindings in
`evals/self-reproduction/default-capture-adapter.ts`, and trusted workflow
bindings in `evals/self-reproduction/workflow-adapter.ts`. Reference
instant-navigation collection lives in
`evals/support/self-reproduction-reference-navigation.ts` and delegates to the
repository's focused production-navigation task. These components can preserve
historical comparison evidence; they are not alternate public generation paths.

## Shared product readback evidence

The normal Builder can use `verify_app_behavior` for an implemented app-owned
JSON write/read workflow. This is a shared product capability, not an eval
control surface: the public eval must not invoke it or supply its scenarios.
Builder chooses the actual routes from its implementation and binds the check
to an accepted walkthrough outcome. The verifier supplies a synthetic value,
executes a write, and compares a separate read with that value.

This evidence covers only action and readback. It does not establish persistence
across a process restart, authentication, tenant isolation, independent child
generation, or browser usability. An overall product assessment remains
unassessed until its required behaviors have independent evidence. A failed
readback remains a failure even when the write returned success. Evaluator-owned
observations must still exercise the delivered app as a user; Builder's partial
checks do not replace that comparison.

## Resume and cross-eval coverage

See [the handoff](self-reproduction-handoff.md) for the frozen baseline, landed repairs, and ordered remaining work. The [cross-eval assessment](cross-eval-regression-2026-09-14.md) records exact-revision CI evidence, additional executions, and coverage limits across other products. Shared repairs must preserve those capability families; self-reproduction results do not replace their checks.

### Capture delivered previews during public polling

The public driver starts the existing preview observer as soon as each validated
working-preview receipt arrives. Polling and ordinary product questions continue;
observer processes are awaited before the driver exits. Use
`--no-preview-observation` to explicitly disable automatic capture.

Evidence lives under the external run directory's `preview-observations/`.
`ledger.json` records receipt hashes and capture states without capability URLs.
Each receipt has an owner-private `private/state.json` and separate `capture/`
output. Do not share private snapshots. A finished observer process is not a
functional pass: inspect its assessment and coverage. Expired receipts, failed
captures, and interrupted captures remain recorded; resume does not silently
rerun them. Capture failures do not alter public session outcomes, supply replies,
or grant approvals. The observer neither launches nor repairs the candidate.

Automatic captures have a three-minute runner deadline. On timeout the driver
terminates its owned observer process group (including its browser children),
records `timed_out`, and finishes the public run without changing its outcome.
The public report links the capture index and sanitized ledger. The ledger keeps
runner exit codes, start/finish timestamps, and relative report paths; product
findings remain in each separate capture report. Private snapshots contain only
source revision, outcome, and session preview metadata, not prompts or replies.
