# Response transport using released Eve features

Decision: preserve complete direct response submissions and defer oversized
resumable response uploads. This plan assumes no new upstream Eve features.
Release findings were verified September 29, 2026.

## Released features

Builder pins `eve@0.44.4`. The latest published release at the time of review was
[Eve 0.68.0](https://github.com/vercel/eve/releases/tag/eve%400.68.0).
The released [client](https://github.com/vercel/eve/blob/eve%400.68.0/packages/eve/src/client/session.ts)
still serializes `inputResponses` into one JSON body. Its
[canonical routes](https://github.com/vercel/eve/blob/eve%400.68.0/packages/eve/src/protocol/routes.ts)
and [HTTP channel](https://github.com/vercel/eve/blob/eve%400.68.0/packages/eve/src/eve-channel/index.ts)
provide no durable response-upload or atomic-commit API.

The [released changelog](https://github.com/vercel/eve/blob/eve%400.68.0/packages/eve/CHANGELOG.md)
contains related improvements:

- **0.63.1:** partial approval responses remain saved until their batch can
  resolve, without an extra model call after an unrelated answer.
- **0.65.0:** `ask_question` becomes an ordinary workflow tool using `ctx.ask()`,
  with changed question and result shapes.
- **0.68.0:** answered `ctx.ask()` responses include authenticated responder
  identity.

These features do not supply resumable response uploads with one complete-batch
commit. Do not upgrade Eve solely for this feature. A separate upgrade requires
compatibility assessment: the intervening 0.57.0 release changes workflow/session
execution and documents migration limitations for drivers predating 0.45.

## Current supported behavior

Both `respond` and `respondAccepted` in
[`same-origin-http.ts`](../../lib/eve/same-origin-http.ts) send one complete JSON
`inputResponses` body. The local service uses `ClientSession.respond`.
Preserve the existing direct `autograph_respond` input, complete outstanding
batch validation, authorization, and handling of uncertain submission outcomes.
A complete submission does not imply transactional execution of external effects.

Read-only inspection of installed `eve@0.44.4` found that answering any question
in a pending question batch selects that batch for resolution and marks omitted
answers ignored. Never split a batch automatically into ordinary response calls.
After an uncertain response submission, preserve the original operation identity
and follow the existing session-read recovery guidance; do not blindly replay it.

Keep discovery at exactly five public MCP tools and retain existing direct-client
behavior. Preserve the removal of arbitrary response-count ceilings in
[PR #567](https://github.com/withAutograph/autograph-app-builder/pull/567), along
with existing per-answer security bounds and actual transport constraints. This
decision introduces no new workload quota or guessed host envelope limit.

## Deferred work and boundaries

Oversized resumable response uploads are deferred. Do not expose `begin`,
`append`, `status`, or `commit` response modes, or implement Builder-only staging
that still needs one oversized downstream request. The delivery plan includes
no maintainer outreach, upstream implementation, or dependency on a future Eve
release. Installed-package patches and private framework forks are excluded.

Bounded pending-request readback is separate work. Paging questions can improve
readback, but does not solve complete-batch response submission. No pending-request
cursor, automatic client staging, or new transport capability is implemented by
this documentation update.

## Validation and evidence

The findings come from npm release metadata, published release notes, the exact
`eve@0.68.0` source tag, and read-only inspection of the installed `0.44.4` package
and Builder response paths. They are source evidence, not a runtime acceptance
result for either release.

This revision changes documentation only. Validate formatting, local and upstream
source links, and the diff; use the existing exact-head CI workflow. It includes
no runtime change, package upgrade, provider operation, or new runtime acceptance
claim. Authentication, tenant/app ownership, approved changes, publication/provider
approvals, and Arrusted repository commands and identity contracts are unchanged.
