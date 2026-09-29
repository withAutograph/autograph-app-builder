# Build an Arrusted app

The selected Arrusted checkout owns the app-building instructions. Read
`docs/guides/building-apps-with-app-builder.md` through `inspect_repository`
after selecting the source, followed by the selected app's `README.md` and
`AGENTS.md`. For a CUE-backed app, also read `docs/generated-data-operations.md`
and the generated-app integration in `docs/schema-compiler.md`. Inspect missing
or changed documentation through the current repository; do not turn a missing
guide into an acquisition gate or substitute remembered generator details.

The [Arrusted guide](https://github.com/withAutograph/arrusted-development/blob/main/docs/guides/building-apps-with-app-builder.md)
covers creation inputs, package/configuration/task ownership, local setup,
compiler repair, generated data features, authentication, validation, recovery,
publication and Production handoff. The selected checkout is authoritative for
its actual commands and installed versions.

Builder's [create-app skill](../agent/skills/create-app/SKILL.md) owns the product
and saved-session lifecycle: design and prototype, private build approval,
repository execution, validation and paged logs, private preview, candidate
formatting, current-base reconciliation, complete diff review, and separate
publication approval. Preserve those implemented tools rather than recreate
their operations with direct app edits.

Private validation, GitHub checks, protected Preview evidence, and Production
readiness are separate claims. Follow the selected app's current authentication
requirements; Spend Review's retired demo path must not be restored. Report
`productionHandoff` as a separate operator iteration, not a private build gate.
The current Arrusted draft-CI switch remains explicitly deferred.
