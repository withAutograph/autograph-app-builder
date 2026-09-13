# Self-reproduction live acceptance, 2026-09-13

This record covers the single live acceptance generation retained at
`/private/tmp/app-builder-self-reproduction-true-eval-20260913-r12` and the
latest report-only runtime replay retained at
`/private/tmp/app-builder-self-reproduction-true-eval-20260913-r12-runtime-v9`.
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
failed while prerendering `/_not-found`:

```text
InvariantError: Invariant: Expected workStore to be initialized.
Export encountered an error on /_not-found/page: /_not-found
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

The current `runtime-v9` machine report contains 76 requirements, all marked
`unassessed`, even though the candidate production build failed. That status is
not an acceptable final interpretation: candidate requirements that require a
runnable app must be reported as failed due missing functionality, while
infrastructure failures must remain blockers. Anonymous entry is intentionally
outside the current cleanup priority.

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
   prerendering `/_not-found` after compile and typecheck. Evidence:
   `candidate-runtime.json` from `runtime-v9`. Responsible layer is not yet
   confirmed. Recommended repair: reproduce this exact candidate/reference
   combination in a focused build investigation and assign the fix only after
   locating the invalid boundary.
3. **Failure classification.** Expected: unavailable candidate behavior caused
   by a candidate build failure is failed, with artifact-backed reasons.
   Observed: the current machine report leaves all 76 rows unassessed. Evidence:
   `report.json` from `runtime-v9`. Likely layer: evaluator runtime fallback
   mapping. Recommended repair: synthesize evaluator-owned failure observations
   for affected candidate rows while preserving explicit observations and
   blocker semantics.
4. **Executable comparison.** Expected: matching reference and candidate states
   produce workflow receipts and paired captures at all configured desktop
   viewports. Observed: no candidate server was available. Evidence:
   `candidate-runtime.json` and the empty capture set. Likely layer: downstream
   consequence of gap 2. Recommended repair: rerun report-only assessment after
   the responsible product/runtime fix; do not patch this baseline candidate or
   claim scores from source inspection.

