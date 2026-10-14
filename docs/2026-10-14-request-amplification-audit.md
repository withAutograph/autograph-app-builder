# Request amplification audit

Date: 2026-10-14. Source baseline: `d05afe5832244a9b168cc5078260391594bc6884`
(merged PR #742). The older shared checkout at
`3a87f4c14287eea1b10e1cc5a2782c327f112ff2` was used only for initial discovery;
its paid intermediate review and older response polling are historical behavior.

The confirmed hot paths are repeated provider inventory checks and overlapping
client draft reads. Intermediate technical validation already defers paid source
review. The supplied successful Gateway pair does not establish a retry storm.
This audit and the accompanying draft polling repair establish source and local
fixture behavior; authenticated Preview delivery remains separate acceptance work.

## Provider observations

The delivery coordinator observed HTTP 429 from the Vercel app-project check at
16:19:14 UTC. This is a provider inventory request, not an AI Gateway rejection.
The following request counts were reported from the coordinator's synthetic
fixtures; they are not live-provider measurements repeated by this audit.

| Logical observation             | Reported fixture requests                                              | Current evidence and follow-up                                                                                                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway resource binding        | 130 fresh / 94 replay before repair; 47 ready / 29 replay after repair | Ready repair source `b81bde301c9577a0130d7692f9264f5928894892`; hosted reduction still needs measurement.                                                                                                        |
| App binding                     | 22 fresh / 12 replay                                                   | Fixture counts; reduction remains queued.                                                                                                                                                                        |
| Source candidate reconciliation | Repeated project and team reads within `P + 3D` candidate work         | Source inspection identifies repetition; the provider request total depends on candidate paths. Repair and hosted measurement remain queued.                                                                     |
| Read-only Neon metadata         | Full provider and native-binding checks now bracket one observation    | PR #742 preserves fresh canonical owner, membership, adapter and active installation checks around each OIDC, token and tool step. Credential acquisition and approved effects retain their full current checks. |

Coalesce requests only within the actual logical operation. Keep fresh full
provider checks before and after a read-only observation, and keep just-in-time
credential and mutation authorization. Do not cache authority across observations
or add usage, spend, session, membership or request-frequency quotas.

## Draft polling repair

[`use-builder-controller.ts`](../app/ui/use-builder-controller.ts) previously
started an active-draft Server Action every ten seconds without an in-flight
guard. Visibility changes could also start a read. Once the document had been
hidden, the flag remained set, so additional visible events could repeat it.
For a read taking more than thirty seconds, four timer invocations could be
outstanding after forty seconds, plus visibility-triggered invocations.
Next's client dispatcher serializes Server Actions; these invocations can queue
behind the active read and user actions rather than execute concurrently.

The repair shares one active read for the same action and local draft within the
mounted controller. The shared request retains the local mutation version from
its actual start; a joining effect cannot give older data the authority of a newer
edit version. Timer ticks coalesce while it runs. A return from a hidden
page queues one fresh follow-up after settlement, so a read begun before the
return does not suppress the newer observation. Repeated visible events do not
queue extra work. Success and failure release the active read; ordinary polling
continues. There is no new polling interval or frequency restriction.

Effect cleanup aborts result handling, including a second check after asynchronous
outbox reconciliation. Existing local-edit and revision checks remain in place.
The Server Action interface has no HTTP cancellation parameter; this repair does
not claim to cancel an already dispatched server request. Changing the transport
would be a separate change.

Local acceptance: all 35 tests in `app/ui/app-builder.test.tsx` pass, including
slow reads across timer ticks and rerenders, visibility coalescing with newer
remote results, recovery after read failure, pending work after unmount, and
local edits made while an older read is joined after effect restart or while
outbox reconciliation is pending.
Focused type-aware lint passes. Repository-wide TypeScript checking still reports
unrelated missing MCP/Hono dependencies and provisioning fixture type errors;
it is not a passing acceptance claim for the whole repository.

## Paid model calls

Current [`validate_app_creation`](../agent/tools/validate_app_creation.ts) returns
an unassessed, deferred source result. Its direct paid-review request count is
**zero**. [`accept_change_set`](../agent/tools/accept_change_set.ts) owns final
independent source review. Repeated completed review with unchanged current
source and requirements reuses its retained assessment with zero new requests.

Final source review covers source-page × requirement-excerpt pairs. The current
implementation batches unfinished pairs, replays durable completed pairs and
splits only on concrete context/output-capacity failures. Both generation paths
set `maxRetries: 0`. Its request count is the number of dispatched unfinished
batches plus any capacity-recovery subdivision calls, not one request per file
or one request per complete acceptance. Actual counts are already emitted as
`app_builder.source_review_invocation` and
`app_builder.source_review_request_finished`; use those events for attribution.
Do not discard required source/requirement coverage to reduce request counts.

The coordinator's live observation reported two successful Sol requests at
12:17:49 and 12:19:16 ET, costing $0.0118 and $0.0133: **$0.0251 combined**.
The later request had approximately 107K input tokens, mostly cache reads. Its
Gateway drawer labeled the requests Primary and Fallback. That label and two
HTTP 200 responses alone do not prove an error retry, duplicate continuation or
paid source review. A historical overview covering a different time window
cannot be combined with this pair to estimate current operation spend.

Current phase routing intentionally uses Luna for discovery and Sol for accepted
functional work. A Sol request therefore does not by itself identify source
review. See [`builder-model-routing.ts`](../lib/agent/builder-model-routing.ts).
No fallback-model list is configured in that routing module or the source review
generation calls. Gateway-side routing configuration was not independently
verified by this audit.

## Runtime retry evidence

The pinned versions are Eve 0.68.0 and AI SDK 7.0.105. Eve's published
`harness/tool-loop.js` constructs a `ToolLoopAgent` with one SDK step, does not set
`maxRetries`, and wraps the model call in up to three attempts for errors its
classifier marks retryable. The SDK defaults to two retries, or three provider
attempts. These are two retry mechanisms; multiplying them unconditionally into
nine requests is incorrect.

A credential-free check against these exact installed versions classified a
direct synthetic retryable HTTP 429 as `retry`, but classified the SDK's exhausted
`AI_RetryError` as `recoverable`. That error retains `lastError` and `errors`
without a cause, while Eve walks the cause chain. Thus the ordinary initial-call
429 exhaustion path makes three SDK attempts and does not automatically restart
another three-attempt SDK cycle. Retryable errors delivered later by a connected
stream can take another path; its live request count remains unmeasured.

Eve also reissues an empty model response once and can retry after removing an
unsupported provider tool. These recoveries are conditional. Successful tool
steps naturally require another model request to consume tool results; the
one-step SDK stop condition does not mean one model request per public message.
No retry policy was changed. Match native attempt events, finish reasons,
generation IDs and `eve.retry.reason` before changing either retry owner.

Published version-matched sources:

- [Eve tool loop](https://unpkg.com/eve@0.68.0/dist/src/harness/tool-loop.js)
- [Eve error classifier](https://unpkg.com/eve@0.68.0/dist/src/harness/model-call-error.js)
- [AI SDK retry defaults](https://unpkg.com/ai@7.0.105/src/util/prepare-retries.ts)
- [AI SDK retry error](https://unpkg.com/ai@7.0.105/src/util/retry-error.ts)

## Remaining audit work

Provider binding and source reconciliation reductions, live attribution of
queued/in-progress native continuations, and the precise cause of the supplied
Primary/Fallback pair remain unresolved. Current response settlement reads poll
sequentially every 200ms within their existing read deadline; incremental paths
advance the verified native cursor. They are status reads, not new model calls.
The public evaluator polls sequentially at its configured interval and retains
continuation IDs. No replacement public session, provider mutation, paid run or
publication was performed by this audit.
