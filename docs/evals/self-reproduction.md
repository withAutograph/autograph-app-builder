# Self-reproduction evidence

## Current status and acceptance contract

The existing staged native Eve runs and comparison reports provide diagnostic
findings about generated output, template setup, and infrastructure. They do
**not** establish that an ordinary user can ask App Builder to reproduce itself
out of the box. Preserve those artifacts and their original source revisions,
prompts, stage inputs, and candidate bytes; do not relabel them as product-level
baseline evidence. A passing infrastructure probe or internal stage is not a
passing product workflow.

A qualifying self-reproduction run starts with one checked-in product brief
submitted through the supported web App Builder or the
[five public MCP tools](../public-mcp-contract.md). Subsequent input is limited
to ordinary product questions answered from the fixed answer sheet and normal
approval replies. A test client may perform these public interactions
programmatically for expedience and reproducibility; manually clicking or opening
a fresh Codex task is not an acceptance requirement. This permission does not
extend to internal workflow APIs or stage control. Record each response. Do not
provide reference source,
screenshots, evaluator findings, manual implementation assistance, or internal
stage instructions to the generator.

The brief requests a complete independent working replica. The ordinary shared
Builder workflow must clone the canonical Arrusted repository, install and set
up its dependencies, plan, implement, recover from errors, and validate the
result. The evaluator must not replace those responsibilities by preparing a
candidate workspace or driving internal Eve planning and implementation stages.
If a necessary step is missing, repair the shared product workflow and test it
through the same supported entrypoint. Do not add an eval-only implementation
path, hosting service, or orchestration layer to bypass the missing behavior.

The evaluator may prepare isolated synthetic users and provider emulators,
observe the normal workflow, retain evidence, and independently start the
exported output for comparison. These comparison fixtures must remain outside
generator input. They must not repair the output or earn credit for generated
functionality: an independently launched candidate and an evaluator-created
Sandbox prove only their recorded infrastructure assertions.

Completion requires evidence from that product-level run and an assessment of
the full requested replica, including its own persistence and orchestration and
its creation of one small independent app through its own backend. Report each
requirement as passed, failed, blocked, or unassessed. Missing functionality is a
failure; unavailable infrastructure is a blocker. Neither infrastructure success
nor internal-stage success substitutes for product behavior. Keep visual scores
advisory, preserve partial results, and report remaining evidence gaps explicitly.
Anonymous entry is excluded from the current repair scope. Hosted publication
and provisioning remain unverified unless separately authorized and exercised.

## Public entrypoint driver and retained diagnostics

The old staged native Eve driver and its self-hosted GitHub workflow are retired.
The public driver, `scripts/self-reproduction-public.mts`, submits
[the product brief](../../evals/self-reproduction/brief.md) through the supported
Streamable HTTP MCP endpoint. It behaves as an ordinary user client: start one
request with `autograph_start`, observe with `autograph_get`, and use
`autograph_respond` only for actual product questions and approvals. It does not
call internal Eve stages, prepare the candidate, or repair generated code.

Use the existing supported App Builder service and its ordinary authentication.
For local development, keep the normal `mise run dev` stack running. The public
driver does not create an eval-specific hosting service or substitute an internal
agent runner when the public connection is unavailable.

```sh
mise run eval:self-reproduction -- \
  --endpoint http://127.0.0.1:3000/mcp \
  --output-dir /absolute/external/evidence/public-baseline
```

Supply the actual supported MCP URL for the running service. The example port is
illustrative, not a separate eval listener. Generated files, runtime state, and
evidence must remain outside the reference source tree.

When the product asks a question, answer from the
[fixed answer sheet](../../evals/self-reproduction/answers.json), preserving the
actual `requestId` values and the complete request batch in `--responses-file`.
Only approve effects within the benchmark's existing authorization. Connection
or authorization cards must use the normal product flow; a text reply cannot
pretend a provider was connected. Do not append internal implementation advice,
stage prompts, reference material, or evaluator feedback to an answer.

