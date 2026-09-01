# Repository compatibility

App Builder read-only design and implementation planning use one closed,
builder-owned minimum contract. A repository is planning-compatible only when
all of the following are true:

- contract version `1` and runtime `nextjs` are supported;
- the declared repository paths exist and are safe repository-relative paths;
- the repository exposes the fixed identity, planning, apply, preflight, and
  validation command names through mise;
- `microfrontends.json` is the valid repository-owned topology document; and
- the root package manifest declares Next.js.

The current normalized commands are:

```text
mise run repository:exec -- app-identity.ts --app <app-id>
mise run repository:exec -- app-contract.ts --contract <contract-file>
mise run create:app -- --proposal <proposal-file>
mise run repository:preflight
mise run app:check-build <app-id>
mise run app:test <app-id> <shard>
```

Compatibility MUST NOT depend on the source code implementing those commands,
the generator's physical source path, an `@autograph` package-name heuristic,
repository history, a source-receipt schema version, dependency-cache identity,
or the repository's CD workflow. The fixed commands execute later inside the
builder-owned planning or apply boundary and fail closed if the declared
capability is not actually available.

Source and release authority remain independent:

- The reviewed Git SHA/tree, tracked-file manifest, tenant GitHub binding, and
  source preimage MUST still match before planning, apply, or publication.
- Local compatibility inspection MUST read every required contract file from
  the selected commit's Git blobs. Mutable working-tree bytes are reported as
  dirty paths but MUST NOT redefine the selected snapshot's compatibility.
- Dependency reuse MUST be decided from dependency inputs, toolchain,
  bootstrap, and platform, not repository identity, source SHA/tree,
  source-receipt version, planning receipt, or draft-PR identity.
- A repository may be read and planned when its CD workflow is absent or
  different. Any outward mutation, publication, deployment, or release MUST
  still pass its own effect-based approval and MUST re-read the full release
  policy from the selected Git snapshot immediately before the effect. Local
  effects read the selected commit blob; hosted effects read the verified
  prepared-snapshot manifest and bytes. Mutable checkout files, provider
  variables alone, or a prior planning result are not release-policy evidence.

`lib/repository/supported-template.ts` owns the normalized contract,
planning-compatibility result, and the separate full release-policy result.
`lib/repository/supported-template.test.ts` MUST change atomically with the
contract. Future contributors should add or remove a required capability in
that contract and its focused tests rather than inspecting another incidental
implementation string.

This compatibility contract is not merge authority. A draft PR MUST be treated
as provisional from provider-read current-base information and MUST NOT claim
merge readiness. At merge, the coordinator MUST re-read the default branch,
rebase or regenerate, rerun relevant validation, present the reconciled diff,
and obtain final effect-based approval before a clean-current-base merge.
Release-candidate byte immutability applies only to build/publish promotion.
