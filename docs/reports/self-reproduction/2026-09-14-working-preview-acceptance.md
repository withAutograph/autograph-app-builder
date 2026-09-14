# Self-reproduction working-preview acceptance, 2026-09-14

This record covers the frozen public acceptance run for PR 437. It preserves the
earlier baselines and uses only the sanitized public evidence at
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

The public receipt reports these requirement-level states:

| Requirement | Status | Evidence |
| --- | --- | --- |
| Fixture UI | present, `fixtures-only` | Public receipt |
| Visual prototype | present, `visual-prototype` | Public receipt |
| Working app availability | unavailable | Public session invalidated its working-app preview; cause not established by the receipt alone |
| Browser interaction | unassessed | No working preview was available |
| Backend correctness | unassessed | No independent backend verification ran |
| Independent child creation | unassessed | No child-app proof ran |
| Product comparison | unassessed | A runnable candidate was unavailable |

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
