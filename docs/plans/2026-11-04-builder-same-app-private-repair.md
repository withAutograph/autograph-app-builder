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

## Implemented source boundary

The planning producer checks the actual retained private Build grant and exact
settled apply/spec/source/workspace identity before treating explicit changes as
a repair. Pending approvals, partial/unknown apply failure, pending validation,
foreign app paths and private-policy deletion remain denied. Prior full workflow
snapshots live in a separate linear Eve history key; they are not recursively
embedded into new workflow receipts. Existing proposal contracts stay unchanged.

A repeated prepared repair rereads its frozen file preimages and executable modes
before reuse. The same request after an applied repair always plans again rather
than assuming its files still exist. The selected private profile can observe an
explicit prospective canonical task replacement without writing the file;
changed physical targets or reviewed policy still require their separate normal
planning flow. Prospective TOML contents are only frozen as app-owned source,
never evaluated for task discovery during this planning operation. Effective
mise task checks remain after approved apply.

Source qualification uses the actual planning producer and installed Eve state
with controlled provider/file I/O ports, plus the maintained effective check
fixture. Actual saved-app Build, task discovery and browser acceptance are
separate follow-through evidence and remain required.

Qualification of this implementation: 34 focused tests passed across normal
planning/spec resume/profile/effective-task fixtures; full Node 24 types passed;
the maintained actual Eve build passed (`mw1w3rjl-28f9336b-2f27-4923-9bfe-5eeaa3256364`).
These results qualify shared source and module discovery, not the saved app's
later Build, BetterAuth behavior or hosted release.

## Terminal private approval bookkeeping

A rejected Build can leave an older pending authority entry when a prior worker
lacked a terminal-decision hook. That entry is not a live approval and must not
block every later repair indefinitely. The maintained hook observes the genuine
framework request, denied resolution and rejected `TOOL_EXECUTION_DENIED` /
`not_run` result. It retains bounded terminal-decision evidence with the original
scope and retires only the matching pending bookkeeping. It never changes the
current grant or fabricates an approved result.

For an existing local cycle, planning may catch up through the maintained
owner-only local SDK history reader and its actual recovered-session composition.
The reader proves the same canonical cycle/server/session/lineage before and
after a complete snapshot; a current authority compare-and-swap fences the
result. Only the uniquely paired genuine denial and not-run outcome can retire
that call. Missing, partial, conflicting, approved or differently owned evidence
remains blocked. An obsolete proposal or absent public card alone is no proof.
History bodies are private transient input; only bounded event references,
digests and terminal scope are retained. No public tool, control request,
approval replay, journal rewrite or provider action is part of catch-up.

The installed framework also explicitly classifies continued-without-answer
requests as `ignored`, and invalid responses as `invalid`. These can retire the
matching pending entry only when the same genuine terminal resolution and
rejected not-run result agree. Neither outcome grants consent. Missing responses
without that actual terminal evidence, ordinary failures and conflicting approved
settlements remain blocked.
