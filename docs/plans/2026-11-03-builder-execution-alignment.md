# Builder execution alignment: audit and repair plan

Status: read-only sweep and implementation plan, 2026-11-03. This supplements
the [A-469 repair scope](2026-11-03-a469-repair-closure-scope.md). It does not
claim a working app, hosted acceptance or a shared release. Paused implementation
branches and all saved work remain preserved.

## What actually happened

The earlier diagnosis conflated a freshly loaded package, retained execution
metadata and a newly dispatched tool. Those are different observations.

| Retained event | UTC timestamp | Result |
| --- | --- | --- |
| Turn 16 requested the planning tool | Nov 3, 22:13:59.366 | A real reconciliation attempt started. |
| That tool returned its conflict | Nov 3, 22:15:27.523 | The recorded failure belongs to turn 16. |
| Turn 17 received the new continuation | Nov 4, 00:03:22.986 | Its message matched the submitted request exactly. |
| Turn 17 read workflow status | Nov 4, 00:03:39.545–39.746 | It read retained `validation_failed` metadata. |
| Turn 17 completed | Nov 4, 00:03:46.928 | No planning, reconciliation, validation or preview was dispatched. |

These times come from retained stream-chunk creation timestamps, not provider
command start times. The current package and framework generation contain the
new source-history reader. An older retained runtime-revision string is not
proof that a new callback executed that bundle. No speculative generation/cache
bypass or opaque saved-state rewrite is justified by this incident.

## Required execution contract

- New work on an idle local session uses the current selected development
  generation. Working-tree edits, package construction and process startup are
  distinct from that generation actually executing a tool.
- Runtime edits leave the existing Eve instance pinned until a supported
  activation/restart is selected. Next HMR is independent. The plugin package
  fingerprint covers plugin/skills/MCP registration inputs, so `packageReused`
  does not identify the executing agent code. Show selected versus available
  runtime changes in developer diagnostics without silently restarting sessions.
- An in-flight continuation may intentionally retain its original generation.
  Keep its pending call, approved intent and uncertain effects intact. Historical
  checkpoints remain immutable; switching code must not replay their actions.
  Determine idle versus in-flight from the kernel's turn/continuation state,
  rather than assuming that a public `waiting` label means a new idle turn.
- Report the actual request, native message/turn, tool call, selected bundle and
  command receipt separately. An assistant answer or a workflow-status read is
  not evidence of a new build attempt.
- Exact worker versions frozen into approved plans remain exact. "Current"
  does not authorize substituting a newer executable or moving an old approval
  to a changed target. Git recency and branch ancestry are not deployment
  authority.
- Ordinary source edits remain inexpensive planning inputs. Do not introduce
  blanket hash/version admission gates, artifact rebuilds per edit, quotas,
  automatic cancellation or forced migration of live sessions.

## Sweep results

| Boundary | Established result | Remaining action |
| --- | --- | --- |
| Live source to package/runtime copy | Current copied planning/history/tool files match the checkout; the current authored bundle contains the reader. Plugin fingerprinting and runtime copying are separate. | Exercise a real new tool dispatch; `packageReused` alone cannot close it. |
| New idle turn versus in-flight resume | Documented Eve behavior preserves in-flight generations and hands new idle work to the latest selected development generation. | Verify the actual turn classification and both dispatch behaviors, rather than revision-string scans. |
| Request to progress/evidence | Turn 17 ran only a status read; our diagnostic helper selected the last failure across all history. | Add a typed per-turn attempt summary and fix report/guidance consumption. |
| Recovered history | Plain original-run history selects the old receipt; protected stitched history selects the genuine completed transport. | Qualify the protected-cycle resolver candidate; disallow silent downgrade when recovery context is unavailable. |
| Parallel local instances | The supported entrypoint isolates worktrees, ports, state, destinations, output paths and client connections. | Include two-instance dispatch/recovery coverage; preserve other active sessions. |
| Generic installer choice | An exact app mapping wins, but generic fallback takes the first compatible catalog entry. | Require an explicit or unique compatible descriptor; deduplicate identical aliases and reject ambiguity. |
| Base versus resource-profile configuration | A selected resource profile supplies its complete filesystem/catalog, not an inherited merge of base updates. | Review and qualify each effective configuration used by actual requests. |
| Existing installer filesystem | Readback verified seven configured legacy executable hashes and Bun 1.4.2 in the operator snapshot. | Preserve these paths while adding the new installers; conflicting hashes at one path require separate qualified sources or reviewed paths. |
| New integration worker choice | Separate integration-only resource selection is implemented in source; old generic selection is retained. | Complete explicit v2 resource pins and compatibility tests before release. |
| Source to compiled worker artifact | The 3ada bundle has exact source/tree/receipt and executable hashes. Approved Linux qualification ran direct source capture and the maintained protected TLS/control-plane suite. | These observations do not cover the newer v2 candidate or every resource/schema SQL executable mode. Build and qualify the final integrated cut. |
| Public release and revision | Source now has explicit public bindings, native ingress and real default ports; existing readbacks bind accepted provider identity, aliases and loaded Auth/runtime state. | Exercise the actual public create/release/revision journey. READY or source tests alone are insufficient. |
| Integration delivery configuration | The v2 destination/key work is preserved but not yet integrated; the old name-only/global-key path is insufficient for two app destinations. | Finish exact approved destination identity, private per-destination keys and no-resend recovery. |
| Central infrastructure target | The configured shared target inherits unrelated Preview credentials. | Resolve its isolated destination explicitly before effects; do not adopt an arbitrary project or alter customer settings. |

