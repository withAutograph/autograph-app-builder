# Self-reproduction recovery acceptance, 2026-09-14

## Run

- Session: `wrun_01M2ETQ29Z9TE37Q2CEWPA9ZMA`
- Source revision: `6355974fd01c2ac2215d04831dcd60dcf9787ff5`
- Started: `2026-09-14T02:07:39.370Z`
- Observed through: `2026-09-14T02:38:58.430Z` (cursor 97)
- Elapsed: 1,879,060 ms
- Final state: `waiting`; no working preview
- Out-of-box proof: `false`

## Assessment

| Requirement                | Status         | Public evidence                                                                                                                   |
| -------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Working app delivery       | **failed**     | The final receipt has no working preview. Direct Next.js readiness returned HTTP 500.                                             |
| Startup recovery           | **failed**     | The ordinary recovery turn ended waiting without a reachable preview; the public response also reports `EADDRINUSE` on port 3001. |
| Backend correctness        | **unassessed** | No independent backend exercise ran.                                                                                              |
| Browser interaction        | **unassessed** | No HTTP-ready candidate was available.                                                                                            |
| Independent child creation | **unassessed** | No child-app proof ran.                                                                                                           |
| Visual/framework parity    | **unassessed** | Only fixture UI and a visual prototype were present; no paired candidate capture or executed framework behavior exists.           |

The run produced fixture-only UI and a visual prototype. It did not produce a
working independent replica, so the comparison remains unassessed.

## Interaction record

Two approval cards were answered: `2026-09-14T02:15:06.911Z` and
`2026-09-14T02:17:05.146Z`. After startup failed, the evaluator sent one
ordinary recovery message at `2026-09-14T02:21:44.803Z`. The session ultimately
returned to `waiting` without `workingPreview`.

## Evidence boundary

Observed public facts are the final session state, missing working preview,
HTTP 500 and `EADDRINUSE` recovery report, fixture/prototype presence, approval
and recovery-message timestamps, and the requirement statuses above.

The model claimed that repository build and tests remained technically
validated. That claim was not independently verified by this assessment and
earns no passing credit. The configured Builder model was
`openai/gpt-5.6-terra`; the configured design judge was `openai/gpt-6-astra`,
but runtime usage totals and effective model identity were not exposed by the
public result.

The source was an existing clean development checkout. Remote acquisition
during generation is unassessed. Private bearer URLs are excluded from this report. Complete public responses
remain in owner-only local evidence files.

## Post-session diagnosis (not generation evidence)

The retained authored-tool stream confirms that generated files survived the
ordinary recovery request: an inspection at 02:22:12 UTC read the generated
package, Next configuration, page, layout, and draft route. This establishes
retention of those files after the preparation repair; it does not establish
complete source parity or backend correctness.

The same stream records app-directory startup attempts reaching HTTP 500. It
does not contain the running server exception, so the underlying application
error remains unassessed. A root-directory launch also failed microfrontend
configuration lookup. The subsequently merged repository-relative startup
directory option was not part of this frozen acceptance source.

A startup requested at 02:31:48 UTC remained outstanding when another startup
was requested at 02:37:54. The latter encountered an occupied gateway port.
This confirms overlapping attempts, but not the precise process responsible
for the listener. Source inspection also found that cleanup acknowledged a
kill request without awaiting command exit and that ready-only state could not
represent an outstanding startup. The next shared repair must retain attempt
ownership, reconcile termination, and expose bounded server diagnostics without
starting another evaluator-controlled server.

PR 437 landed as `7b17fe7f84b532baedc936888911be2d3cced722`; its PR and main CI
passed, including exact main package publication. That verification does not
turn this failed product acceptance into a successful replica.

## Scoped generated-source finding

The historical recovery inspection at 02:22:12.157 UTC read
`apps/autograph-app-builder/app/api/drafts/route.ts`. Its handler validated the
brief and returned `saved: true`, a random identifier, and a timestamp without
performing a durable write. Durable draft persistence therefore failed in the
inspected implementation; the absence of a working URL does not make this
source-proven defect unassessed. This is not a complete final filesystem audit.

The handler itself also lacked an authentication or tenant check, but global
middleware was not comprehensively inspected, so application-wide
authentication remains unassessed. Other routes and child orchestration were
not comprehensively read. The observed heading-only root page is informational
and does not change the exclusion of anonymous-entry work.

The decisive portion of the observed handler was:

```ts
export async function POST(request: Request) {
  const payload = (await request.json()) as DraftPayload;
  if (!payload.brief || payload.brief.trim().length < 24)
    return NextResponse.json({ error: "A detailed brief is required." }, { status: 400 });
  return NextResponse.json({
    saved: true,
    revision: crypto.randomUUID(),
    savedAt: new Date().toISOString(),
  });
}
```

The only module import was `NextResponse` from `next/server`. This historical
handler provides no write operation or durable record identifier for readback.
The shared repair needs a concrete generated-app persistence capability and a
write followed by an independent read; a route-shaped file and passing build
are insufficient. The evaluator must observe that behavior through the normal
app, rather than providing an implementation to the generator.

## Remaining work in priority order

1. **Working delivery and recovery:** serialize shared preview startup, confirm
   process exit before replacement, retain actionable server diagnostics, and
   repeat the unchanged public-entrypoint acceptance after the repair. Focused
   runtime tests are necessary but do not replace this product proof.
2. **Real durable drafts:** exercise a mutation followed by a fresh-context read
   and reload. The Arrusted checkout at
   `f992cee2f301c57fe3289a26f26e36b15b683d2f` has CUE/PostgreSQL compilation, but
   its proposed generic typed generated-app client/transport remains planned
   (`docs/plans/2026-09-02-generated-app-cue-postgres-backend.md`). This is a
   missing supported capability, not proof that every local durable storage
   implementation is impossible. The source-proven no-op still needs repair
   through the shared workflow; do not patch this frozen candidate.
3. **Executable product comparison:** once an actual working URL exists, assess
   authenticated access, reload/readback, provider return, cancellation, retry,
   recovery, and one independently created child app. Preserve missing controls
   as failures and unavailable infrastructure as blockers.
4. **Visual and framework evidence:** capture matching desktop states and
   execute applicable navigation/cache/isolation assertions. Keep advisory
   visual scores separate from product correctness.

Anonymous entry remains excluded. Actual hosted publication and provisioning
remain unverified and outside this local proof.