```sh
mise run eval:self-reproduction -- \
  --endpoint http://127.0.0.1:3000/mcp \
  --output-dir /absolute/external/evidence/public-baseline \
  --resume \
  --responses-file /absolute/external/evidence/product-responses.json
```

Resume the saved public session and cursor rather than creating a better reroll.
Keep the prompt, public transcript, requests and replies, outcome, and errors as
original generation evidence. Missing authentication, an unavailable endpoint,
or an unanswered product request must retain partial evidence and an explicit
blocked outcome. Successful submission is not successful self-reproduction:
only the returned product behavior and unchanged candidate can establish that.

After the public run, `mise run eval:self-reproduction -- --report-only` compares
the exported output. This comparison command does not start internal generation.

Historical native transcripts, source revisions, reports and setup probes remain
useful diagnostics. They are not relabeled as product-level baseline evidence.
A new public-flow result must identify its actual entrypoint, initial brief,
ordinary replies, product outcome and any missing evidence. No such qualifying
run has yet been established by the existing staged reports.

Comparison output belongs outside the Builder source tree. Use
`--output-dir /absolute/external/evidence/run-name` to choose its location.
`--report-only --candidate-runtime` may acquire canonical Arrusted to start an
unchanged exported candidate for independent inspection. This is observer setup
and earns no credit for Builder cloning, installation, or generated behavior.

To rebuild and start an independently exported candidate in a fresh,
evaluator-owned Vercel Sandbox, using the same tracked Arrusted workspace and
project-scoped Development OIDC boundary:

```sh
mise run eval:self-reproduction -- --report-only \
  --candidate-root /absolute/path/to/exported-candidate \
  --arrusted-root /absolute/path/to/arrusted-development \
  --candidate-runtime \
  --output-dir /absolute/external/evidence/comparison
```

The runtime phase uses allow-all networking for toolchain and dependency setup,
runs the repository-owned application build, starts the production candidate,
and probes its declared base path and documentation route from inside the
sandbox. It records bounded command output in `candidate-runtime.json`. Runtime
startup is a prerequisite, not workflow credit. Deeper workflows remain
unassessed until trusted browser adapters exercise them.

While the candidate Sandbox remains alive, the evaluator also runs the supported
candidate workflow and desktop interaction fixtures. Unknown generated layouts
remain unassessed until an evaluator adapter is supplied. Documentation uses the
actual visible navigation control; a guessed `/docs` response is diagnostic only.

To retain the reference's isolated production-navigation JSON evidence, opt in with
`--reference-navigation`, or reuse an existing evaluator output directory with
`--reference-navigation-evidence /absolute/path/to/reference-navigation`.
Reused evidence retains its original source snapshot, revision, and timestamps;
it is not represented as a new production test run.

For already-running reference and candidate URLs, add `--reference-url` and
`--candidate-url`. This retains generic design captures and executes the
authoritative paired state matrix with the checked-in semantic adapter. An
evaluator-owned custom adapter remains available for specialized fixture hooks:

```sh
mise run eval:self-reproduction -- --report-only \
  --candidate-root /absolute/path/to/exported-candidate \
  --reference-url http://127.0.0.1:3000 \
  --candidate-url http://127.0.0.1:3001 \
  --capture-adapter evals/self-reproduction/capture-adapter.ts \
  --output-dir /absolute/external/evidence/comparison
```

The adapter must live under `evals/` and export
`createCaptureAdapters({ referenceURL, candidateURL })`. Each side implements
the `CaptureAdapter` contract from
`evals/support/self-reproduction-captures.ts`. Generated output cannot supply
this module. The runner ingests the resulting evaluator-owned observations into
`parity-evidence.json` and writes an advisory side-by-side manifest at
`parity/captures/manifest.json`.
The default adapter treats absent required semantic controls as missing
functionality. It leaves loading, empty, and error states unassessed when the
URL does not expose an evaluator-owned fixture for that state; visiting a
landing page is not evidence that those product states are missing.

