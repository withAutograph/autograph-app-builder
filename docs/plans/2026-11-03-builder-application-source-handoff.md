# Builder application source handoff

Status: proposed contract, 2026-11-03. Documented before implementation. This
closes a gap in the [execution alignment plan](2026-11-03-builder-execution-alignment.md);
it is not evidence that export, upload, hosted transfer or acceptance has run.

## Product outcome

A developer gets the saved app working in the local Builder, then asks that
same public chat, “Save this app so I can continue online.” Builder returns a
source artifact download. In the normal signed-in Builder web flow, the user
selects that file and continues through an opaque handoff using the existing
five public tools. Hosted Builder reviews and builds the source normally, then
requests fresh approvals to publish and deliver it to its actual destination.

Local development remains the fast edit loop. One bundled shared release carries
this capability for final hosted acceptance. Do not add authenticated local
publication, a separate integration backend, evaluator-only commands or another
public tool. Do not require the evaluator to copy files into a private Sandbox,
run an export CLI, publish the app manually or steer internal workflow stages.

## Existing routes and the missing boundary

- Normal authenticated existing-repository acquisition already works when the
  intended source exists on a user-authorized GitHub branch or PR. It cannot
  acquire unpublished local changes.
- Main's existing-draft recovery reconstructs genuine owned review lineage and
  verifies candidate/publication bindings. It neither reviews changed candidate
  bytes automatically nor imports a local-development principal or workspace.
- The default local profile disables GitHub/fresh/branch publication and hosted
  artifact proof. Machine OIDC is not human/workspace authority.
- Hosted `resumeSessionId` requires that authenticated owner's hosted store row.
  Web handoffs currently carry intent and server-owned provisioning receipts,
  not application source. Existing-session attachment calls the original HTTPS
  Builder; it does not move a local run or execute local changes remotely.
- Drive reuse restores a session's recorded workspace. A Drive name, local run
  ID, source SHA or uploaded project ID cannot select hosted ownership.

The missing mechanic is source continuity between these existing product paths.
A shared code release alone does not provide it.

## Public local export

An ordinary `autograph_send` request drives a new internal Eve source-export
tool. That internal tool is not a sixth public MCP tool. It uses a shared pure
manifest/capture implementation; an optional development mise task may invoke
the same implementation, but is never the required acceptance route.

Capture the current accepted app from its actual owned workspace. Resolve its
app ID, root and source binding from the accepted workflow, not request prose or
an evaluator path. Acquire the existing workspace/source lease and current
owner/cancellation guards; capture while app authoring/apply work is idle.
Read actual files through supported Sandbox file APIs and verify a consistent
manifest/readback. A changing workspace remains unchanged and reports that the
capture must be retried after its current work finishes. Export does not cancel
work, rebuild the Sandbox, force validation, mutate Git or require a green test
suite merely to preserve source.

Return a normal public artifact/download link through the existing session
results. Give it a distinct application-source artifact kind and namespace;
do not label an untrusted source candidate as a rendered prototype, reviewed
release or provider-verified Git source. Bind local artifact reads to this
instance's owned storage and session; another port, branch or session must not
select its files. The public reply reports app ID, captured candidate digest,
included paths and explicit omissions. Deliver untrusted source as an attachment with
`Content-Disposition: attachment` and `application/octet-stream`; never render
uploaded HTML/SVG/script content inline or execute it in the download surface.
A missing accepted app/root or an unavailable file is a specific recoverable
result, not a replacement export.

## Source format and retention

Use a versioned manifest with streamed/chunked file bytes, not executable
capture instructions or arbitrary archive extraction:

- `kind: builder-application-source-v1`, original app ID and source format;
- canonical ordered file inventory containing path, mode, raw byte length and SHA256;
- a declared content encoding per chunk, supporting app-owned binary/static
  assets through base64 as well as text; verify raw bytes independently of the
  storage encoding;
- manifest/content digest and actual byte/file totals;
- advisory local provenance only when actually observed: source/tree,
  candidate digest and local session label.

Digests identify captured bytes; they are not a recency gate for ordinary edits.
Later app edits can produce another artifact without invalidating saved work or
altering the prior artifact. Transport limits bound individual untrusted calls
and continue via chunks/backpressure/recovery; add no arbitrary total app size,
file, history, attempt or lifetime quota.

