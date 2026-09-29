# Resumable response transport prerequisite

Status: blocked on supported upstream eve API agreement and release. Verified
September 29, 2026. This is a prerequisite proposal, not an implemented public
API or runtime acceptance result. Builder staging remains unavailable.

## Verified baseline and blocker

- Builder `origin/main` was `2883f8e9`, including [PR #567](https://github.com/withAutograph/autograph-app-builder/pull/567)
  and the preceding Arrusted alignment. Builder pins `eve@0.44.4`.
- Both `respond` and `respondAccepted` in
  [`same-origin-http.ts`](../../lib/eve/same-origin-http.ts) send one JSON
  `inputResponses` body to `/eve/v1/session/:sessionId`. The local service uses
  `ClientSession.respond`. Neither path provides durable response uploads.
- Read-only inspection of installed `eve@0.44.4` found
  `dist/src/harness/hitl/question-input-requests.js` selecting a question batch
  when **any** supplied response matches it. Omitted answers become `ignored`
  in `buildQuestionToolResponsePart` and `buildResolvedInputBatch`. Sending
  successive ordinary response subsets can therefore consume unanswered
  questions. This is source evidence, not a public-API runtime test.
- The public npm `latest` release was `0.68.0`. Canonical `vercel/eve` main was
  [`c32047cb93eb72f81848a17293685f2c32a35101`](https://github.com/vercel/eve/tree/c32047cb93eb72f81848a17293685f2c32a35101),
  whose package manifest also says `0.68.0`. Its
  [client response method and body serializer](https://github.com/vercel/eve/blob/c32047cb93eb72f81848a17293685f2c32a35101/packages/eve/src/client/session.ts)
  still submit `inputResponses` in one body. Its
  [canonical route definitions](https://github.com/vercel/eve/blob/c32047cb93eb72f81848a17293685f2c32a35101/packages/eve/src/protocol/routes.ts)
  and [HTTP channel](https://github.com/vercel/eve/blob/c32047cb93eb72f81848a17293685f2c32a35101/packages/eve/src/eve-channel/index.ts)
  expose no response-transfer begin/append/status/commit API. Upgrading alone
  does not establish the prerequisite. No latest-package runtime test was run.
- The canonical repository is public and readable; the authenticated account
  has `pull: true`, `push: false`, `maintain: false`, and `admin: false`.
  Its [contribution policy](https://github.com/vercel/eve/blob/c32047cb93eb72f81848a17293685f2c32a35101/CONTRIBUTING.md#proposing-a-change)
  requires external contributors to wait for maintainer agreement before
  implementing public API/runtime changes. Invited contributors may submit
  PRs; maintainers manage package releases. No invitation for this change was
  established. Searches for response staging, atomic responses, resumable
  responses, and related `inputResponses` PRs found no matching approved work;
  those searches are not proof that no discussion exists.

The dependency is maintainer agreement followed by canonical implementation,
acceptance, and a published release. Source access itself is available. A
Builder-owned staging store, installed-package patch, or private dependency fork
would not satisfy the downstream atomic boundary. No such fallback is enabled.

## Proposed upstream feature request

The following is prepared for upstream review; it has not been submitted.
Operation names describe the required semantics, not existing SDK methods or
agreed route spellings.

### Problem

A client can collect a complete valid batch of human answers or approvals that
exceeds one HTTP/MCP message envelope. It needs bounded uploads, reconnectable
progress, and one complete response decision. Splitting ordinary response calls
changes question-batch semantics. Buffering in the client still leaves one large
downstream request and loses progress when the client process is replaced.

### Proposed solution

Add durable response staging to eve's canonical session routes and public
client. eve owns response bytes and the atomic handoff to its existing input
resolution path. Use the current resource authorization, input validation,
approval semantics, mutation serialization, and durable operation identity.

| Operation    | Required observable behavior                                                                                                                                                                                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capabilities | Advertise supported transport revision, actual request-envelope bounds, raw chunk bound, record encoding, and pending-read pagination. An absent capability means unsupported, even if the package version is newer.                                                                                 |
| Begin        | Authoritatively capture the ordered pending set, bind an opaque transfer to authenticated identity and session, and return a bounded descriptor plus a pending-set digest/read cursor. Retrying the same operation returns the same transfer. Do not return the whole pending set in the descriptor. |
| Append       | Accept immutable bytes by transfer ID, consecutive zero-based index, and SHA-256 digest. An identical retry succeeds; different bytes at an existing index conflict. A gap fails with the next expected index. Acknowledgment follows durable storage.                                               |
| Status       | Return the next contiguous acknowledged index, lifecycle state, and commit operation/result identity in bounded metadata. Do not return answers. Support a new process reconnecting to the same transfer.                                                                                            |
| Commit       | Incrementally validate complete content, recheck authoritative pending state, and atomically accept the complete batch once under a stable operation ID. Return/recover the same durable result for retries.                                                                                         |
| Pending read | Page the immutable pending snapshot using authenticated cursors bound to session and digest. Bound the complete encoded page, including request options and other metadata.                                                                                                                          |

Staging resolves no request, approves no effect, and starts no turn. Store uploads
with durable session data, independent of ordinary compute expiry. Abandoned
uploads follow the existing session-retention lifecycle. Retain current
per-answer security bounds; do not impose a total batch-byte or chunk-count cap.
Use bounded reads, backpressure, and resumable validation for long commits.

### Encoding and validation

Specify a versioned canonical record encoding in the upstream contract. The
proposal uses one eve `InputResponse` JSON record per line, in authoritative
pending order, UTF-8 encoded, with one LF after every record including the last.
Serialize `requestId`, then optional `optionId`, then optional `text`, with
JSON string escaping and no whitespace or additional keys. Omit absent fields;
do not normalize answer text. Preserve the existing mapping of Builder
approve/deny/answer variants to eve responses and validate those variants before
encoding. The full SHA-256 covers every byte, including the final LF.

Upload raw byte slices using the existing Builder 32 KiB convention, reducing
each slice when necessary to fit the advertised complete envelope. For `n` raw
bytes, base64 needs `4 * ceil(n / 3)` characters; measure the actual UTF-8 JSON
envelope, including IDs, indices, digests and protocol wrapping. Record and
multibyte boundaries may cross chunks. Decode UTF-8 with a strict streaming
decoder; never decode each raw chunk independently. Reject malformed UTF-8,
invalid JSON, noncanonical records, duplicates, missing records, and trailing
bytes. Keep parsing bounded per record with limits justified by the existing
input schema. No answer content belongs in operational logs or error messages.

Commit checks contiguous chunks, declared chunk/byte/record counts, every chunk
digest, full digest, and exact pending membership/order. These counts describe
the upload, not workload quotas. Reobserve the pending set immediately before
dispatch. The final comparison and acceptance must share eve's serialization
boundary so another response cannot change the set between check and consume.
A changed set invalidates the transfer without consuming any of its answers.

Persist an immutable commit identity and durable acceptance/result receipt.
Concurrent commits converge on one decision. A reused operation ID with a
different transfer or digest conflicts. After a crash or lost acknowledgment,
recover the existing operation; an unknown dispatch never authorizes a new one.
Atomic acceptance must cover the handoff into the resolver, not just a transfer
state flag written before an ordinary response POST. Preserve existing tool
approval and replay behavior; this proposal does not claim arbitrary external
effects become exactly-once transactions.

### Alternatives considered

- Separate ordinary response submissions can resolve incomplete question batches.
- Client-only or MCP-only staging leaves the large downstream body and uncertain
  commit boundary intact.
- A static guessed host limit or a total response-count quota does not provide
  reliable envelope sizing or continuation.
- Installed SDK patches and private adapters bypass the supported API/release
  contract and cannot serve as the prerequisite.

## Builder integration after upstream acceptance

Deliver the canonical eve prerequisite PR and published package first. Follow
with a separate Builder PR from then-current `origin/main`; preserve #567 and
intervening changes. Do not upgrade speculatively or enable staging based on a
version number alone.

1. Preserve the existing direct `autograph_respond` object and behavior. Extend
   that same tool with explicit `begin`, `append`, `status`, and `commit` modes.
   Keep discovery at exactly five tools. Require the existing session scope and
   operation-specific authorization on every call, including status/readback.
2. Builder persists only tenant-scoped transfer bindings and operation state.
   Bind principal issuer, audience, workspace, owner, public session, adapter
   generation, eve transfer identity, and authoritative pending digest. Never
   trust a client-supplied principal or store response bytes in Builder. Keep
   adapter IDs private. Cross-tenant transfer access reveals no metadata.
3. Capture pending state authoritatively at begin. A provider authorization
   request remains subject to its existing provider flow; staging cannot answer
   it or widen approval authority. An adapter-generation replacement invalidates
   the old binding rather than moving answers to a replacement session. Process
   reconnects to the same generation recover acknowledged progress normally.
4. Integrate commit with the existing `mutate` operation serialization and
   receipts in [`hosted-service.ts`](../../lib/eve/hosted-service.ts). Reuse the
   same `clientRequestId`/operation identity through lost acknowledgments. Check
   the binding again before dispatch; recover unknown outcomes through eve's
   supported status API. Do not migrate historical receipts.
5. Add an opt-in pending-request cursor to `autograph_get`, independent of its
   existing event cursor. Bind it to principal/session/generation/pending digest.
   Return explicit completion and stale-snapshot signals. Page the whole encoded
   response, avoiding duplicate full pending arrays in events or metadata. If a
   single request exceeds one page, use supported continuation for its content;
   a request-count page limit alone cannot bound bytes. Preserve legacy reads.
6. Publish verified server transport capabilities. Combine these with any
   authoritative client-host envelope bound; an unknown host limit remains
   unknown. Measure the complete direct envelope before choosing direct versus
   staged submission. Never treat the existing 10 MiB Eve **event writer**
   ceiling as an HTTP/MCP request limit. If a known oversized submission has no
   supported staging path, report unsupported transport without sending subsets.
7. Update MCP UI and programmatic client guidance to collect all pending pages,
   retain transfer/commit identities, resume from status, and stage automatically
   when direct submission cannot fit. Regenerate the MCP UI and portable assets
   only for the final implementation acceptance. Keep small direct clients valid.

Arrusted repository commands and identity contracts, authentication, ownership,
approved changes, publication/provider approvals, and deployment authority remain
unchanged. Dependency-recovery logs, framework adapters, quotas, and provider
activation are outside this work.

## Acceptance required before enabling staging

| Area                 | Required evidence                                                                                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Encoding             | Complete-envelope sizing with escaping, base64 overhead, multibyte text, raw chunks splitting characters/records, final LF, and malformed records. Retain per-answer bounds; a valid large batch has no aggregate ceiling.                                                                       |
| Upload durability    | Interrupted upload and process replacement recover the acknowledged index; identical retries succeed, conflicting retries fail; missing chunks and digest mismatch consume nothing. Compute expiry preserves uploads.                                                                            |
| Authority            | Cross-tenant access, changed pending membership/order/content, adapter replacement, and authorization changes fail without resolving inputs or approving effects.                                                                                                                                |
| Atomicity            | Concurrent commits and crashes around durable acceptance dispatch one complete batch. Lost commit acknowledgment recovers the same operation/result. Unknown dispatch is never blindly replayed.                                                                                                 |
| Public eve API       | Exercise supported canonical routes/client against the released prerequisite. Observe that incomplete uploads produce no input-resolution events or turns, and a complete approval batch invokes the approved fixture action once. Private harness probes or mocks are only diagnostic evidence. |
| Readback and clients | Large pending pages, stale cursors, reconnects, one oversized pending item, direct-client compatibility, and automatic UI/programmatic staging. No full-batch duplication defeats page bounds.                                                                                                   |
| Builder delivery     | Focused tests and typecheck, one final local acceptance, exact-five discovery, packaging verification, generated assets, and exact-head CI. No repeated broad checks during edits.                                                                                                               |

For this prerequisite document, verification was limited to Git/npm metadata,
read-only source and bundled-doc inspection, upstream proposal searches, and
document checks. No response staging, approval execution, or supported atomic
commit runtime proof exists yet. No upstream issue, invitation, implementation
PR, or package release was created by this prerequisite work.
