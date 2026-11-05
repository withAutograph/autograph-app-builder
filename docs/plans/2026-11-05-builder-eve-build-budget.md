# Builder Eve build resource budget

The final shared Builder must build its actual selected agent source within the
ordinary Vercel build machine. Build memory is separate from private app compute,
provider permissions, runtime function limits and deployment activation.

## Observed failure and qualification

The actual reviewed candidate is `6a88e6919e3622189d71548bf8b1d6c730564070`. Its Vercel Preview
`dpl_6UWZCzU1NrYdjA9ADFMH1FUsmAUf` used a 4-core, 8-GB Standard machine.
Next completed successfully. The generated Eve service then invoked its actual
c205-patched installed CLI and failed with provider code `out_of_memory`.
This establishes the failed stage without inferring OOM from SIGKILL alone.

In a clean independent checkout, the same credential-free Services-mode source
reached the genuine missing-OIDC sandbox-template boundary with default peak RSS
7,236,485,120 bytes. An explicit 2-GiB Node old-space budget reached the same
boundary at 5,956,517,888 bytes. A 1-GiB budget failed the JavaScript heap limit
and is unsuitable. Standalone agent compilation with 2 GiB completed with its
normal tool graph. These are local observations, not a successful hosted build.

## Bounded implementation

Use the installed Eve package's public `withEve` `eveBuildCommand` option to give
only the generated agent build a fixed 2-GiB Node old-space budget. Preserve the
selected installed CLI, current Node options where supported, all discovered
agent tools/hooks, normal Services assembly and required sandbox initialization.
Do not change Next compilation, CI topology, build-machine billing, application
compute approvals, protection, credentials or provider permissions.

An early Node preload checks the actual V8 heap limit before Eve initializes.
Conflicting percentage-based Node settings can override an absolute old-space
flag, so they must not silently defeat the budget. The guard permits 256 MiB of
Node 24 young-generation overhead and otherwise reports a fixed actionable error
without printing option values. This is a V8 heap boundary, not a total-RSS claim.

Qualify the effective generated Services command through the real SDK, then run
actual agent compilation with the bounded command. Preserve a fresh source/tree
and artifact record. Credential-free Services qualification must still refuse
missing native OIDC before required template effects; never skip prewarming to
claim deployable output. A later ordinary provider build must independently
prove the complete hosted result within its actual machine budget.

Rebuild the final five-family operator catalog only after both repository cuts
are selected. Prior worker receipts, snapshots, old binaries and approvals stay
unchanged; neither this budget nor a new agent artifact makes an old worker
catalog current. Public app delivery and same-app revision remain separate
functional acceptance observations.
