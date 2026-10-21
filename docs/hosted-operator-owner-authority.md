# Hosted operator owner authority

The owner receiver accepts requests only from the configured Builder workload
identity. Its OIDC issuer, audience, subject, owner, project, and environment
are mandatory deployment policy; there is no default verifier. The request's
owner tuple is a lookup hint. The receiver re-reads the owner-scoped handoff,
the canonical public Eve session, active workspace membership, and the selected
Vercel installation and project before deriving its journal target. It repeats
those reads before each protected effect and fails closed when any read is
missing, ambiguous, stale, or mismatched.

The Builder forwarding service must derive the hint from the authenticated Eve
session context. A Vercel workload token authenticates that service; it does
not independently attest the human principal. Hosted readiness therefore also
requires deployment evidence that user-controlled app code cannot obtain the
trusted Builder workload credential or call this receiver outside that
forwarding path. This adapter performs no production or provider mutation.

Approval reads use the owner-scoped private Eve receipt. The receipt must be a
terminal approval by the current owner and its closed tool input must bind the
current operation reference, selected action, selection, and exact frozen plan
digest. Missing, denied, conflicting, or stale approvals do not authorize an
effect.

Fresh approval can settle before the background observer saves its private
receipt. During execution, Builder reads the existing receipt first. Only when
it is missing, Builder makes one owner-bound native observation using its own
workload identity and the canonical Builder origin. The existing recorder saves
actual native approval requests and terminal settlements. Builder then reruns
the unchanged approval reader, including after an observation failure, so a real
receipt saved concurrently can still authorize the existing operation. Stored
approvals retain their fast path; this adds no polling or technical reapproval.

Keep this capture on Builder. Eve's native route authentication does not enforce
session ownership, and its authentication policy also covers mutation routes.
A blanket Operator workload grant would expose unrelated native sessions and
operations. Preserve the tenant, owner, adapter generation, operation, request,
call, plan digest and cancellation checks. A recorded response or a tool
invocation alone cannot substitute for the actual terminal approval receipt.

## Live authority and lease renewal

Inspection observations freshly check canonical owner/session authority, active
membership, current operation approval, cancellation and the live physical
resource fence. They are read-only: they do not renew the journal lease or read
the provider project unless an existing specialized guard requires that read.
Membership capture and participant signup-policy checks remain part of their
observation wrappers. Protected mutations and executing worker authorization
retain the full fresh provider authorization check.

One service-owned renewal runs every 20 seconds throughout the acquired physical
lease, including credential preparation and reconciliation before worker launch.
Each renewal rechecks current observation authority and extends the journal lease
to expire in 60 seconds; a contended journal update rechecks authority on retry.
Failure aborts the execution signal. Renewal stops and any pending renewal drains
before journal lease release, including when physical lease failure returns before
its callback completes. Physical fence loss denies further guarded work.

Real receipts and checkpoints retain their journal writes and lease renewal.
There is no positive authority cache. These source semantics do not establish
hosted call-count, latency or cost savings; those require runtime evidence.

## Native deployment completion

A known native deployment that is `QUEUED`, `INITIALIZING` or `BUILDING` remains
part of the existing approved operation. Builder waits between reads of that
same deployment, renews its existing execution lease and preserves request
cancellation. It does not ask for another approval, replan or create a replacement
because a build is still running. A ready Gateway proceeds to the existing
approved hostname assignment and independent readback.

A build that fails or is cancelled keeps its observed outcome for recovery.
Unknown provider reads and uncertain hostname assignments remain reconciliation
cases; they do not authorize a blind write. Keep these waits inside the existing
execution lifetime, without model polling loops or additional acceptance gates.

Auth browser trust covers the approved public and Auth browser origins. The
independently verified native Gateway/JWKS probe may use a different deployment
URL; it is not another browser origin. Replacing that server endpoint does not
require expanding browser trust or changing the approved operation.

New planning reuses the existing owner-scoped provider read to resolve the
approved public alias and pin its current verified immutable Gateway endpoint.
A shared Gateway source refresh must not leave owner verification calling old
code. Keep the consumed proof and its issuer, audience, actor, session,
organization and physical Auth resource unchanged; use the current qualified
endpoint for the new plan's JWKS and readback. Frozen operations retain their
approved endpoint. Never substitute a moving browser URL or rewrite the saved
identity link to refresh transport. This adds no provider calls, resources,
grants or acceptance gates.

## Normal accounts and organization sessions

For apps requiring several participants, Builder derives `normalActorProgram`
from the accepted product requirements. The program names the accounts,
organizations, memberships and app roles; it contains no passwords or cookies.
Planning remains read-only. Resource/Auth/Gateway preparation, normal account
preparation, and the subsequently resolved membership/access/app delivery plan
retain their concrete effect approvals. Continue the original public session;
the evaluator does not create fixture users, edit grants or invoke private stages.

Account preparation uses ordinary Auth sign-up/sign-in. An existing account uses
the normal browser sign-in request. Its private session capture requires the
configured native sender, canonical pending nonce, pinned Gateway proof and
actual same-cookie GetSession. Capture stages private bytes first; the original
Builder owner confirms the callback before those bytes can become retained
account state. An ordinary reply resumes the same approved operation and does
not itself establish an identity. Credentials and browser state remain encrypted
in owner-scoped private records and never enter model context or public results.

Each organization context uses its own actual Realm session. The protected
organization worker receives the unchanged approved full plan and the selected
organization's retained identity proof. Ordinary invitations, acceptance and
active-organization selection establish membership. A single Realm session is
not relabeled to represent multiple organizations.

The private prepared-runtime handoff freshly reads GetSession for each selected
session and the actual membership role for each organization, then rechecks the
current plan approval. Only the authenticated private bindings response carries
the resulting storage files; they are not environment variables or tool text.
Keep approval, credential, tenant, lease and physical-fence checks. Do not add
source-layout, version, receipt-count, actor-count or regular-app-change gates.
Legacy plans without a participant program retain their existing path.

Source tests, CI and a READY deployment establish their respective boundaries.
For the Spend Review recovery, the basic Preview milestone is demonstrated by
fresh sign-in and retained request/data loading after reload. This records delivery
evidence for this app; it does not impose retained records, task shapes or new CI
checks on other generated apps. Full qualification and goal closeout still require
the accepted submission, reviewer decision, persistence, tenant isolation and
recovery acceptance evidence in
[the Spend Review qualification plan](plans/2026-10-07-hosted-operator-deployment-and-spend-review-qualification.md).
