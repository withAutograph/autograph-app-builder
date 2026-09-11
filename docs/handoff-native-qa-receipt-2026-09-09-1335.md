# Native handoff QA retry — 2026-09-09 13:35 UTC

Result: **BLOCKED — native Codex control prohibited; Cursor not in inventory.**

Computer discovery succeeded on this retry. The earlier transport failure is resolved. The available app inventory included `com.openai.codex` (displayed as ChatGPT), but did not list Cursor. Only the Codex in-app browser was exposed as a browser surface, with no tabs. Absence from inventory does not establish that Cursor is absent from every possible installation location.

Selecting the Codex app through Computer returned:

> Computer Use is not allowed to use the app 'com.openai.codex' for safety reasons.

No Codex UI state or version was returned. No alternate surface was used to circumvent the restriction. The previously recorded Preview URL-policy denial was not retried through another surface, and Preview access was not reverified.

| Case | Status | Observation |
| --- | --- | --- |
| Computer transport | PASS | Discovery returned current inventory |
| N1 web preparation | BLOCKED | Prior Preview access restriction unresolved; no approved fresh test profile identified |
| N2 Codex installation/OAuth | BLOCKED | Explicit Computer safety-policy denial |
| N2 Cursor installation/OAuth | BLOCKED | Cursor not listed; installation/location and disposable profile require operator direction |
| N3–N6 native continuation/readbacks/recovery/attachment | NOT RUN | Native prerequisites unavailable |
| Failure/fallback cases | NOT RUN | No accessible approved native test session |

No authentication, consent, installation, provider mutation, build, publication, or deployment was performed. No credentials or screenshots were collected. Previous automated results were not rerun and are not native acceptance proof.

## Next action

The operator must perform Codex UI steps manually because Computer prohibits controlling it. Cursor testing requires an installed client/location, a disposable profile, and a permitted Preview access path. Record any manual observations separately from Computer-executed evidence. Native support remains unverified.
