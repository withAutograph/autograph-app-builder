# Self-reproduction entrypoint reassessment

The acceptance target is an ordinary user asking App Builder to reproduce
itself from one product brief. Existing staged native runs and infrastructure
probes do not establish that result.

## Pending PR 430

PR 430 must not land as a unit. Its controller, hosted worker, private artifact
database migration, GitHub/Vercel identity plumbing, and hosted client create a
separate eval execution platform. They do not prove that the normal Builder
handles cloning, installation, planning, implementation, recovery and validation.
The branch and external receipts remain historical diagnostics. No production
migration or hosted generation dispatch was performed for this implementation.

Observation-only semantic-token comparisons and navigation evidence may be
extracted independently after review. General database or development repairs
must be justified against the shared product workflow, without carrying the
hosted-eval infrastructure into main.

## Correction

The guided `evals/self-reproduction.eval.ts` driver is retired. It previously
instructed internal inspection, workspace preparation, planning, apply, repair,
validation, review and export. Those prompts coached the result. The CLI now
rejects generation before setup and retains explicit report-only comparison.
The old self-hosted GitHub workflow is removed. Historical reports and candidate
bytes remain unchanged and retain their original provenance.

Submit `evals/self-reproduction/brief.md` through the web App Builder or
`autograph_start({ prompt, clientRequestId })`. Poll with `autograph_get`; answer
only actual ordinary product questions and approvals with `autograph_respond`.
Keep the fixed answer sheet outside the initial prompt and record actual replies.
Do not send internal phase reminders or repair hints. If the shared workflow
stops without an ordinary input request, retain that outcome as evidence of an
autonomy gap and repair the shared workflow before a separately identified run.

The evaluator observes, compares and reports afterward. An exported frontend,
an evaluator-created Sandbox, or a passing compiler probe earns no credit for
the generated app's independent backend or App Builder's normal automation.
A qualifying public-entrypoint baseline has not yet been established by the
retained diagnostic runs. See the [acceptance contract](../../evals/self-reproduction.md).
