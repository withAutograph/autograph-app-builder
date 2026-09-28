# Builder artifact reference projection

The hosted session projection can page public events and retain small preview metadata. HTML prototypes still use the legacy receipt verifier: the current public `prototype.content` contract requires the complete document, and the verifier reconstructs chunked writes and reads from the Eve event history. The paged path must keep its legacy fallback until the following contract is implemented end to end.

## Durable artifact contract

- Store artifact content as immutable, tenant-scoped chunks keyed by session, path, revision, and content digest. Each chunk records its byte offset, byte length, and SHA-256 digest. Accept ordered UTF-8-safe chunks without a total artifact ceiling.
- Publish a versioned artifact manifest only after every referenced chunk is durable and the streamed full-content digest matches the reviewed receipt. The manifest binds tenant, session, path, revision, media type, total bytes, content digest, and chunk digests. An interrupted write leaves the prior manifest readable.
- Replace `prototype.content` in a new additive projection variant with a manifest reference. Keep the current variant as a legacy reader. Never infer an artifact from a tool request or incomplete result; require the completed tool receipt and exact manifest binding.
- Offer an authenticated, tenant-bound chunk read by manifest reference and byte offset. Verify the manifest and chunk digest on every read. A stale revision, altered path, missing chunk, or tenant mismatch must fail closed with a specific recovery message.

## Browser and Builder migration

1. Add the manifest and chunk store and the authenticated read route. Preserve existing prototype receipts and legacy checkpoint reads.
2. Teach Builder's prototype and UI-preview tools to stream content into the store and return a manifest reference. Keep their current single-call path for content that fits the transport envelope.
3. Teach the Browser preview to request chunks with backpressure, verify the completed digest, and render only after verification. Avoid returning the complete HTML through the session projection.
4. Switch hosted event observation to retain only the verified manifest reference and preview metadata. Remove `artifactProjectionRequiresLegacyReadback` for sessions whose artifact receipts and manifests can be verified incrementally; retain fallback for historical sessions.
5. Exercise interrupted writes, stale and cross-tenant references, Unicode boundaries, altered chunks, large histories, and browser refresh before enabling the new projection by default.

The reducer in `lib/eve/public-events.ts` is intentionally metadata-only. It does not relax receipt verification or claim that full prototype readback is bounded.
