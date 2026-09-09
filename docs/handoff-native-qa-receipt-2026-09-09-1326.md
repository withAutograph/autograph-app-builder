# Native handoff QA attempt — 2026-09-09 13:26 UTC

Result: **BLOCKED — Computer transport unavailable.**

The user requested execution of `docs/handoff-native-qa.md` using Computer.
Local HEAD was `a5b519bb0acea652b944a54fe89e260f74fba225`, with the
previous turn's uncommitted OAuth test, task configuration, and documentation
changes still present. This attempt changed no application code or deployment.

## Observed evidence

1. Read the QA runbook and existing acceptance receipts.
2. Called Computer discovery (`cua.getState()`). The tool returned
   `Transport closed`; no browser or native-app inventory was returned.
3. Attempted the supported Computer session reset. It also returned
   `Transport closed`.
4. Stopped UI execution. No alternate browser, shell UI automation, or other
   surface was used to bypass the unavailable Computer connection or the
   previously recorded Preview URL-policy restriction.

| Case | Status | Evidence |
| --- | --- | --- |
| Computer availability | BLOCKED | Discovery and session reset both returned `Transport closed` |
| N1 web preparation | BLOCKED | No UI access; no login or provider connection attempted |
| N2 Codex/Cursor install and OAuth | BLOCKED | Current versions, profiles, and connections could not be inspected |
| N3 launch and redemption | NOT RUN | Requires N1/N2 |
| N4 authenticated provider readbacks | NOT RUN | Requires native connection and session |
| N5 refresh/restart/recovery | NOT RUN | Requires native connection and session |
| N6 duplicate and cross-client attachment | NOT RUN | Requires both native clients |
| Failure/fallback UI cases | NOT RUN | Requires accessible approved fixtures and profiles |

The previous local receipt reports 11 browser E2E tests and 59 focused
protocol/unit tests passing. These were not rerun in this attempt and are not
native acceptance evidence. Previous Preview access/protection and missing
Cursor observations were not reverified; they remain unresolved, not newly
confirmed facts.

No credentials, callbacks, screenshots, or personal profile data were collected.
No consent, installation, provider mutation, build, publication, or deployment
was performed. No test resources were created or removed.

## Required next step

Restore the Computer plugin connection in Codex, then retry discovery. Once UI
access works, recheck the approved Preview access path and disposable native
profiles before continuing N1–N6. Do not infer native support from this attempt.
