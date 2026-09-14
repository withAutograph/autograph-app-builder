# Self-reproduction working-preview acceptance, 2026-09-14

This record covers the frozen public acceptance run for PR 437. It preserves the
earlier baselines. The acceptance observations use the sanitized public evidence at
`/private/tmp/self-reproduction-working-preview-20260914`.

## Run identity

- Session: `wrun_01M2ERRQPEFHC70K7GQ8TGE1T9`
- Source revision: `fb0e11499f0b903da14e175915384579d5829482`
- Started: `2026-09-14T01:33:36.830Z`
- Last observation: `2026-09-14T01:53:27.229Z`
- Elapsed: 1,190,399 ms
- Final session state: `waiting`
- Out-of-box proof: `false`
- Comparison: `unassessed`

## Observed outcome

The session produced a component-backed visual prototype and requested the
initial build approval at `2026-09-14T01:41:07.601Z`. Startup later failed. At
`2026-09-14T01:48:50.739Z`, the evaluator sent one ordinary user message asking
the Builder to recover the private preview without publishing or provisioning
external resources. Recovery requested two further approvals, supplied at
`2026-09-14T01:52:07.993Z` and `2026-09-14T01:53:20.896Z`.

The session then returned to `waiting` without a retained build workspace or a
working preview. Its final public response said that the private build workspace
was no longer available and that a fresh private rebuild was required. No
repository, provider, deployment, or external resource mutation was claimed.

The evaluator records these requirement-level states:

| Requirement                | Status     | Evidence                                                                    |
| -------------------------- | ---------- | --------------------------------------------------------------------------- |
| Working app delivery       | failed     | Public session ended without a working preview and reported startup failure |
| Session recovery           | failed     | Ordinary recovery and two approvals ended with the workspace unavailable    |
| Browser interaction        | unassessed | No working preview was available                                            |
| Backend correctness        | unassessed | No independent backend verification ran                                     |
| Independent child creation | unassessed | No child-app proof ran                                                      |
| Product comparison         | unassessed | A runnable candidate was unavailable                                        |

This run therefore does not prove that App Builder reproduced itself. A visual
prototype and a completed Builder turn do not establish a working independent
replica.

## Evidence limits

The evidence is public and sanitized; private bearer URLs and owner-only state
are excluded. Any technical validation described in model messages was not
independently verified and receives no passing credit.

The source was a preexisting Arrusted remote clone rather than a newly proven
clean source acquisition. That limits conclusions about a fully fresh
out-of-box run. The receipt also does not establish the cause of workspace loss,
so it cannot assign the failure exclusively to the generated app, Sandbox
runtime, or recovery orchestration.

The next acceptance run must retain or reconstruct the private workspace,
return an HTTP-ready working preview, and then execute the trusted browser,
backend, persistence, recovery, and child-generation checks. Until those checks
run, their status remains unassessed rather than passed.

## Post-session diagnosis (not generation evidence)

Read-only inspection of the retained Eve stream after the session stopped found
32 applied files, normal self-correction of an unresolved component CSS import
and a failed assertion, then two passing technical commands. Three preview
commands failed: a missing root `dev` script, a process that exited immediately,
and a generic readiness timeout. The timeout did not identify whether listener
startup or authenticated HTTP readiness failed; that cause remains unassessed.

Source inspection confirmed two shared recovery defects in
`lib/repository/supported-template.ts`. The development workspace check compared
JSON strings with different property orders and incorrectly reported a boundary
escape. The ensuing preparation unconditionally treated the transfer as new,
removed `repository`, and copied the original source over the applied app. The
subsequent app inspection found its files missing. This explains workspace loss
without attributing it to a provider stop/resume defect.

Repairs belong to the shared workspace and preview workflow. Keep this failed
session frozen; run a separate public acceptance after those repairs. No
internal operation was used to continue generation or repair its candidate.
