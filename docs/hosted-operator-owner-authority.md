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
Authenticated Preview still requires actual sign-in, submission, reviewer
decision, persistence and the full isolation/recovery acceptance evidence in
[the Spend Review qualification plan](plans/2026-10-07-hosted-operator-deployment-and-spend-review-qualification.md).