For functional workflow parity, the runner automatically loads the checked-in
`evals/self-reproduction/workflow-adapter.ts`. With the reference development
stack and a candidate runtime already running, use:

```sh
mise run eval:self-reproduction -- --report-only \
  --candidate-root /absolute/path/to/exported-candidate \
  --reference-url https://localhost:3001 \
  --candidate-url http://127.0.0.1:4173 \
  --output-dir /absolute/external/evidence/comparison
```

The reference binding uses the existing emulated OAuth/provider fixtures and
PostgreSQL readbacks for authentication, durable drafts, provider return, and
documentation. The candidate binding navigates its real URL and looks for
required controls by accessible role and name. Missing candidate controls are
failures; browser-only state cannot earn durable server-write credit. Reference
workflows that do not yet have a bounded evaluator fixture remain unassessed.

A specialized adapter can be selected with
`--workflow-adapter-module evals/path/to/workflow-adapters.mts`. The path must
remain under this repository's `evals/` directory. It exports
`createWorkflowAdapters({ referenceUrl, candidateUrl, outputRoot })` and returns
reference/candidate implementations of `TrustedBrowserWorkflowAdapter`. Each
adapter seeds through that side's real fixture boundary, drives the rendered
application, and performs evaluator-owned server readback. The runner writes
one receipt per side and workflow under `parity/workflows/` plus
`trusted-workflow-receipts.json`; receipts already written remain available
when a later adapter or report step fails. Missing product behavior fails,
unavailable fixture/browser infrastructure blocks, and omitted adapters remain
unassessed.

For an observation run, `SELF_REPRODUCTION_REFERENCE_URL` and
`SELF_REPRODUCTION_CANDIDATE_URL` can identify existing applications.
`--workflow-adapter-module` selects an evaluator module under `evals/`.
Only explicitly requested `--reference-runtime` and `--candidate-runtime`
comparisons start observer-owned runtimes. The reference runtime uses the
mise-owned entrypoint and its local database prerequisites. Runtime startup
errors remain visible in the retained report. The retired self-hosted workflow
is not an alternate route for generating the replica.

The report labels an operator-supplied candidate separately from the live
generation that produced it. Credentials and dependencies are never copied.
Runtime workflow claims require evaluator-owned receipts; candidate-authored
workflow summaries, static source matches, configuration flags, and generic
screenshots do not prove them.

The authoritative paired capture matrix requires both reachable URLs and
installed Playwright Chromium. The candidate Sandbox stays alive while its
in-Sandbox callback captures diagnostic root/documentation screens at the
existing desktop viewports; this loopback URL is not exposed to the host browser.
Supported candidate controls receive the shared synthetic draft before capture.
The isolated reference signs in through its emulator and confirms that same
draft through an owner-scoped PostgreSQL readback at each viewport. Its fixture
receipt is retained; authentication failure never falls back to an anonymous
screenshot. Matching visible inputs do not establish candidate authentication
or durable persistence. Unfamiliar candidate controls remain diagnostic.
Use a reachable candidate URL and equivalent evaluator-owned fixtures for the
host-side paired matrix. Partial screenshots survive later failures. Missing
fixtures and unavailable runtimes remain unassessed or blocked in all report
formats. Native live acceptance and captures are separate from the focused
deterministic checks below:

```sh
mise run test:unit -- evals/support/self-reproduction.test.ts \
  evals/support/self-reproduction-evidence.test.ts \
  scripts/eval-self-reproduction.test.ts
```

### Reference instant-navigation evidence

