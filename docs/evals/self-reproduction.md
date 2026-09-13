# Self-reproduction evidence

Run the opt-in native Eve benchmark with the canonical Arrusted checkout:

```sh
mise run eval:self-reproduction -- --arrusted-root /absolute/path/to/arrusted-development
```

The command retains strict native assertions. It does not publish or deploy.
Project-scoped Vercel OIDC and the existing native Sandbox eval prerequisites
must already be configured. `SELF_REPRODUCTION_ARRUSTED_ROOT` can supply the
checkout instead of the argument.

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

The report labels an operator-supplied candidate separately from the live
generation that produced it. Credentials and dependencies are never copied.
Runtime workflow claims require evaluator-owned receipts; candidate-authored
workflow summaries, static source matches, configuration flags, and generic
screenshots do not prove them.

Paired captures require both URLs and installed Playwright Chromium. The command
captures the existing comparison viewports and retains partial capture files if
one fails. It does not start either app or infer their authentication/session
state. Missing URLs or unavailable runtimes remain unassessed or blocked in all
report formats. Native live acceptance and paired captures are separate from the
focused deterministic checks below:

```sh
mise run test:unit -- evals/support/self-reproduction.test.ts \
  evals/support/self-reproduction-evidence.test.ts \
  scripts/eval-self-reproduction.test.ts
```
