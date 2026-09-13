# Self-reproduction live acceptance, 2026-09-13

This record covers the single live acceptance generation retained at
`/private/tmp/app-builder-self-reproduction-true-eval-20260913-r12` and the
latest report-only runtime replay retained at
`/private/tmp/app-builder-self-reproduction-true-eval-20260913-r12-runtime-v12`.
The generated source was not patched and no generation reroll was selected.

## Outcome

The real-model generation used `openai/gpt-5.6-terra`, ran for 624,459 ms, and
completed the bounded approval sequence. The model applied 41 changed files;
the evaluator exported a 38-file independent candidate as unreviewed diagnostic
evidence. Total eval elapsed time was 665,295 ms.

The strict generation gate failed during repository validation:

- `check-build` passed.
- The test shard failed because Vite could not resolve
  `@autograph/components` from `app/components/BuilderClient.tsx` while loading
  `app/__tests__/page.test.tsx`.
- The workflow remained in `validation_failed`; the candidate was never marked
  reviewed or accepted.

The latest report-only replay reconstructed the repository in a fresh
project-scoped Vercel Sandbox and reached the candidate's declared production
build. Dependency installation, pinned toolchain installation, microfrontend
configuration generation, and candidate route registration all completed.
Next.js 16.3.0 compiled the candidate and completed TypeScript checking, then
failed while prerendering `/_global-error`:

```text
InvariantError: Invariant: Expected workStore to be initialized.
Export encountered an error on /_global-error/page: /_global-error
```

The build also emitted a non-fatal PostCSS warning for the Arrusted shared
theme's `@theme` rule. Because the production server never started, the eval
could not execute candidate workflows, framework browser assertions, or paired
visual captures. This is an observed candidate/runtime compatibility failure;
the evidence does not establish whether the defect belongs exclusively to the
generated files, the reference stack, or their composition.

## Harness findings and repairs

The repeated report-only replays isolated and repaired harness defects without
changing the candidate:

- Installed the complete pinned development toolchain, including Node, Bun,
  Mise, Cargo, Rust, and the Rust standard library.
- Retained report-only files such as `hk.pkl` and allowed the disposable
  workspace to materialize its Bun lockfile.
- Invoked the candidate's declared build instead of an aggregate Turbo graph
  that introduced a cyclic `extends` relationship.
- Generated microfrontend configuration and registered the candidate route in
  the active canonical workspace configuration.
- Wrote evaluator scripts through structured Sandbox file APIs, avoiding
  multiline command interpolation.
- Preserved the candidate export, transcript, settings, revisions, tool
  outcomes, runtime commands, and failures when later phases could not run.

These repairs moved the runtime result from missing-tool and workspace setup
failures to a real Next.js production build failure in the untouched candidate.

## Evidence limits

The `runtime-v12` machine report contains 76 requirements. All 37 in-scope
candidate requirements are marked `failed`: 11 workflows, 11 framework rows,
and 15 visual-state captures. Candidate anonymous entry is the sole unassessed
candidate row, matching the current cleanup priority. All 38 reference rows are
unassessed because this report-only replay did not receive a running reference
URL. Runtime infrastructure failures use the separate `blocked` classification.

No visual similarity score is available. The absence of paired screenshots is
not evidence of visual parity. No authenticated workflow, durable draft
readback, provider callback return, app creation, preview, cancellation, retry,
session recovery, keyboard behavior, panel resizing, or instant navigation
assertion ran against the candidate. The reference-side adapters exist, but
this generation run did not supply a reference URL, so their corresponding
runtime observations also remain unassessed.

Actual hosted publication and provider provisioning remain unverified, as
required by the baseline scope.

## Prioritized remaining gaps

1. **Generated candidate validation failure.** Expected: generated source passes
   the repository test contract before review. Observed: unresolved
   `@autograph/components` import. Evidence: `native-result.json`. Likely layer:
   generated test/module-resolution composition. Recommended repair: improve
   Builder generation and validation feedback so imports used by generated
   components resolve under the repository's Vitest configuration.
2. **Generated candidate production build failure.** Expected: the candidate
   builds and starts independently in Vercel Sandbox. Observed: Next.js fails
   prerendering `/_global-error` after compile and typecheck. Evidence:
   `candidate-runtime.json` from `runtime-v12`. Responsible layer is not yet
   confirmed. Recommended repair: reproduce this exact candidate/reference
   combination in a focused build investigation and assign the fix only after
   locating the invalid boundary.
3. **Executable comparison.** Expected: matching reference and candidate states
   produce workflow receipts and paired captures at all configured desktop
   viewports. Observed: no candidate server was available. Evidence:
   `candidate-runtime.json` and the empty capture set. Likely layer: downstream
   consequence of gap 2. Recommended repair: rerun report-only assessment after
   the responsible product/runtime fix; do not patch this baseline candidate or
   claim scores from source inspection.
