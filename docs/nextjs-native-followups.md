# Next.js native-feature follow-ups

## Coordination

The server-first builder and route-shell decomposition landed in PR #402
(`bcd76d36`). The 30-day cleanup deployment remains deferred in
[builder-draft-maintenance.md](builder-draft-maintenance.md); its follow-up
requirements were pushed separately to main in `0571683c`.

One coordinator owns integration, publication, and acceptance. The implementation
slices below start from `5ba15705`; each uses an isolated worktree and returns a
task-scoped commit. They do not publish independently.

| Order | Slice                                      | Exclusive ownership                                                                       | Integration requirement                                                               |
| ----- | ------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1     | Native route loading and error recovery    | Loading/layout files, error boundaries and focused UI tests                               | Preserve layout-local auth Suspense and Better Auth boundaries                        |
| 2     | Public catalog cache and request freshness | Catalog/deployment helpers, minimal home loader injection, sign-up page and focused tests | Cache only public model data; retain stale-on-error availability and tenant isolation |
| 3     | Production navigation proof                | Test-only Next configuration, separate Playwright configuration and mise test rig         | Run against the integrated first two slices, with isolated build output               |

The first two slices may be authored concurrently because their files do not
overlap. The third may prepare its infrastructure concurrently, but its runtime
acceptance follows integration. Changes to shared files require coordinator
approval. Reconcile current main's lint updates once at integration; do not create
competing formatter or CI edits.

## Production validation prerequisite

Slice 3 now has an isolated production-navigation lane; see
[production-navigation-validation.md](production-navigation-validation.md).
It uses fixture identities validated by real Better Auth sessions rather than
enabling the local provider/passkey emulators in production mode. Their guards
remain unchanged. A default-false source marker enables Next's testing API only
in the disposable artifact; the artifact rejects deployment identity and remote
origins/databases. No Vercel deployment metadata is spoofed.

The test artifact must use an isolated source snapshot/worktree, not just a
different `distDir`: Next also generates the root `next-env.d.ts`. The existing
`next dev` instant tests remain valid shell regression coverage, but are not
production-prefetch or production-cache acceptance evidence.

## Acceptance

Slices 1 and 2 were rebased onto green main `a83bcbce` as `2b06e52c` and
`2e973355` on `feat/next-native-boundaries-and-data`. Their combined focused
suite passed 23 tests. Local repository acceptance passed formatting, lint,
typecheck, 1,504 unit tests (12 skipped), and Storybook checks. Its temporary
PostgreSQL startup gate failed twice; diagnostics demonstrated cold initialization
outlasting its five-second budget. The gate now waits for the final TCP listener,
not the initialization-only Unix socket, and reports container logs on failure.
The corrected PostgreSQL gate passed its concurrency and recovery checks.
Package validation and the final formatting check passed independently.

The affected auth/provider/handoff browser run passed 59 of 63 tests, including
all 10 instant-navigation assertions. Four streamed-route readiness assertions
timed out at five seconds; all four passed unchanged in an isolated retry.
These results do not claim a clean single-pass browser run or production-mode
prefetch/cache proof. Exact-head CI remains the publication gate.

- Run focused component/data tests, lint, formatting, and typecheck after
  integration. Preserve action-state, autosave, provider-return and handoff tests.
- Exercise real direct visits and Link navigations with `@next/playwright`
  `instant()` against a production-mode emulated build, then confirm the deferred
  content resolves after the instant scope ends.
- Enable Next's production testing API only in the isolated test rig, never in
  a deployment. Do not overwrite a running development server's `.next` output.
- Verify cache failure/recovery behavior and request-fresh auth separately from
  shell assertions; an instant shell is not proof of cache correctness.
- Perform final repository acceptance once local behavior is ready. Exact-head
  CI is the broad gate. Do not claim local or hosted checks passed without their
  terminal results.

## Prior work audit

The anonymous-island, builder-controls, route-shells, autosave-flush, remote-race,
stream-recovery and instant-shells agent worktrees were clean when audited against
`5ba15705`. Their changes are incorporated, including the post-outbox revision
guard and handoff hydration-readiness repair. Subsequent differences are intended
composition improvements and mainline lint modernization.

Completed sub-agents are not independent sidebar tasks. Already archived related
tasks stay archived; unrelated active tasks are not archive candidates merely
because they share this repository. Historical worktrees are retained rather
than deleted as part of task organization.

The older server-action-handoff worktree is clean and its final retry change is
present, but its complete historical branch was not audited in this pass. Retain
it rather than asserting full branch incorporation from its tip alone.
