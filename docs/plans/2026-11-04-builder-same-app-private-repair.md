# Same-app private repair planning

## Problem and intended behavior

An accepted app can need a real tooling, discovery or implementation repair after
its first approved private Build. Currently `prepare_app_creation` silently
reuses an applied proposal even when the caller provides explicit
`existingAppChanges`. This blocks normal repairs such as restoring app-local
mise discovery configuration. Reaccepting the same AppSpec also reuses that
proposal; changing product requirements to escape the state is inappropriate.

The existing public workflow must support a fresh same-app implementation plan
from explicit nonempty `existingAppChanges`, retaining the exact accepted
AppSpec, owner, app, workspace and selected private compute intent. It must show
a new concrete reviewed change set and obtain ordinary fresh Build approval.
No source files change during planning. No new public tool, manual generated-app
repair, synthetic specification change or approval transfer is introduced.

## Boundaries

- No-files planning remains idempotent reuse. An unchanged explicit repair
  intent may reuse its own already prepared proposal; a changed request cannot
  silently inherit a prior proposal or Build approval.
- Replanning is available only after a proven settled private phase. Deny
  pending apply/validation, uncommitted or unknown effect outcomes, publication,
  cancellation and changed owner/spec/app/workspace. Retain prior proposal,
  apply, validation and approval provenance as history rather than rewriting
  them or fabricating settlement. Historical grants never authorize the new
  proposal.
- Read current app-owned preimages/modes and validate prospective app path
  changes through the maintained existing-app planner. Only that planner's
  approved changes may later be applied. Preserve unrelated source and data.
- For the selected private compute profile, retain the genuine observed
  Sandbox/Drive/limits and exact reviewed canonical check policy. An explicit
  prospective repair may restore canonical check/discovery files without a
  planning-time write or a false compute-profile change. Do not weaken effective
  task verification, task families, schema checks, lint, types or browser tests.
  Conflicting proposed recipe or task overrides remain visible prerequisites.
- After planning, the normal Build card binds the new proposal and exact
  before/after source and compute facts. Approved application performs its usual
  before-image/current-session checks. Cancellation and races fail closed.

## Qualification and acceptance

Exercise the real maintained tool/workflow boundary: applied or failed settled
private work plus explicit app-local discovery repair produces a distinct
proposal and fresh Build request with the same AppSpec and selected profile;
planning writes no app bytes. Empty requests reuse, exact repeated intent does
not continually supersede itself, changed requests cannot reuse old approval,
and pending/unknown/cancelled/foreign bindings remain denied. Include actual
canonical check plus mise discovery configuration, not just a mirror helper.

After source qualification, resume the same saved app through normal public
Builder controls, inspect the proposed repair, answer its concrete fresh Build
approval, and verify actual check/e2e discovery before continuing BetterAuth
login, public release and revision acceptance. Passing source tests alone does
not complete A-469.