Include app-owned source and required app-owned schema inputs. Platform changes
belong in the separately reviewed shared release. Exclude credentials, `.env`,
Git internals, local custody, database data, cookies, native journals, approval
receipts, provider responses and execution/cache output. Reject unsupported or
unsafe entries such as traversal, duplicate/case-colliding paths and symlinks;
report omissions explicitly instead of silently losing app content. A format
that cannot carry an app asset must fail visibly or ask an ordinary product
question; UTF-8-only capture cannot silently omit images or other source assets.
Inspect for
secret-bearing content before making a download available; path exclusions
alone are not a claim that every code file is free of secrets. Preserve the
original workspace/resources regardless of export success or omissions.

An imported app specification is source material. It is not an accepted hosted
AppSpec or a private-build/publication approval. The hosted workflow must retain
its ordinary questions, source review and concrete approvals.

## Authenticated web upload and handoff

Extend `app/actions/builder.ts`'s authenticated continuation and its
`getAuthenticatedBuilderDraftContext` / `BuilderContinuation` composition. Use
same-origin Server Actions with the form's normal `useActionState` flow for
chunk upload and finalization. Authenticate the
current user/workspace with the existing web session and recheck membership
around I/O. Do not introduce a new upload REST backend or pass browser cookies,
provider credentials or local authority to the local instance.

Create an opaque upload scope server-first. Store immutable source chunks and a
completion manifest through a separate source-handoff adapter over the existing
`prototype_artifact_chunk` table. Use its own private namespace and owner/scope
keys. Do not broaden public prototype readers or the protected generated-release
namespace to accept uploaded code. A pre-session upload/handoff scope is storage
identity only and must never satisfy an operator's canonical Eve-session reader.
If using the existing table would require that confusion, bind the upload to a
real new hosted session waiting for source instead; do not invent a session row.

Bind the immutable upload header and chunk keys to a server-derived digest of
its owner-scoped `uploadRequestId`, not a caller-claimed content digest. The
existing table primary key includes `transferDigest`; letting a caller vary that
value would otherwise admit two contents under one upload identity. A repeated
header with changed app, inventory or content must conflict in the same namespace.

Acknowledge completion only after exact content/hash readback, with the manifest
committed last. Partial/foreign artifacts cannot be selected. Same request and
content is idempotent; changed content under the same request conflicts. Unknown
completion is reconciled through readback, never replaced by a blind new upload.
No automatic cleanup or resource deletion is implied.

Persist only the opaque `sourceCandidate` reference in the normal Builder draft
across sign-in/OAuth and page reload. Before creating a handoff, resolve it against
the completed immutable artifact and current membership again. A display name
change must not derive a replacement app ID: preserve the candidate's original
app ID through draft, handoff, provisioning and source acquisition. Repository
and project references in the file are advisory and never grant ownership.

New handoff intents may carry a closed optional `sourceCandidate` reference with
artifact ID, app ID and manifest digest. Omission preserves old handoff meanings
and request digests. Creation resolves the server-owned artifact; redemption
uses existing one-session/CAS ownership. Renewal cannot change source content or
target meaning. Continue with ordinary `autograph_start({handoffId,
clientRequestId})`; all five public tools remain unchanged.

## Hosted acquisition and publication

1. Revalidate the authenticated handoff owner/session and completed artifact.
2. Obtain the supported platform/repository source in a private Sandbox using
   normal signed-in repository access. Never attach the local Drive or accept
   an arbitrary workspace/snapshot locator from the artifact.
3. Stage only app-owned source paths and read back their actual bytes/modes and
   app identity. Preserve an occupied or conflicting accepted workspace; use
   normal visible source-selection/reconciliation behavior rather than overwrite.
4. Preserve the genuine platform `SourceReceipt` from canonical clone or
   authenticated GitHub acquisition and pair it with an explicit application
   source-import receipt/state. That second receipt binds the actual hosted
   owner/session, artifact, app and imported byte digest; it carries no approval.
   Show both through normal source status. Local claimed Git identities are not
   provider observations or canonical fresh-template proof. Inspect source as
   data, then use normal existing-app planning and build approvals. Do not let
   a fresh-template shortcut overwrite or silently approve the imported app.
   Expand `SourceKind` only if required to preserve that distinction; do not
   replace genuine base-source provenance with an uploaded claim.
5. Use normal Builder authoring, validation, reviewed change sets and approved
   native Git publication. Only genuine provider readback records publication
   completion. Preserve original app content; reconcile platform compatibility
   through the shared workflow instead of making the evaluator finish the app.

### Canonical platform acquisition identity

