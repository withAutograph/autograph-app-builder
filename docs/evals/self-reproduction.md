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

Candidate export remains explicit: the native eval currently has no candidate
export API wired to its reviewed sandbox change set. The report therefore writes
an unavailable marker and blocks candidate framework/workflow conclusions. A
successful native eval is not a successful visual comparison.

For an independently exported candidate and running reference/candidate runtimes:

```sh
mise run eval:self-reproduction -- --report-only \
  --candidate-root /absolute/path/to/exported-candidate \
  --reference-url http://localhost:3000 \
  --candidate-url http://localhost:3001 \
  --output-dir /absolute/external/evidence/comparison
```

The report retains the audited candidate source files, labels them as an
operator-supplied export, and optionally reads
`self-reproduction.workflow-results.json`. Audited files are a source snapshot,
not a complete runnable export. Credentials, dependencies, and hidden files are
not copied. Runtime workflow claims still require corresponding evidence;
static source matches and paired screenshots do not prove those claims.

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
