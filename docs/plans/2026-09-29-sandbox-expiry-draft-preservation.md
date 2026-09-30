**Preserving private Builder work across sandbox loss**

Planning proposal, 29 September 2026. Inspected current `origin/main` at `79179b2613c7847f65c5f5745686ba13591452f9` (`Upgrade Builder to Eve 0.68.0 (#571)`). The plan traces the current Eve 0.68 provider and session paths, including app-baseline restoration and draft reconciliation. Source was exported for read-only inspection; the existing checkout stayed on its original branch. This document proposes implementation and acceptance work. No implementation, database migration, provider change, or runtime acceptance was performed.

**Recommendation.** Add a private, tenant-scoped, content-addressed workspace store, initially using chunked PostgreSQL storage alongside the existing hosted session stores. Persist source bytes and recovery metadata before acknowledging completed edits. Retain Eve as the conversation/workflow engine and Vercel Sandbox as replaceable compute. Keep GitHub updates behind the existing reviewed-publication boundary. An incremental push, including to an existing private draft branch, is an outward effect and is not an autosave mechanism.

The durability guarantee is: every acknowledged source mutation is recoverable, with its bytes and modes, from outside the sandbox. An interrupted command can resume from its last committed boundary; arbitrary instructions still executing when the VM disappears are not promised as completed work. Record this distinction rather than claiming that conversation history or a receipt can recreate missing files.

**1. What current main preserves, and what it loses**

- **Hosted session history**
  - **Current evidence:** Paged checkpoint manifests, items, and chunks stage history before publishing its pointer. Adapter replacement is fenced by adapter generation and expected checkpoint digest. [Checkpoint store][checkpoint-store]; [hosted service][hosted-service].
  - **Consequence:** Reuse the transaction/staging pattern. These checkpoints contain public history and artifact references, not a recoverable private workspace.
- **Eve workflow state**
  - **Current evidence:** `appBuilderWorkflowState` stores apply/validation/review receipts; `draftReconciliationState` stores roots, head/base identities, conflicts, validation progress, reviews, and proposals. [Workflow][workflow]; [candidate state][candidate-state].
  - **Consequence:** A surviving Eve session knows what existed, but those records do not preserve all underlying source bytes.
- **Apply workspace**
  - **Current evidence:** `materializeFreshApplyOverlay` currently returns `/workspace/repository`. Apply snapshots record path/mode/SHA-256 metadata and changes. [Apply implementation][apply].
  - **Consequence:** Despite the overlay terminology, saving only an old `.app-builder/apply` directory would miss current applied files. Baseline and working changes need separate logical identities even when they occupy one physical root.
- **Selected source restoration**
  - **Current evidence:** The Eve 0.68 Vercel provider has separate `start` and `resume` paths: it creates a named persistent sandbox with the selected source or reconnects through `Sandbox.get`. `openAppBaselineSource` restores a selected historical app baseline when it is missing before returning compute to source consumers. [Provider][backend]; [SDK session adapter][sdk-session]; [app baseline][app-baseline]; [baseline opening][baseline-opening].
  - **Consequence:** Freshly cloning the selected branch or restoring a historical baseline does not restore later unpublished app changes or private candidate resolutions. A branch may have advanced since selection.
- **Private reconciliation**
  - **Current evidence:** Preparation fetches head/base, creates a private Git worktree, stages reviewed unpublished edits, and merges the base. If that candidate disappears, preparation explicitly says prior resolutions and edits must be reapplied. [Candidate implementation][candidate]; [preparation tool][prepare-candidate].
  - **Consequence:** Preserve both unpublished apply changes and subsequent candidate-only edits, including unresolved merge state. Saving just the original reviewed changes is insufficient.
- **Publication**
  - **Current evidence:** The content source rereads reviewed file bytes from the live sandbox. Sealing and mutation bind the reviewed content, repository, parents, and approval; mutation uses the existing durable journal. [Content source][content-source]; [publication contract][publication].
  - **Consequence:** Recovery needs an authenticated durable content source, while publication still verifies the current reviewed result and live target. Storage is not approval.
- **Adapter replacement**
  - **Current evidence:** Recovery starts a new adapter using a prompt assembled from retained public events. [Recovery prompt][recovery-prompt]; [hosted service][hosted-service].
  - **Consequence:** A new adapter needs an authenticated workspace reference and structured recovery state. Asking the model to infer old private files from conversation would not recover them.

Current main declares Eve `0.68.0` and Vercel Sandbox `3.3.0`. The checkout's installed `node_modules/eve` was still `0.44.4`, so its bundled guide is version-stale for the current provider API. The current-main source reviewed here shows the custom Eve provider's `prepare`, `start`, and `resume` hooks, with persistent Vercel Sandboxes enabled for provider reattachment. That reattachment is a useful continuity path; full loss of the named sandbox still needs external source persistence and an explicit restore step. [Eve provider definition][backend]; [Vercel SDK adapter][sdk-session].

