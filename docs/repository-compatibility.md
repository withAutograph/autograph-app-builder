# Repository compatibility

App Builder integrates with Arrusted through repository-owned mise commands and
their returned identity and execution receipts. The supported integration is the
Arrusted Next.js app workflow; source acquisition is not a promise that an
arbitrary framework has an implementation adapter.

The public commands remain:

```text
mise run repository:exec -- app-identity.ts --app <app-id>
mise run create:app <app-id>
mise run repository:preflight
mise run --skip-tools app:check <app-id>
mise run --skip-tools app:test <app-id> <shard>
```

The identity operation owns the app's package, project, workspace, routes, and
specification paths. Keep its required fields and safe repository-relative
paths. Preserve repository-owned project names and ignore additional producer
metadata. Do not infer compatibility from the generator's source code, its
physical location, package-name strings, root framework dependency declarations,
or a fixed inventory of implementation files.

Source inspection, layout observations, and preflight results are diagnostic
context, not prerequisites to acquiring a fresh starter. A missing named
“Template readiness” check does not prevent acquisition. Invoke supported
operations when needed and report their actual command failures with repair
instructions. A source-only V5 receipt records acquisition, not successful CI;
legacy V3/V4 receipts retain their original fields, digests, and recovery parsing.

Architecture observations are advisory. Repository checks and exercised product
behavior establish whether persistence, authentication, and tenant isolation work.
Keep path containment, app ownership, exact reviewed changes, conflict handling,
and approval boundaries: they protect writes and publication.

## Source, validation, and publication

- Local development reads the selected live checkout, including tracked and
  non-ignored edits. Normal changes produce a new planning input, not a drift
  rejection.
- Dependency reuse depends on dependency inputs, toolchain, bootstrap, and
  platform. Repository identity, source SHA, receipt version, and draft identity
  do not establish dependency compatibility. Retain Arrusted's Bun installation
  commands; Builder's own package-manager tasks are not target commands.
- Draft PRs are provisional against provider-read current-base information.
  Repository CD layout and template CI do not authorize or prevent a private
  build. Before updating a draft, prepare the current merge candidate, resolve
  only owned conflicts, format if needed, validate, review both complete diffs,
  and seal the exact reviewed changes before separate publication approval.
- Private command success, product walkthrough evidence, GitHub checks, hosted
  Preview proof, and Production readiness are distinct results. Source selection
  and local validation do not activate providers or grant release authority.

`lib/repository/supported-template.ts` owns diagnostic compatibility inspection
and the separate release-policy result. Change its focused tests alongside its
contract; do not add an incidental implementation-string check as a build gate.

Creation preparation remains private durable Builder state. Apply stages accepted
Markdown at `.config/app-specs/<id>.md` and invokes `mise run create:app <app-id>`.
The generator derives identity and default routes from the id and current catalog.
Additional public routes are separately reviewed topology edits. Conventional
`.config/app-specs/<id>.cue` selects CUE generation and is copied into the app;
without CUE, creation stays static. Markdown is an opaque snapshot at
`apps/<id>/.config/app-spec.md`, never backend or provider authority.

See the [Arrusted build guide](arrusted-app-builder-guide.md) for the complete
setup, validation, recovery, and publication sequence.
