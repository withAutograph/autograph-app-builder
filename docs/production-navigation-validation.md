# Production navigation validation

Run `mise run test:production-navigation` after installing the repository's
dependencies and Chromium. Docker must be running. On macOS the task can use
the existing OrbStack context without changing the user's selected context.

The lane copies current source into a disposable directory, migrates a new
loopback-only PostgreSQL database, runs `next build --webpack`, then runs
`next start` behind a loopback HTTPS proxy. Webpack lets the source copy reuse
the installed dependency directory without changing Turbopack's source root.
This validates Next's production renderer/cache, not bundler parity or CDN
behavior. The live checkout's `.next` and `next-env.d.ts` remain untouched.

## Test authority

`production-navigation-artifact.ts` is committed with a false marker. Only the
disposable copy receives a true marker. Environment variables cannot enable
the testing API in the normal application artifact. The test artifact refuses
deployment identity, non-loopback origins/databases, and emulator configuration.
It is never a publication or deployment input.

The runner uses fresh fixture secrets and passes a sanitized environment to
Next and Playwright. It does not copy dotenv files or inherit provider or
deployment credentials. Real Better Auth session validation and organization
authority checks run against fixture rows; no sign-in endpoint is bypassed or
added. Production provider/passkey emulator guards remain unchanged. Browser
traffic to non-loopback origins is blocked.

The testing API is enabled with Next's
`experimental.exposeTestingApiInProductionBuild` only in the guarded artifact.
Tests use `@next/playwright` `instant()` for direct loads and actual Link
navigations, assert meaningful destination content after the URL commits, then
assert deferred content resolves outside the paused scope.

## Coverage and limits

- Builder/auth/provider/handoff loading shells and real primary Link navigation.
- Authenticated draft rendering and separate identities retaining their own
  workspace state; auth pages reflect current cookies rather than cached identity.
- Native public catalog cache reuse, tag expiration, stale fallback, and recovery.
  A probe route is copied into the disposable app only. It intercepts the fixed
  public catalog fetch with deterministic data; Next's cache APIs are not mocked.
- Handoff account-recovery rendering, not provider provisioning or journal execution.

The existing emulated browser lane remains responsible for actual OAuth,
passkey enrollment, provider continuation, and durable workflow races. This
lane does not replace those tests or claim hosted/CDN verification.

Screenshots/traces are retained under `.artifacts/production-navigation` on
failure. Fixture secrets, database, certificates, and source copy are removed
when the runner exits. Only the task-owned database container is removed;
other development databases and sessions are untouched.

Direct SIGTERM/SIGINT to the runner performs bounded child-process and socket
cleanup. A forced process-group kill (including terminal supervisors that kill
all descendants) can prevent any finally block from running. In that case use
the logged workspace/container names to remove only that run's disposable
resources; do not prune other containers or source worktrees.

The 30-day draft-cleanup scheduler remains deferred as documented in
[builder-draft-maintenance.md](builder-draft-maintenance.md).
