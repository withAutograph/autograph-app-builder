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

1. **Arrusted template import resolution (confirmed cause).** The generated
   Vitest configuration exactly reproduced the template, which omitted
   `resolveWithTsconfigPaths()`. `@autograph/components` is a supported root
   TypeScript alias, not a missing installable package. A fresh GitHub clone and
   a Vite transformation regression reproduced the failure without the resolver
   and passed with it. Repair the canonical template; do not attribute this
   failure to the model or manually repair the baseline candidate.
2. **Arrusted framework and CSS setup (confirmed defects).** The repository
   declared Next 16.3.4 but overrode it to 16.3.0. Generated apps also omitted
   PostCSS configuration and could not inherit it from the sibling Vendor app.
   Align the intended Next version and emit the canonical Tailwind PostCSS
   configuration from the template. These defects are established; neither is
   yet a confirmed cause of the prerender invariant.
3. **Production prerender failure (cause unresolved).** Preserve the candidate
   and capture an explicit diagnostic build with `--debug-prerender`. Diagnostic
   success cannot replace a passing normal production build. Compare against
   an independently generated clean starter to distinguish template/runtime
   failures from generated application failures.
4. **Executable comparison (independent harness defects).** Runtime cleanup
   currently precedes the comparison; the entrypoint does not automatically
   start the reference, and the framework runner is not wired into it. Several
   candidate workflows always fail when evaluator fixtures are missing; some
   reference/framework assertions claim more than their evidence proves.
   Keep runtimes alive through comparison, bind equivalent authenticated
   fixtures and readbacks, and distinguish missing evaluator support from
   observed missing product behavior. A successful candidate build alone does
   not close this gap.

The earlier machine report's blanket prerequisite failures are retained as
historical output, not 37 independently observed product defects. Template
repairs and diagnostic replays must retain their own source revisions and
artifacts; the original generated source remains unchanged.

## Clean starter setup follow-up

A new clone of `withAutograph/arrusted-development` was used for the template
repair and a second disposable clone for acceptance. The canonical generator
created `setup-proof`; the generated workspace was then installed before
validation. Production typecheck/build, the generated unit test, production
startup, and HTTP 200 passed. Root and app resolve the same physical Next
16.3.4 installation. Local evidence is retained under
`/private/tmp/arrusted-template-acceptance-aligned-20260913`.

The stale template also pinned older Node type dependencies, producing a
different Sharp/Next peer closure, and the Vite-plus catalog lagged the root
version. Aligning those dependencies removed the observed post-install Vite
configuration type errors in the new starter. Arrusted repairs are submitted
in PR 1360. This establishes starter setup, not acceptance of the original
replica or proof that its historical prerender failure is fixed.

The first clean-starter Sandbox replay passed installation and production
build. Its startup probe failed because the evaluator supplied CLI port flags
that the repository runner ignores; that runner uses `PORT`. The evaluator
now supplies `PORT=3000` and retains startup output. Browser comparison now
has a callback inside the Sandbox lifetime, preserving diagnostic screenshots
before cleanup. These diagnostic captures do not earn seeded workflow or
visual-state parity credit.