The public-session checkpoint service also stages paged transcript history, publishes its manifest and session pointer transactionally, and fences adapter replacement with a generation and expected checkpoint digest. The public ID for a new hosted session is currently derived after transport acceptance from the adapter session ID and operation ID. Durable workspace identity therefore needs a reserved start-operation binding and a safe transition to that public ID, not an assumed adapter ID. [Checkpoint store][checkpoint-store]; [hosted service][hosted-service].

Normal Vercel stop/resume can preserve a filesystem through provider snapshots. Provider persistence and complete loss of that persisted sandbox are different cases; a Builder recovery test must exercise the latter. Vercel also recommends an external database or object store for primary long-term data. [Vercel persistence documentation](https://vercel.com/kb/guide/vercel-sandbox-duration-and-persistence).

**2. Storage options and tradeoffs**

- **Tenant-scoped content-addressed manifests and byte chunks**
  - **Benefits:** Covers untracked files, binaries, deletes, modes, partial edits, non-Git prototypes, and structured conflict state. Deduplicates repeated contents. Can commit its pointer with session recovery metadata.
  - **Costs and gaps:** Requires a source inventory, streaming I/O, reference tracking, and explicit restore logic. PostgreSQL byte storage adds I/O and backup volume.
  - **Decision:** Primary format. Start with the existing database to avoid adding a provider dependency before evidence warrants one.
- **Private Git bundles in durable storage**
  - **Benefits:** Compact Git objects, trees, ancestry, and portable inspection; useful for retaining exact private synthetic commits or old parent objects.
  - **Costs and gaps:** A bundle alone omits working tree, index, untracked files, and merge-in-progress state. Needs private snapshot commits plus a sidecar, prerequisites for incremental bundles, tenant authorization, and GC.
  - **Decision:** Optional encoding/accelerator behind the same manifest contract; not the first authoritative format.
- **Incremental partial commits pushed to GitHub**
  - **Benefits:** GitHub stores commit objects; convenient later cloning.
  - **Costs and gaps:** Exposes unfinished work to repository readers and may trigger configured automation. Requires write authority, creates branch/update races, excludes unsaved working state unless committed, and conflicts with separate review/publication approval.
  - **Decision:** Reject for automatic recovery. An explicitly approved reviewed draft update remains supported publication.
- **Provider VM snapshots**
  - **Benefits:** Fast recovery of the same environment and dependencies.
  - **Costs and gaps:** Lifecycle/provider coupling and much broader filesystem capture, including runtime material. Does not independently survive loss of that sandbox's persisted state.
  - **Decision:** Keep as a performance optimization; it must be safe to lose every provider snapshot.

Git documents that bundles carry reachable Git objects and refs, not index or working-tree state. Creating a private snapshot commit does not require pushing it, but unresolved conflicts still require separate representation. Never use `git bundle --all` or copy `.git` as a convenient backup; that can capture unrelated refs and sensitive configuration/history. [Git bundle documentation](https://git-scm.com/docs/git-bundle).

Define a streaming `WorkspaceContentStore` interface so large byte objects can later move to approved private object storage without changing checkpoint semantics. That migration would retain the database as pointer/journal authority. It would stage immutable objects, verify them, then commit references; there is no claimed distributed transaction with object storage. Decide from measured database cost and throughput, without introducing a maximum app size.

**3. The durable model**

Use the existing authority tuple `(issuer, audience, workspaceId, ownerUserId)`, plus a stable public Builder session ID, as the authorization boundary. Never treat a content digest, sandbox name, adapter ID, or supplied object key as authority.

There is an identity-ordering change to implement: current new-session code derives the public ID from the adapter response after dispatch. For new sessions using durable workspaces, reserve the opaque public session ID and tenant/start-operation binding before dispatch, then settle the adapter mapping atomically after acceptance. Keep existing session IDs unchanged and migrate their mappings lazily. A reserved start is not a successful/publicly usable session; unknown starts retain their reservation for exact retry, and rejected starts can clean up their unreferenced staging. The first tool must never guess its public session ID from the provider's decorated sandbox name.

Proposed additive records:

- **`builder_workspace_head`**
  - **Essential fields:** Tenant tuple, public session, logical workspace ID, active checkpoint ID/digest, revision, writer epoch, active adapter generation, deletion state. Multiple logical roots belong to one atomic checkpoint.
- **`builder_workspace_checkpoint`**
  - **Essential fields:** Tenant/session/workspace, checkpoint ID, predecessor, operation ID, input digest, format version, manifest root, recovery-state reference, source identities, stage/commit status, recovery classification, timestamps.
- **Manifest pages / tree nodes**
  - **Essential fields:** Immutable, canonically ordered entries with logical root, repository-relative path, entry kind, mode, size, content reference, and explicit deletion operations where a delta is used.
- **Content objects / chunks**
  - **Essential fields:** Tenant namespace, SHA-256 byte digest, byte length, ordered chunk references and chunk digests, raw binary bytes in `bytea`, verified completion state. Empty files have a valid zero-byte object.
- **Workspace operation journal**
  - **Essential fields:** Tenant/session/workspace, operation ID, request digest, expected predecessor, writer epoch, intent, terminal result reference, committed checkpoint, sanitized failure state.
- **Recovery bundle**
  - **Essential fields:** Versioned source/app selection, accepted product artifacts by reference, build authority evidence, applicable workflow receipts, candidate state, outstanding requests, and publication journal references. Exclude credentials and live process handles.

Use a stable root label such as `source-input`, `app-working`, `planning-artifacts`, or `draft-candidate`; physical absolute paths are materialization details. Keep source provenance (repository ID, selected ref, observed commit/tree) separate from current content identity. The same branch name can legitimately resolve to a new tree.

Record a complete sanitized source-input tree once when acquiring or first checkpointing an existing workspace. Later manifests share immutable tree nodes and chunks. Keep before-images for changed paths reachable through that baseline; deletions retain their before-images. Recovery must not depend on an old commit remaining fetchable after a force push. For a fresh template or local development snapshot, retain the exact authored source input by the same mechanism. Dependencies, installation outputs, and caches remain reconstructible runtime data.

Hash actual bytes without newline conversion, JSON text encoding, or UTF-8 round trips. Keep filesystem permission bits and the corresponding Git mode explicitly; distinguish `644`/`755` from `100644`/`100755`. Preserve binary assets, empty files, mode-only changes, additions, deletions, and renames (a delete/add pair is sufficient for storage). Use framed canonical records or length-prefixed paths, not the current tab/newline snapshot output, for binary-safe inventory. Hash each chunk, complete content object, manifest page, and root using a documented versioned encoding. These hashes detect corrupt or mixed restoration; they do not reject ordinary source changes.

Persist symlinks as link metadata without following them. Restore only links whose resolution stays inside the owned materialization; a link into a credential or another tenant's root is an actual security failure. Retain unsupported special-entry metadata with an actionable diagnostic rather than silently declaring complete recovery. Never materialize devices, sockets, or privileged permission bits as executable source.

For a draft candidate, retain the original PR head/base IDs and trees, original unpublished-edit checkpoint, candidate working tree, synthetic local-tree identity if present, merge recipe version, and a structured index. The index must distinguish stage 0 from unresolved stages 1/2/3, with path/mode/object-content references. Preserve conflict-marker files and any unstaged resolution text separately from the index. Do not infer that a conflict was resolved merely because a path appears in a saved worktree. Recreate Git metadata through supported Git commands, never restore `.git` directories, absolute worktree pointers, hooks, or credentials.

**4. Atomic save protocol and concurrency**

1. Resolve current tenant/session authority and acquire the single workspace writer epoch. Bind it to the current adapter generation and public session. Reserve an operation with its full request digest and expected checkpoint revision. This can share the existing mutating-continuation policy, but needs a durable fence that also changes when compute is replaced under the same Eve adapter.
2. For deterministic file mutations, stage the proposed postimage bytes and intent durably before changing the sandbox. A retry with the same operation ID and identical input reads its journal result; changed input must receive a new operation identity. Do not deduplicate solely by Eve event ID or turn/step coordinates: a retried model step can produce different content.
3. Execute against the owned workspace. Serialize mutators and pause source-writing background jobs while capturing a checkpoint. Hash and upload a coherent source view. A preview can continue if its writes are confined to excluded runtime directories. A file watcher is an optimization for discovering dirty paths, not the consistency boundary.
4. Stream missing chunks and manifest nodes into immutable staging records outside the final transaction. Resume interrupted staging using recorded chunk identities. Verify completeness and actual byte digests. Do not hold a database transaction open while reading a VM or running a repository command.
5. In one short database transaction, verify tenant, active writer epoch, adapter binding, expected predecessor, and operation input digest; mark the complete manifest committed; advance the workspace pointer; store the corresponding recovery bundle/reference and terminal operation result. A durable session-to-workspace pointer must become visible in that same transaction. Concurrent public history observation must not overwrite it.
6. Only after commit, mirror the reference and relevant phase into Eve state and return success from the mutating tool. Eve state/stream persistence is not part of the PostgreSQL transaction. If the process fails in between, recovery loads the committed journal/reference and repairs the Eve mirror idempotently.

A lost commit response is an unknown outcome until exact operation readback resolves it. Never repeat the underlying edit or GitHub mutation simply because its response was lost. Uncommitted chunks are invisible to normal readers. A late writer from an old sandbox cannot advance the pointer or seal/publish a current proposal. Its already-running process may finish in its isolated old filesystem; fence its durable writes and reconcile/stop that compute independently.

For operations whose result cannot be known in advance, such as repository generation or compilation, persist a stable pre-command checkpoint and intent first, then capture a post-command checkpoint before reporting completion. On a returned failure, stop/quiesce the writer and preserve readable partial source as `interrupted` or `failed`, retaining the last settled checkpoint too. Do not label those bytes applied, validated, or reviewed. A disappeared VM can only recover the last committed boundary and any durable deterministic write intent.

If storage fails, preserve the last committed checkpoint, retain the live candidate where possible, and report which operation remains unsaved. Do not report its result as durably complete, silently drop a file, or clean up the only remaining copy. Retry with backoff and resumable chunks. Reads and unrelated sessions can continue; this is an actual persistence failure with a recovery path, not a workload admission gate.

**5. Checkpoint boundaries and implementation seams**

- **Source acquisition; accepted AppSpec/prototype/plan revision**
  - **Required durable action:** Preserve the exact source-input manifest and accepted artifact references before private work depends on them. Reuse existing durable prototype chunks rather than copying their text into another aggregate. Keep selected historical app-baseline receipts distinct from post-selection private changes; current `app-baseline` restoration covers its selected projection only.
- **`apply_app_creation` and existing-app apply**
  - **Required durable action:** Save accepted deterministic implementation inputs before execution; save the actual source result and apply/failure recovery state before returning `applied` or a recoverable partial result. Capture `/workspace/repository`, not an assumed historical overlay path.
- **Every candidate preparation**
  - **Required durable action:** Commit the candidate's initial merge/index state and references to the unpublished changes before reporting `ready_for_validation` or `needs_resolution`.
- **`edit_github_draft_pr_candidate` / `resolve_github_draft_pr_conflict`**
  - **Required durable action:** Commit each completed edit or deletion, mode, conflict/index state, and invalidated evidence before reporting `candidate_edited` or `resolution_written`.
- **Other source writes, removals, or commands that change source**
  - **Required durable action:** Route file APIs and mutating command completion through the same durable mutation boundary. Include generic Eve file/edit tools, repairs, schema compilation, local setup, and child-agent work if enabled. Complete a mutation-path inventory; success guarantees cannot depend on the model remembering to call a save tool.
- **Incremental candidate validation**
  - **Required durable action:** Save changed source after each command and bind the command result/progress to its checkpoint. Source-generating validation is itself a mutation. Preserve failed results without promoting validation.
- **Review and proposal sealing**
  - **Required durable action:** Pin the precise checkpoint behind each review and proposal. Persist complete-diff read progress separately from the file inventory. No sealed proposal references a staging checkpoint.
- **Waiting for product input/approval; turn completion**
  - **Required durable action:** Flush any remaining coherent private source and recovery metadata before claiming saved progress or releasing compute. These are additional boundaries, not the only autosaves.
- **Cancellation, failure, shutdown, compute release**
  - **Required durable action:** Capture stable partial work when the sandbox is available, then release through the existing lifecycle. A hard kill cannot be rescued by an end hook. Cancellation stops work; it does not delete the user's drafts.

Primary implementation locations are `lib/repository/target-apply.ts`, `lib/repository/sandbox-draft-reconciliation.ts`, the apply/edit/resolve/validate tools, `lib/agent/workflow-state.ts`, and `lib/agent/draft-reconciliation-state.ts`. Add focused `workspace-checkpoint` storage, manifest, and recovery modules rather than expanding publication receipts to carry file bytes.

Wrap supported sandbox file APIs and command completion at the existing `lib/sandbox/sandbox-command-adapter.ts` / source-bound sandbox seams. Use a reentrant mutation coordinator: one logical multi-file tool operation can stage multiple writes and commit coherently; low-level calls must not deadlock or recursively checkpoint checkpoint I/O. Structured command execution remains provider-owned. Do not add shell wrappers, scan arbitrary filesystem roots, or save command stdout as a substitute for source files.

Eve hooks are suitable for lifecycle cleanup, extra checkpoints, and diagnostics. They are too late to be the sole guard for a tool success already emitted to the stream. Prove that built-in write and command paths traverse the chosen adapter before promising full coverage; if the installed Eve interface bypasses it, add a supported tool/runtime interception seam or replace that mutating capability with a checkpointed authored equivalent. This is an implementation prerequisite, not assumed framework behavior.

**6. Recovery, including a moving source**

Use one `ensureRecoveredWorkspace` path before source consumers receive compute, integrating `openAppBaselineSource` and the current Eve 0.68 Vercel provider's `start`/`resume` lifecycle. Detect physical replacement through a server-owned workspace incarnation/materialization marker and provider metadata; `sandbox.id` alone can remain stable. Reassert the OIDC/tenant boundary and `allow-all` networking on replacement. Do not rely solely on the provider's normal `Sandbox.get` reconnect, the historical app-baseline restore, or a lifecycle hook to run after a lost named sandbox.

Recovery proceeds as follows:

1. Preserve the public session ID, cursors, replies, and outstanding requests. Resolve its latest committed workspace pointer. Revalidate current membership and live repository access before acquiring source. If access is missing, keep the private checkpoint and park the same session on the existing connection flow.
2. Fence the old writer, obtain fresh compute and credentials, and reconcile any pending outward-effect journal before allowing another dispatch. A previously successful publication remains successful; an unknown publication requires provider readback, not replay.
3. Stream the saved baseline and working/candidate data into a new private staging directory outside the source input. Verify bytes and modes there. Recreate safe Git/index metadata as needed. Switch the runtime's active materialization only when restoration is complete. On interruption, retry staging; never expose half-restored roots to the agent.
4. Independently observe the current selected branch and, for reconciliation, the current draft head and live base. If unchanged, activate the exact recovered private result. If changed, preserve the recovered old result and prepare a new integration result. Do not check out/reset the saved result onto the moving branch or overwrite unrelated new source.
5. Recreate dependency/runtime state through supported repository commands and caches only as needed. Ordinary source edits update the source input without rebuilding the dependency closure. Invalidate live preview/process readiness after a VM replacement; start and verify a new preview before presenting it as reachable.
6. Load the structured recovery bundle into Eve through an authored recovery initializer before its first mutating tool. For a new adapter, the host forwards a server-owned recovery binding containing the public session/workspace and reserved adapter generation, with exact current/initiating tenant authority. Reserve/fence before dispatch; after transport acceptance, activate the replacement with CAS. The bootstrap can read its authorized recovery bundle while reserved, but must wait for that activation before permitting mutations. Fence/cancel a losing adapter. The existing post-start adapter swap without this bootstrap binding is insufficient. A prompt or caller-supplied checkpoint ID is never authorization to hydrate another session.

For ordinary unpublished edits, merge saved baseline `B`, saved private result `W`, and current source `N` path by path, considering bytes, existence, and mode together:

- **`W == B`**
  - **Result:** Keep `N`; Builder did not change that path.
- **`N == B`**
  - **Result:** Restore Builder's `W`, including deletion or mode change.
- **`N == W`**
  - **Result:** Already incorporated; preserve it without duplicate edits.
- **Both changed differently**
  - **Result:** Attempt a normal three-way text merge; surface unresolved, binary, delete/modify, mode, rename, and path-kind collisions as conflicts. Never choose a side silently.

The union of paths includes new files in all inputs. New upstream files outside Builder's edits remain intact. Record a new source observation and checkpoint after integration; source movement is expected input, not a session-authority or digest-drift failure.

For draft reconciliation, rebuild the automatic candidate from the newly observed draft head/base plus the saved unpublished app changes. Then transplant candidate-only resolutions/edits using their saved before-images and result bytes against the rebuilt candidate. Retain the former automatic merge/index state to distinguish a user's resolution from conflict markers or changes inherited from the base. If a resolution no longer applies unambiguously, show that conflict with both saved and new content. Never rerun preparation in a way that silently discards those edits. Conflicts outside the selected app remain owner-managed under the current publication contract; they do not erase the private draft.

If old Git objects are no longer fetchable, the saved source and structured index preserve the content for recovery. Reconcile it against obtainable current parents before publication; do not forge an old commit identity or claim the original merge graph was restored. If no current authorized source can be acquired, preserve the session and explain the actual access/provider problem.

**7. Review, validation, and approval rules**

Keep current publication ownership rules: existing-app publication is limited to the selected app; fresh creation includes its required topology changes. A checkpoint may retain other private authored work for recovery, but saving it does not enlarge the publishable change set or authorize overwriting the source repository.

- **Healthy reattachment, same files and provider process**
  - **Required treatment:** Keep valid evidence. No new review or approval just to read saved state.
- **Exact byte/mode restore, same source and merge parents**
  - **Required treatment:** Retain product decisions and immutable content reviews with their checkpoint bindings. Treat dependency/process/preview claims as historical until the replacement environment is ready. Resume or rerun the necessary validation commands; never skip installation merely because an old `validationRun.nextIndex` survived.
- **Candidate/app edit, including a validation-generated change**
  - **Required treatment:** Invalidate validation dependent on changed inputs, source review, complete-diff read progress, sealed proposals, and approvals bound to the superseded result. Explicitly handle `validationRun`, not just `validation`.
- **Source/base/head moves, even with a clean merge**
  - **Required treatment:** Record new source and merge identities; recompute both applicable diffs and required checks. A reconciliation must obtain fresh review and approval because its parent bindings changed. This invalidates publication evidence, not the recoverable session or saved bytes.
- **Lost/corrupt checkpoint or uncertain semantic restore**
  - **Required treatment:** Retain the last verified version, label the gap, and prevent claims of exact recovery. No promotion from a summary or silently reconstructed text.
- **New Eve adapter**
  - **Required treatment:** Rehydrate only durable explicit decisions. Reissue unanswered product requests. Do not infer approval from an assistant message saying it was approved.

A publication approval may remain reusable only if its exact proposal, target, parent identities, complete reviewed bytes/modes, and recorded approval authority remain the same, required validation is current, and the existing approval protocol can verify that evidence. Sandbox identity alone is not a new reason to ask permission. If any binding changes, or the approval evidence cannot be restored through that protocol, reseal and request approval through the ordinary public flow. Review records retained as history must never masquerade as current approval.

Refactor the reviewed-content source to read from a pinned committed workspace checkpoint after observing the current result, or materialize and reobserve it before publication. Continue verifying postimage bytes/modes against the reviewed receipt, and verify current repository access and expected GitHub head/base immediately before mutation. Never force push, merge, deploy, or create a new remote ref as part of recovery.

Update the publication documentation's current statement that file content is never stored in any database row: the intentional new exception is the separate, private workspace-content store. Publication proposals, approval receipts, journals, ordinary logs, and public event payloads still contain references and metadata rather than raw source bundles.

**8. Isolation and secret exclusion**

Derive storage keys server-side using the same forwarded current/initiating authority rules as existing hosted stores. Include the complete tenant tuple in every read, insert, CAS, reference, and deletion predicate. Join requested content to an authorized session manifest; possession of a digest cannot read even another session's data without authorization. Initially deduplicate only within the exact tenant authority namespace, with no cross-tenant existence endpoint or shared public object URL. Bind a restored checkpoint to the intended app/repository/root before materialization.

Persist authored source and explicit Builder product artifacts, including untracked source. Exclude `.git` configuration/hooks/reflogs, package caches, `node_modules`, builds, browser profiles/reports, process logs, temporary archives, provider credentials, raw environment state, and provisioning/auth responses. Keep runtime setup and generated planning material outside the source tree; separately checkpoint authored planning artifacts that are needed for continuation. `.gitignore` alone is not a secret policy, and broad name exclusions must not silently discard legitimate authored assets.

Use an explicit credential-file exclusion policy and deterministic detection of known active credentials/key material before durable upload. Safe credential placeholders such as a verified example configuration can remain source. Never redact source bytes in place and then claim the original digest was preserved. If actual secret content is found in an authored file, exclude/quarantine that file from durable source storage, report a sanitized incomplete-save diagnostic, preserve the prior checkpoint, and require repair before claiming the new revision fully saved. Pattern scanning is defense in depth, not proof that arbitrary source contains no secret; keeping credentials outside writable source is the primary control.

Do not persist installation tokens, OIDC tokens, authorization headers, database passwords, cookies, or URLs containing credentials. Acquire fresh short-lived credentials on each required provider access and keep storage credentials in the trusted host, outside sandbox/model-visible state. Use existing managed database encryption/access controls and backups. Adding an object store later requires private access and the same host authorization, not public content-addressed URLs or static Sandbox keys.

Path containment and safe extraction protect tenant/credential boundaries. They must not become a fixed package-layout allowlist. Stream inventories and content with bounded per-operation buffers and backpressure; page complete history, manifests, and diagnostics. There is no total file, byte, revision, retry, app, or session-lifetime cap. Provider capacity failures are reported as provider failures with retry/recovery, following the [repository capacity policy][capacity].

**9. Lifecycle, cleanup, and diagnostics**

Compute expiration, cancellation, a completed turn, and successful publication do not delete private work. Retain committed checkpoints and their referenced content for the life of the saved session, consistent with explicit user deletion. Deduplication and manifest compaction can reduce storage while preserving all retained revisions. Changing revision retention later requires an explicit product policy; do not smuggle one into a GC threshold.

Garbage collection removes abandoned staging material and unreachable objects only. Claim abandoned stages using an expired writer lease/heartbeat and CAS, with a grace period for in-flight uploads; readers/restorers pin their manifest. Concurrent GC and commit must be safe. Check referenced publication/recovery records before deleting content they still need. Tombstone a deleted session first, fence every writer/restorer, then remove its references and collect unreferenced chunks in pages. A late retry must not recreate deleted work. Describe backup retention separately from active-store deletion.

Emit structured host diagnostics with public session ID, authorized internal tenant identifier, operation ID, adapter generation, workspace epoch, provider incarnation, checkpoint revision, phase, and sanitized code. Never log bytes, tokens, or the full recovery bundle. Preserve complete sanitized command diagnostics through authenticated paged reads; compact user copy should name the affected operation and next action.

- **`workspace_save_unavailable`**
  - **User-facing meaning and recovery:** “Your earlier edits are saved; this edit has not finished saving. Retry this session.” Keep live work when possible and retry staging.
- **`workspace_commit_unknown`**
  - **User-facing meaning and recovery:** Read the exact operation before retrying; do not claim either success or loss yet.
- **`workspace_content_missing` / `workspace_integrity_failed`**
  - **User-facing meaning and recovery:** Identify the last verified revision, retain later metadata for diagnosis, and avoid silent fallback presented as latest.
- **`workspace_restore_interrupted`**
  - **User-facing meaning and recovery:** Continue the same staged restore; expose no partially restored candidate.
- **`workspace_writer_fenced`**
  - **User-facing meaning and recovery:** Another continuation owns recovery; refresh the same session and return a retryable result.
- **`source_access_required`**
  - **User-facing meaning and recovery:** Keep work, reconnect the same repository through the existing product flow, then retry.
- **`workspace_reconciliation_conflict`**
  - **User-facing meaning and recovery:** Preserve both versions; present the actual conflicting product/source changes for resolution.
- **`workspace_secret_excluded`**
  - **User-facing meaning and recovery:** Identify the safe path/reason without revealing content; do not claim complete saving.
- **`workspace_legacy_bytes_unavailable`**
  - **User-facing meaning and recovery:** Explain that old metadata survives but the prior private bytes were never saved. Do not pretend a fresh clone restored them.

Measure checkpoint latency, staged/committed bytes, reused chunks, save failures, recovery duration, exact-restore success, conflict rate, abandoned stages, and late-writer rejections. These metrics inform capacity work; they are not new admission quotas. Keep public messages focused on saving/restoring progress and required action, without exposing digest machinery.

**10. Implementation sequence and rollout**

1. **Storage and identity contract.** Add versioned manifest/content/journal interfaces, additive Drizzle tables and readiness checks, tenant-scoped PostgreSQL implementation, and a small local-development implementation under the external state root. Define the stable public-session binding and writer fencing before integrating file writes. Reuse the existing checkpoint store's staging/CAS approach without mixing source bytes into public event pages.
2. **Capture and mutation integration.** Add the coherent inventory/streaming layer and mutation coordinator. Integrate apply, existing-app edits, candidate creation/edits/resolutions, generic mutating APIs, and source-generating validation. Store one recovery reference in versioned workflow/candidate state; migrate legacy state without rewriting old approvals or accepted bytes. Save-before-success is the acceptance criterion for this slice.
3. **Restore and adapter recovery.** Add `ensureRecoveredWorkspace`, provider-incarnation handling, resumable staging, baseline/current-source reconciliation, candidate index restoration, and authenticated adapter hydration before execution. Update source-access restoration to resolve the stable public-session binding instead of relying on an obsolete adapter session ID.
4. **Evidence and publication integration.** Bind validation, both candidate diffs, reviews, proposals, and durable approval evidence to the applicable checkpoint. Add durable reviewed-content reads and preserve existing mutation-journal recovery. Update lifecycle hooks, public progress wording, and docs; retain exactly five public MCP tools.
5. **Acceptance and controlled enablement.** Run focused tests during implementation, then one final local acceptance through `mise run dev`. Use exact-head CI for broad deterministic checks. Deploy schema/readers before writers; enable writes in Preview for selected test sessions, compare captured files with the live source, then exercise real replacement recovery. Production activation and migrations are separate authorized rollout steps.

One coordinator owns integration, publication, and rollout. After interfaces and file ownership are fixed, independent storage/manifest and capture/materialization slices can be delegated to smaller agents in isolated worktrees. Integrate before broad acceptance rather than creating overlapping writers or separate speculative verification lanes.

Keep existing sessions readable. Backfill a private checkpoint only when their original sandbox bytes can still be observed; absent bytes cannot be recovered from receipts. New readers must understand both legacy and new states before enabling new writers. A rollback stops new checkpoint writes only for sessions not yet dependent on them, or parks dependent mutators with an explicit recovery message. Keep compatible restore readers and all committed data; rolling back must not silently revert saved sessions to metadata-only recovery or disable saving while still acknowledging durable edits.

**11. Tests and the sandbox-replacement acceptance**

Focused implementation tests should cover these failure predicates, not merely mirror helper implementations:

- Round-trip raw binary/empty/CRLF/non-ASCII files, additions/deletes, executable and mode-only changes, new authored paths, and safe links; verify exact bytes and modes. Confirm exclusion of actual credential files and runtime output without hiding legitimate source.
- Crash injection after intent, each upload boundary, manifest completion, database commit, lost response, Eve-state update, and partial restore. Readers see an entire committed revision or the previous one; exact retries do not repeat an edit. Mid-command failures remain interrupted rather than validated.
- Two competing continuations, stale adapter and old VM writers, forged tenant/session/root/content references, membership revocation, and delete-versus-write/restore/GC races. Include PostgreSQL transaction tests, not only an in-memory store.
- Moving-source merge matrix: unrelated additions, overlapping text, binary edits, add/add, delete/modify, mode conflicts, upstream already containing the change, and old commits no longer fetchable. No normal source movement becomes an unrecoverable session error.
- Candidate restoration before resolution, after one resolution, after an unstaged candidate edit, during incremental validation, after both diff reads, and after sealing. Restore stage 0/1/2/3 state and all candidate-only bytes; invalidate the specific stale evidence and preserve product decisions.
- Publication journal pending/succeeded/unknown outcomes across replacement; exact provider readback wins. No backup path can create a remote ref or bypass expected-head update, review scope, or approval.
- Many manifest pages, many revisions, a file spanning many chunks, slow storage, and resumable uploads. Working memory remains bounded per operation; no arbitrary total truncation or limit appears.
- Legacy live backfill, legacy missing bytes, additive state migration, reader/writer rollout compatibility, and ordinary stop/resume versus actual replacement.

The acceptance exercise uses the supported public Builder surface for product work and a separately identified fault-injection controller for sandbox loss and fixture branch movement. The controller is part of the acceptance harness, not an implementation assistant that supplies missing files or drives private workflow stages. Preserve every public session ID, cursor, request, approval, and reply. This proves recovery; it is not by itself a self-reproduction claim.

1. Start one new-app session from a product brief using `autograph_start` or the web flow. Give only ordinary product answers and build approval. Obtain a working unpublished app containing a changed text file, an untracked binary asset, an executable or mode change, and a deletion through the supported workflow/fixture. Record the committed checkpoint and an independent file inventory as test evidence. Withhold publication approval.
2. Make the original physical sandbox and all its provider filesystem snapshots unavailable through an explicitly authorized disposable test resource or provider test seam. Require a new provider incarnation with an empty workspace. Clear process-local source/handle maps. Merely calling `stop()` is not sufficient.
3. Resume the same public session. Verify all acknowledged file bytes, modes, additions, and deletions return, saved product decisions remain, and a new working preview is actually reachable. Confirm no GitHub refs/PRs changed and no publication was dispatched. Repeat with the original Eve adapter unavailable to exercise authenticated structured hydration and adapter fencing.
4. In a second public session on a disposable, provenance-valid Builder draft, cause a real head/base conflict. Through normal product interaction have Builder prepare a private candidate, resolve one app-owned conflict, and make one candidate-only edit that was never part of the original apply receipt. Capture its checkpoint and both working/index state. Withhold draft-update approval.
5. Remove that sandbox and snapshots. Resume the same session with unchanged parents: assert the private resolution, candidate-only edit, conflict state, and unpublished apply bytes survive exactly. Assert validation resumes safely in fresh compute and the prior preview is not claimed live.
6. Repeat from the saved fixture while advancing the draft head or base through the fault controller. Include an unrelated upstream addition and an overlapping change. Verify the unrelated file survives, saved edits remain recoverable, real conflicts are presented, and the obsolete proposal/approval cannot update GitHub. Review both current diffs after resolution. GitHub remains unchanged until the separately requested exact update is approved.
7. Inject storage failure and a lost commit response on a candidate edit, then crash before Eve mirrors its state. Verify acknowledged work is never lost; unknown outcomes are resolved by journal readback; incomplete work is identified accurately. Attempt a stale writer, another tenant's restore, and restore after explicit session deletion.
8. For the final publication leg only, explicitly approve the reviewed update to the disposable draft. Verify one expected-head, non-force update with the correct parent/content bindings, a still-draft PR, and no merge/deployment. If that external action is not authorized, run it against the provider emulator and label live publication acceptance unproven.

Pass only when the evidence includes the old/new physical provider identities, the same public session identity, exact recovered inventories, durable operation/checkpoint readbacks, preserved upstream content, correct conflicts and invalidations, and an absence of unauthorized provider mutations. A successful clone, a surviving chat, HTTP 200, or a passing mocked restore alone does not meet this acceptance.

[checkpoint-store]: https://github.com/withAutograph/autograph-app-builder/blob/79179b2613c7847f65c5f5745686ba13591452f9/lib/eve/postgres-hosted-checkpoint-history.ts
[hosted-service]: https://github.com/withAutograph/autograph-app-builder/blob/79179b2613c7847f65c5f5745686ba13591452f9/lib/eve/hosted-service.ts
[workflow]: https://github.com/withAutograph/autograph-app-builder/blob/79179b2613c7847f65c5f5745686ba13591452f9/lib/agent/workflow-state.ts
[candidate-state]: https://github.com/withAutograph/autograph-app-builder/blob/79179b2613c7847f65c5f5745686ba13591452f9/lib/agent/draft-reconciliation-state.ts
[apply]: https://github.com/withAutograph/autograph-app-builder/blob/79179b2613c7847f65c5f5745686ba13591452f9/lib/repository/target-apply.ts
[source-binding]: https://github.com/withAutograph/autograph-app-builder/blob/79179b2613c7847f65c5f5745686ba13591452f9/lib/agent/source-bound-sandbox.ts
[source-restore]: https://github.com/withAutograph/autograph-app-builder/blob/79179b2613c7847f65c5f5745686ba13591452f9/lib/agent/restore-selected-github-sandbox-source.ts
[backend]: https://github.com/withAutograph/autograph-app-builder/blob/79179b2613c7847f65c5f5745686ba13591452f9/lib/sandbox/vercel-backend.ts
[candidate]: https://github.com/withAutograph/autograph-app-builder/blob/79179b2613c7847f65c5f5745686ba13591452f9/lib/repository/sandbox-draft-reconciliation.ts
[prepare-candidate]: https://github.com/withAutograph/autograph-app-builder/blob/79179b2613c7847f65c5f5745686ba13591452f9/agent/tools/prepare_github_draft_pr_reconciliation.ts
[content-source]: https://github.com/withAutograph/autograph-app-builder/blob/79179b2613c7847f65c5f5745686ba13591452f9/lib/agent/github-publication-content-source.ts
[publication]: https://github.com/withAutograph/autograph-app-builder/blob/79179b2613c7847f65c5f5745686ba13591452f9/docs/github-publication-gate.md
[recovery-prompt]: https://github.com/withAutograph/autograph-app-builder/blob/79179b2613c7847f65c5f5745686ba13591452f9/lib/eve/hosted-recovery-prompt.ts
[capacity]: https://github.com/withAutograph/autograph-app-builder/blob/79179b2613c7847f65c5f5745686ba13591452f9/docs/builder-workload-capacity-policy.md
[sdk-session]: https://github.com/withAutograph/autograph-app-builder/blob/79179b2613c7847f65c5f5745686ba13591452f9/lib/sandbox/vercel-sdk-session.ts
[app-baseline]: https://github.com/withAutograph/autograph-app-builder/blob/79179b2613c7847f65c5f5745686ba13591452f9/lib/agent/app-baseline-state.ts
[baseline-opening]: https://github.com/withAutograph/autograph-app-builder/blob/79179b2613c7847f65c5f5745686ba13591452f9/lib/agent/app-baseline-sandbox.ts
