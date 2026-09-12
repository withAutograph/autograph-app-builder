# App Builder self-reproduction baseline gaps

Date: 2026-09-12

The live self-reproduction eval completed through the reviewed phase using the
real App Builder model, the canonical Arrusted source, project-scoped Vercel
OIDC, and Vercel Sandbox. The final acceptance run passed 13 of 13 harness
gates in 9 minutes 7 seconds. The successful terminal state does not erase the
self-corrections and runtime warnings observed along the way; these are the
baseline gaps to repair.

No generated code was manually patched and no evaluator feedback was supplied
during the run.

## G1: UI preview composition guidance and catalog agreement

- **Priority:** High
- **Status:** Confirmed
- **Expected:** The model's first preview composes supported public Arrusted
  primitives and imports only symbols present in the preview catalog manifest.
- **Observed:** `record_ui_preview` first rejected the generated preview with
  `Local workflow components must compose public Arrusted primitives.` A later
  attempt referenced `@autograph/components#buttonClassName`, which the preview
  validator reported missing from its catalog manifest.
- **Evidence:** Live self-reproduction runs on 2026-09-12; validation originates
  in `lib/agent/ui-preview.ts`.
- **Likely layer:** Design skill instructions, public component discovery, and
  preview catalog generation/validation.
- **Repair:** Make supported composition and exact exports discoverable before
  preview authoring. Keep validation strict. Add focused generation cases that
  fail if the first preview uses local replacement controls or unavailable
  exports.
- **Acceptance:** The self-reproduction design turn records a valid preview on
  its first attempt, and focused preview tests cover both failure classes.

## G2: AppSpec structure and provider-neutral capability identifiers

- **Priority:** High
- **Status:** Confirmed
- **Expected:** The first build-ready AppSpec contains every required heading,
  ends with the exact Build handoff block, and uses provider-neutral optional
  capability identifiers.
- **Observed:** `accept_app_spec` rejected initial drafts for missing required
  sections and invalid Build handoff structure. Subsequent planning rejected
  `optionalCapabilities.integrations` because entries were provider-specific.
- **Evidence:** Repeated `app_spec_invalid` results and `AppSpec Build
  handoff.optionalCapabilities.integrations entries must be provider-neutral
  identifiers` in the live baseline.
- **Likely layer:** AppSpec authoring instructions, examples, and preflight
  normalization before the planning command.
- **Repair:** Give the model one canonical complete skeleton and make the
  provider-neutral identifier rule explicit at authoring time. Add focused live
  and deterministic cases for complete first-attempt AppSpecs.
- **Acceptance:** A product brief mentioning GitHub and Vercel produces a valid
  AppSpec on its first `accept_app_spec` call without weakening the parser.

## G3: Long-running Eve eval resource lifecycle

- **Priority:** Medium
- **Status:** Confirmed symptoms; root causes unconfirmed
- **Expected:** A completed or interrupted eval releases its local listener,
  removes its prewarm lock, and shuts down development sandbox resources without
  warnings.
- **Observed:** Interrupted runs left a dead-owner template prewarm lock, causing
  later runs to wait until manually cleared. One completed run left its local
  Eve listener alive. Longer tool loops emitted `MaxListenersExceededWarning`.
  Shutdown repeatedly reported Microsandbox migrations recorded in the local
  database whose migration files were absent.
- **Evidence:** Dead prewarm lock owner PID 17158; stale listener on port 54589;
  repeated stream listener and migration diagnostics during the baseline.
- **Likely layer:** Eve development host shutdown, stream subscription cleanup,
  and the installed Microsandbox runtime/database version boundary.
- **Repair:** Reproduce each symptom independently, fix ownership and cleanup in
  the narrowest responsible layer, and retain diagnostics when an upstream Eve
  or Microsandbox defect cannot be fixed here.
- **Acceptance:** Two consecutive self-reproduction evals can run without manual
  cleanup; an interrupted run can be restarted immediately; no listener or
  migration warnings remain.

## G4: Durable baseline evidence and comparison output

- **Priority:** High
- **Status:** Confirmed
- **Expected:** Every local and GitHub run retains prompt, answer sheet, model
  settings, revisions, transcript/tool outcomes, generated files or an explicit
  unavailable marker, elapsed time, paired captures, and HTML, Markdown, and
  JSON comparison reports.
- **Observed:** The native Eve path now runs reliably and GitHub captures its JSON
  and log output, but it is not yet connected to the existing comparison report
  builder. The reviewed sandbox change set is not exported as a candidate tree,
  so visual and framework comparison remain unassessed.
- **Evidence:** `.config/mise/tasks/eval/self-reproduction`,
  `.github/workflows/self-reproduction.yml`, `evals/self-reproduction.eval.ts`,
  and `scripts/eval-self-reproduction.mts` currently represent two incomplete
  halves of the intended pipeline.
- **Likely layer:** Eval orchestration and artifact export/report assembly.
- **Repair:** Make the native eval emit a sanitized machine-readable receipt and
  export the reviewed candidate without publication. Feed that output into the
  existing evaluator and preserve partial reports on every failure path.
- **Acceptance:** One command produces a timestamped external evidence directory
  containing JSON, Markdown, HTML, transcript, candidate inventory, and paired
  captures when runtimes are available. GitHub uploads the same directory even
  when generation or judging fails.

## Coordination

Each repair should be developed in its own Codex worktree. Do not modify the
baseline product brief to hide a failure. Keep parser and preview validation
strict, keep live generation opt-in, and avoid publication or provider effects.
After integrating all repairs, run focused checks once, then one live
self-reproduction acceptance run and compare its self-correction history with
this baseline.
