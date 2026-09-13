# Self-reproduction evidence

Run the opt-in native Eve benchmark with the canonical Arrusted template:

```sh
mise run eval:self-reproduction
```

The command retains strict native assertions. It does not publish or deploy.
Project-scoped Vercel OIDC and the existing native Sandbox eval prerequisites
must already be configured. Without an explicit checkout, the command clones
canonical Arrusted `main` into `<output-dir>/runtime-source/arrusted-development`
using Git's existing credential helper. Configure Git access to the template
repository locally or in GitHub before running; no static credentials are added
by the evaluator. The report records the resolved revision and remote.

Use `--arrusted-root /absolute/path/to/arrusted-development` or
`SELF_REPRODUCTION_ARRUSTED_ROOT` to reuse an explicit checkout without fetching
or modifying it. `--report-only --candidate-runtime` also acquires the canonical
template when no checkout is supplied because the runtime needs its workspace.
Report-only runs without candidate runtime and custom generators without
candidate runtime skip automatic cloning.

The command prints a timestamped evidence directory beneath the system temporary
directory. Use `--output-dir /absolute/external/evidence/run-name` or
`SELF_REPRODUCTION_OUTPUT_DIR` to retain it in a longer-lived location. Output
must be outside the App Builder source tree. GitHub uploads this same directory
with `if: always()`; no second report-generation path is used.

The bundle contains the unchanged brief and fixed answer sheet with hashes,
model/configuration source snapshots, Git revisions and working-tree status,
settings, sanitized incremental transcript and tool outcomes, native result JSON,
diagnostics, elapsed time, candidate inventory, and JSON/Markdown/HTML reports.
Initial reports are written before generation. Failure, missing native output,
strict assertion failures, and incomplete transcripts cannot become generation
success. Completed turns and in-flight event checkpoints survive failures;
SIGINT/SIGTERM and the generation deadline terminate the launcher process group
and finalize partial reports. A hard kill can leave the initial reports plus the
incremental transcript for later inspection.

Candidate export is evidence-aware. A passing run retains the complete reviewed
application tree, including scaffold-owned package, Next, Turbo, and hk contracts,
while excluding dependencies and build output. A validation failure retains the
applied text source as explicitly unreviewed diagnostic evidence, so framework and
implementation gaps can still be assessed without treating the candidate as
successful. Binary artifacts are listed as omissions rather than decoded as text.

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

The self-hosted GitHub workflow uses the same checked-in adapter. Optional
repository or environment variables `REFERENCE_URL` and `CANDIDATE_URL` become
`SELF_REPRODUCTION_REFERENCE_URL` and
`SELF_REPRODUCTION_CANDIDATE_URL`. `WORKFLOW_ADAPTER_MODULE` can select a custom
module under `evals/`. The default native eval starts an isolated reference
runtime when no reference URL is supplied and attempts the exported candidate
in Vercel Sandbox. Local and GitHub runs use this same lifecycle. Report-only
runs start those runtimes only when `--reference-runtime` or
`--candidate-runtime` is requested; custom generators also require those flags.
The reference runtime requires the mise-owned entrypoint and its local database
prerequisites. Runtime startup errors remain visible in the retained report.

The report labels an operator-supplied candidate separately from the live
generation that produced it. Credentials and dependencies are never copied.
Runtime workflow claims require evaluator-owned receipts; candidate-authored
workflow summaries, static source matches, configuration flags, and generic
screenshots do not prove them.

The authoritative paired capture matrix requires both reachable URLs and
installed Playwright Chromium. The candidate Sandbox stays alive while its
in-Sandbox callback captures diagnostic root/documentation screens at the
existing desktop viewports; this loopback URL is not exposed to the host browser.
Those diagnostic captures do not establish authenticated or seeded-state parity.
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
`mise run test:production-navigation -- --reporter=json` lifecycle. Its JSON
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