The bounded `runReferenceNavigationEvidence` collector uses the existing
`mise run test:production-navigation -- --json-report /absolute/path/report.json`
lifecycle. The coordinator supplies its absolute mise executable so stripped
application environments do not depend on finding mise on PATH. Its JSON
report and source snapshot identify the exact sign-in direct-load and prefetched
Sign In Link cases, including resolved controls after `instant()` releases
dynamic work. It emits only the reference `instant-navigation` receipt; it does
not award cache isolation, draft continuity, or other framework credit.

The collector retains Git revision, dirty status, source digest, timestamps, and
command errors under `reference-navigation/`. Missing or skipped exact tests
remain unassessed; actual assertion failures remain failures. An older text log
with an aggregate passing count is diagnostic evidence and cannot substitute
for the exact JSON test results. Collection is opt-in through the eval's
coordinator; do not repeat a production build solely to refresh an unchanged
report.

### Supplementary offline assessment

Combine a retained run with an evaluator-owned source review without running
generation or either application again:

```sh
mise run eval:self-reproduction-report -- \
  --run-dir /absolute/path/to/retained-run \
  --source-review-dir /absolute/path/to/evaluator-source-review \
  --reference-captures-dir /absolute/path/to/evaluator-reference-captures \
  --output-dir /absolute/external/new-supplementary-report
```

The optional reference captures must include `capture-provenance.json` naming
the retained screenshots. Original run metadata and evaluator review provenance
are copied alongside referenced artifacts. No runtime trees or environment files
are copied. Conflicting failed assertions remain failed; source-only findings
cannot provide browser credit. Missing referenced evidence remains unassessed.
The JSON, Markdown, and HTML outputs explicitly identify themselves as a
supplementary assessment. Initial screenshot pairs are diagnostic; their state
and authentication differences remain visible in the capture qualification.

### Candidate runtime access and infrastructure proof

The evaluator uses the linked project's short-lived Development OIDC for the
outer Sandbox and supplies only `VERCEL_OIDC_TOKEN`, `VERCEL_TEAM_ID`, and
`VERCEL_PROJECT_ID` to its candidate environment through the structured Sandbox
API. It never forwards the host environment or writes credentials into command
strings, source, or evidence. Raw credentials are redacted from retained runtime
and comparison diagnostics. Expiration and project validation remain owned by
the existing local OIDC entrypoint.

Native live runs also test infrastructure access with a small model request and
a child Sandbox sentinel command. A comparison-only replay can opt in:

```sh
mise run eval:self-reproduction -- --report-only \
  --candidate-root /absolute/path/to/preserved-candidate \
  --candidate-runtime --candidate-capability-probe --reference-runtime \
  --output-dir /absolute/external/new-comparison
```

`candidate-capability-proof.json` reports model access, child execution, and
child cleanup separately. Sandbox SDK tooling lives in evaluator scratch space;
the candidate implementation and dependencies are not patched. A successful
probe establishes infrastructure access, never independent app creation by the
candidate. Configured credentials alone remain unverified. Local file or SQLite
persistence is application-owned; no external database is implied or required.
A database-dependent implementation still needs a real isolated database setup.

Each browser or capability probe has its own artifact directory. A failed probe
cannot inherit a previous probe's JSON or screenshots. Empty-state checks clear
and refill real controls; loading credit requires an explicitly bound creation
request held in flight. Static progress labels and unsupported error fixtures
remain unassessed.

A repaired reference fixture can be rerun independently and combined with the
retained candidate assessment by adding
`--reference-run-dir /absolute/path/to/reference-only-run` to the supplementary
report command. Its reference observations and captures retain a separate
artifact namespace and source revision. It cannot replace candidate outcomes
or turn blocked reference evidence into passing assertions. The normal run's
authenticated capture receipts now supply screenshot pairing automatically;
external capture provenance remains supported for earlier runs.

Reference setup holds its local port reservations through installation and
checks both provider emulators as well as the authentication page before
reporting readiness. Evaluator callback errors are retained separately from
successful candidate startup, so a report-writing failure is not blamed on
the generated application.
