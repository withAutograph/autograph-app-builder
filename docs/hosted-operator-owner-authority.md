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