A new hosted fresh-template acquisition explicitly requests the canonical
`refs/heads/main` revision from the Git source adapter. Before issuing its
main-labelled platform receipt, independently observe the repository URL,
actual HEAD/tree and resolved canonical branch commit in that same checkout;
HEAD must equal that observed canonical branch commit. A provider default branch
or an occupied checkout for the same remote is insufficient evidence of main.
This check applies to new acquisition, including a preexisting provider-created
checkout encountered during that acquisition. On mismatch, preserve the checkout
and report a source-selection prerequisite; never silently reset, rebase, fetch
or replace it to make it pass.

Existing saved sessions retain their original frozen source receipts and actual
workspace binding. Reinspection must not refresh their branch or reinterpret a
historical commit as the latest main. Uploaded app source stays paired with the
actual selected platform receipt and cannot select its old local platform. The
final shared platform must be published to canonical main before starting the
final hosted acquisition; a current worker image or unpublished branch does not
update that source. This is source acquisition provenance, not Git ancestry as
deployment authority.

Qualification must cover a provider whose default branch differs from main,
an occupied same-remote checkout at the wrong revision, a genuine main checkout,
and unchanged reinspection of a previously saved frozen receipt. Preserve both
platform and app-import receipts and app-owned specification/schema history.

Keep source and destination decisions separate. Reuse an existing Supplier Spend
repository/project only when exact owner-scoped settled normal provisioning
receipts and independent GitHub/Vercel readback agree. Do not adopt by name,
local remote URL or artifact claims. If no owned destination exists, ordinary
Builder creation provisions it once. A second acceptance/Preview/Auth project
for this same app is not a fallback.

Hosted runtime/publication/integration effects receive fresh normal approvals
for their actual source, destination and exposure. No imported session, journal,
installation, database, Auth state or approval supplies authority. Preserve the
local run and all old hosted operations, especially the uncertain
`a469-preview-target-approved-batch`; never resend it or fabricate settlement.
The new authenticated session has source continuity, not migrated local authority.

## Bounded implementation ownership

| Layer                        | Change                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pure source contract/capture | A repository-owned manifest/capture module and focused tests; optional source-export mise task uses this same implementation.                                                                                                                                                                                |
| Local public workflow        | Internal Eve export tool and existing tool registration; owned accepted-source capture and normal artifact result/download integration. No new public MCP tool.                                                                                                                                              |
| Authenticated web            | `app/actions/builder.ts`, `getAuthenticatedBuilderDraftContext`, existing `BuilderContinuation`/`useActionState`, and a small `app/actions/source-handoff.ts` adapter for opaque chunks/finalization. Keep draft selection across OAuth and original app ID independently of display-name normalization.     |
| Private source storage       | Separate immutable source-handoff adapter/namespace in existing artifact storage; completion-last/readback/owner checks. Existing public prototype validation remains unchanged.                                                                                                                             |
| Handoff                      | Optional new sourceCandidate contract plus create/read/redemption checks. Preserve absent-field legacy digests and immutable intent.                                                                                                                                                                         |
| Hosted source acquisition    | Small handoff consumer and paired applicationSourceImport receipt/state beside genuine platform SourceReceipt; show both in source status and route private staging/readback into normal existing-app planning/review/build/publication. No forged GitHub proof or bypass of current draft lineage recovery. |
| Documentation                | This contract, execution alignment and lifecycle/public handoff usage describe what is implemented and what has actually been exercised.                                                                                                                                                                     |

Keep local filesystem exporter dependencies out of hosted imports. No privileged
operator, central integration backend, auth protocol or provider permission
expansion is required for source continuity itself.

## Verification and A-469 evidence

Focused checks exercise changed/foreign/partial artifact denial, exact readback,
unsafe or secret-bearing omissions, conflicting retry/recovery, old handoff
compatibility, app ID through OAuth, occupied-source preservation and explicit
source proof classification. Keep real approval/tenant/cancellation checks;
do not assert incidental file counts, source strings or fixed generated models.

Then exercise the actual product path: saved local chat request → exported public
artifact → authenticated web selection/handoff → five public tools → ordinary
hosted source review/private build → fresh approved publication → independently
observed same destination. Compare captured/imported app content, destination and
existing data. A CLI export, fixture, bundle READY or passing tests does not close
this row. Finish public BetterAuth, persistent action, normal revision, real
QuickBooks Sandbox, two-app/two-tenant/unassigned, replay/drain and optionality
acceptance separately. Customer Production rollout and cleanup remain outside
this run.

Canonical acquisition qualification uses real local Git repositories whose provider default branch differs from `main`. It also covers a wrong occupied checkout, a frozen saved receipt after branch movement, and app-only import onto a newer platform sentinel. These source checks do not establish hosted deployment or provider activation.
