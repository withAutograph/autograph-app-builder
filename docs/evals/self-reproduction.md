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
