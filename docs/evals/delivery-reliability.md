# Builder delivery reliability

Use these cases when changing Builder or its generation contract. They qualify
the Builder changes; they are not a check or approval for each generated app.
Use synthetic records and the ordinary Creator account in the authorized test
workspace.

- **Frontend and Preview:** Build [Color Contrast Card](../../evals/delivery-reliability/frontend.md) with one Build approval. Exercise the form in the working Preview (black on white reads 21:1). Send the [release request](../../evals/delivery-reliability/frontend-release.md) in the same session, give ordinary publication consent, and exercise the Production route. Confirm setup did not allocate an app database.
- **Private persistence:** Build [Tool Checkout Notes](../../evals/delivery-reliability/persistence.md) with one Build approval. Builder sets up creator access and storage without infrastructure inputs. As the creator, open the Production URL, save and edit a synthetic record, and reopen it in a fresh app visit. An unsigned visitor must sign in; an authenticated actor without a grant must not see the record.
- **Data-preserving revision:** Request the [heading update](../../evals/delivery-reliability/revision.md) for that exact app. Check the changed heading and saved record at the same Production URL. Record the unchanged storage resource identity from read-only evidence when available.
- **Interrupted publication:** Use the frontend case with an isolated test provider. After the provider accepts the exact approved GitHub write, interrupt recording its result in the current workflow. Resume the original session through the public flow. Observe the same pull request and reviewed revision, a single provider write, and no authority for a moved head or unrelated app. Exercise both confirmed and uncertain outcomes. An uncertain result must be reconciled or left unresolved without another write. Do not intentionally fault Production.

For each new app case, replace `[RUN LABEL]` with a unique label in a temporary
copy of the brief and use that same label for its revision. Use the web app
or the [existing public MCP driver](self-reproduction.md#supported-public-driver)
with `--brief-file` and its own external evidence directory. The revision may
also be requested as a normal public message in the saved app session when
the product supports it. Save the original session and resume it on stalls.
The driver may poll, answer product questions consistently with the brief, and
submit the exact ordinary product approvals. It must not edit generated files,
prepare the runtime privately, nudge internal stages, or mutate GitHub or the
deployment provider. Record a run needing any such assistance as a failure of
unassisted delivery.

Record the deployed Builder revision, session handle, first Build approval,
first working Preview, review acceptance, draft and merge, and first verified
live revision as separate facts. For each, retain timestamps and links or a
sanitized transcript reference. Count Build approvals and interventions and
report wall time from Build to Preview and Build to live when applicable.
Record source checks, provider state, route behavior, and authenticated
readback separately. A working Preview can be credited only after exercising
the app; a live revision can be credited only after checking its Production
URL and the intended change. Mark missing or unavailable evidence explicitly
as failed, blocked, or unassessed. Keep credentials, private Preview
capabilities, and synthetic records out of shareable logs.

## Delivery timings

Compare a first private app release, a text-only revision, and a revision that
adds one optional field. Use the same app and destination for both revisions.
Compare like cases across Builder revisions, keeping local recovery exercises
separate from normal hosted runs. The public driver's `buildApprovals` report
retains when it first saw each Build card and when Builder acknowledged the
ordinary response. This evidence survives resuming the driver's saved state.
Record these observations and any interventions, including equivalent evidence
from the web flow. The private `app_builder.build_grant_recorded` event marks
when Builder first records the approved grant for its current proposal.
Compare it with the approval acknowledgement to see when execution begins.

Use the existing `app_builder.validation_command` logs for elapsed time and
outcome of the selected repository commands, including standalone
`schema-compile` calls. When a repository build runs schema work internally,
report its combined command time unless that command provides its own timing.
The `validationPlanCorrelation` identifies the same approved source and
dependency plan for one command in the same session. A private repair can change
actual inputs under that plan. Candidate schema compile also supplies a
`validationInputCorrelation` based on the exact inspected draft tree, which
includes its lockfile. Use current input observations to confirm duplicate work
before changing validation.
Record Check completion and merge from GitHub. Record provider build start and
readiness, observed activity at the Production URL, any protected data update,
and Builder's live confirmation. The driver's `deliveryTiming` retains Builder's
reported phase start and latest observation across polling and resume. The
public event index orders status changes that share an observation timestamp.
A repeated live observation retains the first confirmed time until a new
delivery phase appears. If the first available event is a later exact
saved-session Production check, use that observed time. Use GitHub and Vercel for
the authoritative provider timestamps. Label a client
observation as such. Missing stage timings stay unavailable, including before
the historical instrumentation was deployed.

The [November 15 hosted timing report](../reports/2026-11-15-builder-delivery-timings.md)
records the first release, heading revision, and optional-field revision.

Use `app_builder.source_review_input` to distinguish reuse of current completed
evidence from preparation of a review. Group
`app_builder.source_review_request_started` records by the session-scoped
`reviewInputCorrelation` and inspect the native call and request ordinal to
identify repeated requests for identical inputs. Count repeated native log
observations once. Classify actual in-flight round retries separately from
independent invocations that restarted an identical review. Report fresh
requests, elapsed command time, and the explanation for repeated work before
changing execution. Track hosted timing as advisory qualification evidence.