The sweep found no additional deployment-selection bypass in the reviewed
current-deployment/domain/alias and loaded-configuration paths. Browser,
provider and canonical-data behavior still require exercised acceptance.

## Implementation order

### 1. Correct evidence and continuation reporting

Use existing native events to expose a maintained read-only summary containing
the accepted message/turn, current-turn tool attempts and the last historical
attempt separately. Preserve cursor, owner lineage and existing command IDs.
Derive it from `actions.requested` and `action.result`, not assistant wording or
the last matching result anywhere in the transcript. Retain bounded identifiers
and dispositions; never log source payloads, credentials or raw provider bodies.

Keep `artifact_workflow_status` explicitly historical. Guidance for a build
continuation should identify when normal current-source planning is still
unexercised. A status-only response must not be called a rerun or a failed repair.
Do not force tools for status questions or automatically replay pending calls.

### 2. Qualify the runtime lifecycle without changing working semantics blindly

Run a focused actual Eve restore/dispatch regression:

1. Start with generation A and dispatch an observable fixture callback.
2. Load B while an A call is in flight. Its existing continuation keeps A.
3. Start a new idle turn. Its newly dispatched callback uses B.
4. Stop/resume the same owned session. Verify actual dispatch, saved data,
   cursor and approval history together.
5. Repeat with two isolated instances; neither may select the other's bundle,
   state, actor jars or recovery lineage.
6. Include an uncertain/pending effect and prove no duplicate dispatch or
   changed approval meaning.

Exercise both static and dynamic tools. An old dynamic-runtime revision marker
must not be treated as proof about a newly dispatched static callback. A resumed
workflow can contain older metadata while current code is available; only the
actual dispatch and its resolved artifact establish which callback ran.

Observe the callback's resolved artifact, not only a server generation label.
If these supported semantics pass, retain them. Change generation binding only
for a reproduced violated invariant, using official APIs and a fresh owned
continuation; never patch compressed historical blobs.

### 3. Close deterministic history and installer selection

Review the protected-cycle resolver candidate against the actual stitched
history. Preserve explicit valid configuration; an explicit missing/foreign
cycle must fail rather than fall back elsewhere. A legacy missing cycle value
may resolve only through the canonical state root already bound to that owner.

Make generic installer fallback order-independent. Exact app declarations retain
precedence. Reconstruct previously frozen plans from their retained approved
artifact; a new compatible candidate is not permission to replace it.

Test different base/profile catalogs through the actual request-scoped factory.
Verify which filesystem and executable the request really selects, including
missing specialized slots, distinct compatible versions and harmless key order.

### 4. Assemble one reviewable release cut

Finish the preserved public-binding and v2 destination/resource-pin mechanics.
Record one release map containing the actual Builder/operator artifact, selected
Arrusted source, exact compiled worker receipt, immutable filesystem source and
effective base/profile catalogs. Preserve all legacy executable paths needed
outside this acceptance run.

Qualify the final compiled resource, schema and app worker modes through strict
TLS, SQL, full-plan and checkpoint/acknowledgement behavior. Build the deployment
snapshot from a fresh code-only base before any credential or SQL fixture enters
it. Earlier 4278/3ada observations remain labeled to those versions.

Use the single bundled shared release already selected by the user for the
genuine hosted flow. Verify actual operator source, Builder endpoints and both
public aliases; do not infer that a local restart updated either service.

### 5. Resume and complete functional acceptance

After qualification, resume the saved local app through ordinary Builder
controls and verify a genuinely new planning call. Review its fresh Build
approval, preserve the same workspace/data, and obtain a working private app.
If a turn performs only a status read, report it as unexercised.

Then exercise the hosted normal create/public release/revision journey, public
BetterAuth and persistent action, real approved QuickBooks Sandbox reads,
two-app/two-tenant/unassigned isolation, replay, drain and optional removal.
Keep each evidence class separate. Do not resend
`a469-preview-target-approved-batch`, fabricate settlement, clean up resources
or include the A-481 customer Production rollout.
