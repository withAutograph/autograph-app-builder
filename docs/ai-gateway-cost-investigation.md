# AI Gateway cost investigation

This is a historical investigation record for future model and workflow decisions.
Measurements below are captured Gateway receipts, not necessarily complete bills.
They are not a statistically reliable cost per successful app. The original
private evidence from some early trials was lost; later observations should not
be interpreted as proof that the earlier results can be independently replayed.

## Decision and evidence boundary

The selected policy is Luna low for the main Builder agent, Terra 6.1 low for
source review, and Sol fallback when the primary review does not complete a
valid assessment. Sol remains the design-quality reviewer. These are operational
choices supported by limited experiments, not proof of broad model parity.
In particular, a completed review can miss a defect and invalid-output fallback
does not catch such misses. Keep separate source and design review policies.

The strongest same-source expense review repeat used three calls per model:
Sol cost $0.0949191 and Terra low $0.04337955; all six valid outputs identified
the two tested source risks. The rubric digest was not retained consistently
across the initial and repeated runs. These are review-only costs, not complete
workflow costs.

The matched persistence-explicit task with Luna as main agent and Sol reviewer
reached preview in 16m28.9s at low and 36m40.9s at high; captured charges were
$0.08407425 and $0.103047425. Both passed the observed add, complete and
reload-after-loading scenario. One run per arm is not broad quality evidence.
Another low/high comparison found a real delayed-feedback defect in the low app.

An expense workflow using the Terra-low/Sol-fallback candidate captured
$0.07947677 versus $0.21860317 for a Sol-review control, a 63.6% difference.
Both passed the observed expense scenarios; each is one run, source differed,
and capture completeness is unknown. The candidate's Sol fallback did not
trigger in that workflow. Realized production savings are not established.

## Subsequent current-main evaluation

A separately identified public-MCP expense evaluation using current main and the
candidate was attempted. Its development-source upload took over five hours,
then extraction failed before a preview or successful app. The public response
did not expose the underlying extraction error. After the worker stopped, its
session could not be recovered by the replacement local worker; the original
public identity, cursor and transcript were preserved. This is a failed attempt,
not a completed-app measurement. No replacement should be silently substituted.

A separate nonpersistent 1-vCPU synthetic Sandbox test validated the proposed
chunked upload with 8,388,625 bytes and matching SHA-256 in 2.238 seconds.
The Sandbox was deleted and independent readback returned not found. This
proves the synthetic transfer, not the original archive extraction or a complete
Builder workflow. The transfer repair was separately prepared; it is not itself
proof of production cost savings.

## Historical investigation ledger

The following ledger preserves the contemporaneous reported data and caveats.
References to checkout status, test counts, release state, and next steps are
historical observations rather than assertions about the present repository.

These observations were reported during the investigation. The original private
trial files previously stored under `/private/tmp` were absent when checked after
the interruption; the figures below cannot currently be independently replayed
from those files. Amounts are known receipts, not reconciled provider invoices.

| Trial                                 | Observed elapsed                                            | Known Gateway charges                                  | Outcome                                                                                            |
| ------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Earlier low                           | 31m 52.8s to waiting                                        | At least $0.05494587, excluding three reviews          | Technical checks passed; no working preview                                                        |
| Verified high                         | About 34m 06.8s to failure                                  | At least $0.134447905; failed turn cost unknown        | Missing tool output after approval; no successful app                                              |
| Route-fix low                         | 19m 20.9s to waiting                                        | $0.133475655 from observed model and review receipts   | Checks passed; preview returned 404; no verified app                                               |
| Guided low                            | 42m 57.351s through two ordinary follow-ups                 | At least $0.095190385 in agent-step charges            | Failed tests and preview; no verified app                                                          |
| Latest low                            | Still working at cursor 53 at last public observation       | At least $0.045236965 in main-agent charges at 16m 25s | Public outcome unknown; sandbox later stopped                                                      |
| Persistent low, newer Arrusted source | 25m 40.048s to ready preview; 28m 01.079s to browser checks | At least $0.045792155; source review unpriced          | Browser add and complete actions passed; state was explicitly temporary and did not survive reload |

The latest sandbox's read-only command inventory showed its most recent app
check and app test exited successfully after earlier test failures. That is
internal diagnostic evidence, not an app outcome or runtime behavior proof.
The persistent sandbox snapshot was not resumed.

The persistent low trial is a separate attempt on Arrusted `6faffc85`, not a
controlled match for the older source. Its source review found no cited
contradiction but remained unassessed pending runtime evidence. Browser checks
covered adding a task and marking it complete, not full product qualification.
Its lower bound includes a $0.00684002 retry charge recorded in a durable
event but omitted from the final cumulative turn tag.
Its exact Gateway total is unknown and failed attempts must also be counted in
any cost-per-success calculation. Private state and browser evidence are stored
in the owner-only sibling trial directory.

Partial Codex tool logs independently retain the latest trial's initial start
at 00:56:53 UTC, approval request at 01:03:35, and a working poll at cursor 53
at 01:16:03. They do not contain a complete transcript or final outcome.

Independent reviewer experiments reused three private source revisions. Luna
low cost $0.0044254 and failed evidence validation on both positive cases;
Luna high cost $0.0077574 and also failed both before the later narrow line
coordinate correction. Sol low cost $0.085668 and produced valid assessments,
but its runtime-check guidance differed from the retained baseline. Baseline
dollar costs were not captured; these samples do not establish quality parity.
The raw Luna diagnostic judgments were stored in temporary files that are no
longer present. The retained session log has only sanitized summaries, so the
current citation validator cannot be replayed against those judgments and no
revised validity or substantive parity conclusion is supported.

Across retained source-review receipts, two pairs in the earlier low session
repeated identical evidence. The original first assessments were unassessed,
so replaying them was correct under the cache policy; one retry found a valid
failure. Re-evaluating the saved first outputs under the later citation fix
produces completed failed findings for both pairs. If subsequent evidence were
unchanged, existing completed-assessment reuse could avoid the two observed
repeat charges totaling $0.0234055. That is a counterfactual, not measured
post-fix savings; changed evidence in other runs still requires review.

The next full-workflow experiment should write private public-session state,
transcripts, runtime state, and timing/cost evidence to an owner-only persistent
directory outside the source tree, rather than an ephemeral temporary directory.
Resume an existing public session when its supported runtime is available;
identify any new experiment explicitly and include failed attempts in spend.

## Citation-fix low trial

The separate low-reasoning trial using the corrected source-review citation
handling first reached a waiting state after 13m 07.405s following an aborted
app check. An ordinary continuation led to a ready preview at 24m 57.484s
and waiting with preview at 26m 40.499s; a later preview refresh was ready at
32m 17.593s. Browser evidence recorded an added task visible before a delayed
initial read was released, absent afterward, and visible again after reload.
This is a reproduced slow-read race. Delayed completion feedback was not
conclusively tested.

Three distinct cited review revisions were billed at $0.0295585, $0.0345235,
and $0.026876. Available receipts totaled $0.13586125, without independently
established capture completeness. Builder automatically addressed two cited
source findings before a later no-finding review, which missed the reproduced
slow-read race. This is an incomplete quality outcome, not cost per success.

## Overlap-guidance low trial

The separate later overlap-guidance trial reached a ready preview after
22m 31.303s and waiting at 23m 13.705s. Known charges were $0.11153583,
including two distinct source reviews costing $0.0339085 and $0.032146;
capture completeness remains unverified. Basic add, complete, and reload
checks passed, but both source reviews returned cited failures; the final
finding concerned recovery after a local-storage read failure, and product
acceptance remained failed. A delayed-network-read probe was inapplicable: its
saved result observed no initial read and its network trace recorded no
requests. The storage-failure browser probe was inconclusive because of a
Chrome transport error. This is not a verified successful app.

## Matched low/high trial

Both arms used the same Builder file snapshot and Arrusted `6faffc85`; only
the local reasoning setting differed. These are single samples and the
available receipts are not reconciled invoices.

| Arm  | Start to ready preview            | Known charges at initial ready | Observed behavior                                                                                                                       |
| ---- | --------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Low  | 16m 31.578s                       | $0.110973695                   | Add, complete and reload passed. A later delayed-response test contradicted the accepted specification's immediate completion feedback. |
| High | 36m 45.695s from successful start | $0.152030885                   | Add, complete and reload passed; immediate completion feedback and a simulated storage failure warning were observed.                   |

Low's source review initially appeared unassessed because an exact excerpt was
part of a long source line. After a later local citation-validation repair,
the saved final review produced a cited finding about delayed feedback; the
four-second delayed-response browser test confirmed that the checkbox waited
for the server, contrary to the accepted AppSpec. The high app used browser
storage rather than the low app's server request, so the fault-injection
methods differ. Other product scenarios remain unverified.

An ordinary preview-refresh reply on the same low session recorded an
additional $0.010316115 and took 47.247s to a ready preview. A corresponding
high-session follow-up settled in 2m 06.728s with $0.006130760 additional
recorded main-model charges. Capture completeness remains unproven in both
arms; include earlier failed attempts when assessing spend per success.

The low session was subsequently continued with ordinary product feedback.
The first revision passed immediate completion/rollback checks, but an
independent review identified a slow-initial-read race, which was reproduced
in the browser. A second revision reached a ready preview 16m 54.053s after
that feedback; browser checks finished in 18m 10.895s and verified that an
added task remained visible after the delayed read, while immediate toggle and
failure rollback still worked. Its final source review was unassessed, with no
cited contradiction. A later public poll observed the same session waiting;
available receipts totaled $0.33001877 across 68 model steps and seven reviews.
No calls were unmatched in that later report, but completeness of capture was
not established, so total cost remains unknown. From initial start to the
revised ready preview was 90m 24.885s; browser checks finished at 91m 41.727s.
These two same-session repairs and the differing implementations limit any
quality or cost comparison to the observed scenarios.

Read-only Gateway generation lookup later reconciled all 75 captured low
generations (68 main-model steps, seven reviews) to $0.33001877 exactly, and
all 48 captured high generations (47 steps, one review) to $0.158161645
exactly. These include the follow-ups described above. Lookup cannot establish
that no other requests were missed, and product outcomes remain unverified.

## Corrected step timing

Recalculation from the retained trace manifests attributes each first
approval only to its parent apply action. Earlier timing code could include
later repairs in that duration. In the matched low session, the first apply
action took 34.654s after approval; all three apply actions together occupied
493.885s of observed active time. The matched high session's one apply action
took 98.306s after approval. These action spans include workflow overhead and
do not independently prove successful execution.

Across the entire retained matched sessions, validation action spans occupied
1,003.441s for low (13 actions, including later repairs) and 497.654s for high
(four actions, including a later follow-up). These totals are not a controlled
first-attempt comparison and can overlap other activity. Trace coverage and
successful product outcomes remain separately unverified.

## Rechecked review attribution

The cost evaluator now treats source-review records without a session ID as
unattributed, so they cannot be silently excluded from a supposedly complete
trial. Re-running all four retained manifests found zero such records and no
unmatched observed model calls; the previously recorded known charges did not
change. This does not prove capture completeness or establish a cost per
successful app. The matched high session's known charges including its later
refresh were $0.158161645; the initial ready amount was $0.152030885.

## Guidance-low trial and interruption

This separate trial reached waiting with a ready preview in approximately
29m 23s. Add, completion, and reload worked in the browser. Under simulated
network latency, a failed completion displayed `[object Object]`; product
feedback was sent through the same public session. An early source review
identified concurrent whole-file writes that could lose an acknowledged
completion. A later revision used a shared lock, but its final assessment
remained unassessed and cross-instance behavior was not tested.

The repair approval initially appeared before its preceding response settled,
causing two rejected attempts. After the saved approval was accepted, a source
edit for that local continuation defect triggered the development supervisor's
automatic Eve restart. The session reported unrecoverable local history, so the
repair and final product outcome were interrupted. The retained traces contain
41 model steps and two source reviews with $0.155939525 in known charges;
capture completeness is not established. This attempt must be included in any
cost-per-success analysis. A subsequent settlement-low trial is separate.

## Settlement-low trial

The new low-reasoning trial first waited after 17m 43s without a working
preview; three preview attempts failed. An ordinary same-session request for a
working preview produced one at 20m 02.118s, and the next waiting response at
20m 35.385s. Known charges through that response were $0.063649265; capture
completeness is unverified. The browser could add and complete a task. Reload
removed the new task and reset state, consistent with the Builder's disclosed
session-only implementation. The original brief did not expressly require
persistence. A further ordinary request to retain tasks after reload was sent;
its time and charges must be reported separately and included in any total.

The persistence follow-up returned to waiting 35m 09.576s after the original
start, about 13m 51.881s after its first observed working response. A revised
preview was present. A browser check added a task, marked it complete, and
observed the same completed task after reload. This verifies that scenario,
not all product requirements or cross-browser durability. Known charges for
the complete session were $0.122153415 across 47 model steps and two source
reviews; the two reviews accounted for $0.054242. Capture completeness is
unverified, so this is not an exact total or a reliable cost per success.
The revised preview also rejected a whitespace-only task, retained the draft
and existing task state during a simulated offline add, and added the preserved
draft after connectivity returned. Its visible error said `Failed to fetch`.
The final source review had no cited findings but remained unassessed with five
runtime checks; these browser observations cover only some of those scenarios.
One source-review generation was independently matched to an AI Gateway log
by a private identifier hash. The log showed 10,250 input tokens, 10,247
cache-write tokens and 325 output tokens; its rounded displayed charge $0.0289
agreed with the captured $0.0288735. This corroborates that one receipt, not
the trial's complete coverage or total.
The other review generation also matched by private identifier hash: the
Gateway displayed $0.0254 against the captured $0.0253685, with 8,728 input
tokens (8,725 cache-write) and 355 output tokens. Both review receipts are
corroborated; the complete session total remains unverified.
All 47 captured main-model steps had unique generation IDs and cost receipts.
Two sampled IDs matched individual Gateway dashboard records by private hash;
their rounded charges agreed with recorded $0.001535345 and $0.00114159. A
programmatic lookup could not start because project OIDC retrieval hit a
sandbox network failure; no lookup requests were sent. The two matches do not
prove coverage of other calls or the exact session total.
Later, using the still-valid existing owner-bound project OIDC credential,
read-only generation lookups succeeded for all 47 captured main-model IDs.
All 47 Gateway costs matched their retained step costs exactly, totaling
$0.067911415. This reconciles the captured steps, not failed or unrecorded
attempts or completeness of the entire session.
The same read-only lookup reconciled both source-review costs and token totals
exactly: $0.054242 combined, 18,978 input tokens (18,972 cache-write, six
uncached, zero cache-read) and 680 output tokens. Thus the 49 captured
generations total $0.122153415 in Gateway records; unknown or missing attempts
still prevent asserting a complete session total.
Of the $0.122153415 known session charges, 47 main-model steps accounted for
$0.067911415 and two independent reviews for $0.054242. The recorded main
steps reported 2,923,534 input tokens, including 2,691,594 cache reads (92.1%),
and 24,013 output tokens. Both reviews reported zero cache reads. These are
observed-call proportions, not a reconciled invoice or universal workload mix.
Fitting the recorded main-model input charges to cache-read and remaining
input counts gives approximately $0.0100 per million cache-read tokens and
$0.1250 per million remaining input tokens (largest per-step residual under
$0.000000058). On those observed rates, the 2,691,594 cache-read tokens account
for about $0.0269133, or 22% of the known session receipts. This is an
accounting inference, not an attainable savings forecast: changing context can
change cache behavior, request counts, and product quality.

The first preview attempt used a nonexistent task and exited. Its cleanup then
received a command-kill 404; two subsequent preview attempts failed while
reconciling that prior command, before their new commands launched. A later
continuation obtained a working preview, but the trace does not show why stale
cleanup cleared. A source repair now handles a kill 404 only if an independent
command wait confirms exit; its focused tests passed. It has not been shown
against the live provider's particular 404, which could also affect wait.

## Duplicate source-assessment output

An offline replay of retained OTLP tool results selected validation and
change-set reviews, deduplicated by call ID, and checked that the nested and
top-level source assessments were identical before removing the nested copy.
Across 21 retained results, compact UTF-8 JSON fell from 205,186 bytes by
66,258 bytes (32.3%). No checked pair differed. These are serialized result
bytes, not measured model tokens or billed savings; coverage is limited to the
retained traces. The public tool results retain their full original contents.

In the settlement-low trial, the runtime source snapshot included the preview
HTML model projection. The retained public transcript referenced two prototype
HTML blobs of 603,964 and 603,737 UTF-8 bytes; each rehydrated string matched
its public prototype digest and content-addressed blob reference. This proves
that transport retained those HTML payloads, but not that the model projection
was invoked or that the prototypes' browser interactions were correct.
Subsequent inspection of the captured model prompts found 11 preview tool
responses corresponding to the two actual calls. Each was a 292-byte receipt
with a matching public digest, no content field, and no HTML marker. Together
with the independently verified full public blobs, this confirms compaction
and preservation for those captured calls; it does not prove prototype visual
or interaction quality, overall trace completeness, or dollar savings.

## Synthetic prompt-cache diagnostics

Two bounded pairs used wholly invented text, without saved product specs or
source. Each pair shared a 24,815-character prefix. One placed the changing
suffix in the same message; the other used a separate following message. Both
requests in each pair reported zero cache-read tokens. The pairs cost
$0.024227 and $0.023612 respectively; individual latencies were 2.593s,
1.970s, 1.564s, and 1.273s. These samples do not expose provider wire-level
message handling or breakpoint placement and do not establish that caching is
impossible, reviewer quality parity, or workflow savings.

A third synthetic pair ended the first request at the stable prefix and then
appended a follow-up. The first wrote 4,686 cache tokens and cost $0.012381;
the second read 4,686 cached tokens and cost $0.0005596. Latencies were 3.494s
and 1.760s respectively. This demonstrates a cache hit for that synthetic
boundary, not net savings from adding a warm-up request or review parity.
The installed Gateway SDK did not expose or document a mapping for OpenAI's
explicit breakpoint fields, so no such option was added to Builder.

Two further synthetic pairs used the Gateway Responses-compatible endpoint and
structured JSON output. The explicit-breakpoint pair returned 4,697 cached
tokens on its second request; a fresh control without explicit fields returned
5,177 cached tokens on its second request. This does not prove the explicit
fields were honored. All four requests returned valid structured output and
took 2.353s, 1.796s, 1.945s, and 1.715s. Their exact charges are unknown:
the retained sanitized outputs did not include cost receipts or generation IDs.
No saved product specification or source was sent.

An additional synthetic AI SDK pair placed a long invented stable instruction
before changing user input. The second request read 5,416 cached tokens; the
requests cost $0.013696 and $0.0008176 and took 2.487s and 1.565s. This proves
SDK cache feasibility for that structure, not that real review evidence can be
safely promoted to instruction authority. The current trusted reviewer rubric
is 1,560 bytes / 199 words, and its exact token count and cache eligibility are
unknown; no real review prompt was changed on the basis of this experiment.
An invented short-instruction pair (1,589 bytes / 208 words) with an analogous
synthetic structured schema used 403 input tokens per request and reported
zero cache writes or reads. Each cost $0.001036; latencies were 2.351s and
1.833s. This supports a cache-minimum concern for similarly sized synthetic
inputs but does not establish token counts or eligibility for the real rubric.

An independent invented five-case comparison tested a baseline layout against
one moving evidence into system instructions using the same Sol model and
structured schema, one sample per layout and case. Of ten requests, the
baseline returned one exact-substring-grounded concurrency finding; the
candidate marked that issue unresolved. Other cases returned no findings and
at least one unresolved item in both layouts; intended display-color cases
did not establish actual display behavior. Total cost was $0.014496 (baseline
$0.006618, candidate $0.007878), with summed request times 17.202s and
20.526s. Inputs were too short to use caching. This small synthetic signal is
not the Builder's full citation validator, broad parity, or production savings,
and does not justify promoting untrusted source into system authority.

Following explicit user approval for the two settlement-low snapshots, a Sol
replay with reordered complete evidence used zero cache reads; it cost
$0.051782 and took 5.884s / 7.426s. Both reviews returned no cited findings
and were unassessed, with runtime checks differing from the saved baseline;
parity and causal savings are not established.

Luna reviewed the same two approved snapshots for $0.0034411 total versus
$0.054242 in saved Sol charges, a 93.66% difference for these calls. It took
11.853s / 10.590s and returned one validly cited finding on the first snapshot
and none on the second. That first output's content was not retained. A
stochastic repeat on the first snapshot cost $0.00097905 and took 15.570s;
it found a cited possible ID collision when two creates share a millisecond,
which can cause a toggle to affect both tasks. The source supports the
mechanism; occurrence and severity were not tested at runtime. The repeat
cannot recover the earlier finding, and two revisions with limited positive
cases do not establish reviewer parity or justify a model switch.
The original Sol model-call spans took 10.904s and 10.067s, compared with
11.853s and 10.590s for the Luna pair; this one-shot sample shows no latency
improvement and is not statistically conclusive.

After the user requested Terra, `openai/gpt-6.1-terra` reviewed the same two
approved snapshots for $0.038021 total, taking 14.833s and 21.018s, versus
saved Sol $0.054242 and Luna $0.0034411. Terra returned one and two cited
findings respectively; the saved Sol results had none. Independent source
inspection supported the mechanisms: possible same-millisecond ID collisions;
an empty-state message appearing alongside a failed load; and incomplete retry
guidance for error messages. Runtime occurrence and severity were not tested.
One citation's line was corrected by the existing unique-match validator. The
requirements were in the accepted specifications, not necessarily the
original brief. These two samples do not establish review parity or production
cost per successful app. A full Terra workflow remains to be tested.

A second independently invented five-case screen compared Sol and Luna with
the same synthetic schema and requested low reasoning. Both produced an
exact-substring-grounded concurrency finding and no findings in clean,
embedded-instruction, and missing-dependency cases. Luna also reported a
render-color finding where actual invocation was not established; Sol left
that scenario unresolved. The ten requests cost $0.0086342 total (Sol
$0.008214, Luna $0.0004202); summed latencies were 22.262s and 16.891s.
One sample per case, short inputs, substring-only grounding, and unverified
reasoning-setting application cannot establish reviewer parity or justify a
production model change.

## Retained trial cost inventory

Seven distinct retained session manifests contain $1.05262257 in known
receipts altogether: early low $0.038952135, matched low $0.33001877, matched
high $0.158161645, citation low $0.13586125, overlap low $0.11153583, guidance
low $0.155939525, and settlement low $0.122153415. Every capture is marked
incomplete; early low has two unmatched calls. The sum excludes diagnostics,
unknown or lost attempts, and any unrecorded charges. It is not total spend or
cost per successful app. Two earlier single-step diagnostics recorded an
additional $0.00578375 and are not included in that seven-session sum.

## Matched source-reviewer workflow comparison

The Sol control used low main-agent reasoning and an explicit local Sol
source reviewer. Its first ready preview was observed after 19m 39.529s and
waiting after 21m 10.287s. All 31 captured generation costs (29 agent steps,
two Sol reviews) matched read-only Gateway records, totaling $0.118470715;
capture completeness remains unverified. Browser testing found the list failed
to load and adding a task failed to save, so this was not a successful app.
Ordinary feedback was submitted to the same session; its subsequent cost,
timing, and outcome must be included. The Luna comparison must use the same
source snapshot and brief and report any differences in follow-up work.
After feedback, the revised preview was observed 3m 25.581s after the
continuation and waiting 27m 33.724s after the original start. A browser check
then observed successful list load, task creation, completion and persistence
after reload. All 45 captured generations (42 agent steps and three distinct
Sol reviews) matched Gateway records, totaling $0.180478615. This verifies
those scenarios and receipts, not broader product quality or complete capture.

Subsequent read-only Gateway lookups matched all captured IDs and exact costs
for citation-low (36 generations, $0.13586125), overlap-low (32 generations,
$0.11153583), and guidance-low (43 generations, $0.155939525). Together with
the matched and settlement runs described above, six of seven session manifests
have their captured receipts individually reconciled. None proves complete
capture; early-low has additional unmatched calls and remains incomplete.
The 28 captured main-model IDs in early-low were subsequently reconciled
exactly to $0.038952135. Its two unmatched model calls have no associated
review-record file and remain unpriced. All seven manifests' captured receipts
are now reconciled individually, but their full costs remain unknown.
The two unmatched early-low entries are one nested source-review chat with
token usage but no retained Gateway generation ID or cost, and one agent step
with two model streams but only one step-level generation receipt. The saved
trace does not establish independent IDs or charges for the missing calls.
Gateway Logs contained a candidate review with matching time and token counts
and a rounded $0.0255 charge. Neither the dashboard detail nor the SDK's
generation-info interface exposed the upstream provider response ID needed for
an independent match. This remains an unverified candidate and is not included
in the known-cost total.

### Matched Luna and Terra reviewer workflow results

Same brief and low main reasoning; reviewer settings confirmed by accounting. Initial Luna preview 20m04s, waiting 21m01s, captured $0.034433135 (27 agent, 4 reviews). Initial Terra preview 20m43s, waiting 21m17s, captured $0.05019495 (25 agent, 2 reviews). Both passed observed add and complete. Initial reload observations did not wait for hydration, so persistence is inconclusive.

Same ordinary persistence follow-up: Luna returned to waiting at 33m28s overall. 49/49 captured Gateway receipts matched, $0.06699923 including five reviews $0.008724555. A task was absent immediately after reload, but hydration was not checked before the sandbox stopped; persistence outcome inconclusive. Terra returned to waiting at 45m38s overall, replacement preview 22m29s after follow-up began. 59/59 captured receipts matched, $0.252540735 total (51 agent $0.083312985, 8 Terra reviews $0.16922775), follow-up incremental $0.202345785. In revised Terra preview, a newly added and completed task remained completed after reload and loading finished. This is a scoped browser scenario, not full acceptance. Receipt capture completeness remains unknown for both, and one workflow per arm is insufficient to establish quality or production savings. The Terra arm adds only the local selector support and tests to checkout relative to Luna, so source bytes are not identical.

### Matched persistence-explicit high versus low reasoning

Original brief explicitly requested same-browser persistence. Both models used Luna main agent and Sol reviewer. Compared runtime source snapshots: 3,959 Builder files and 5,515 Arrusted files match after excluding runtime/dependency artifacts. High first preview 36m40.9s, waiting 38m57.0s, four validations (three needs_repair before passed). Forty agent receipts $0.066266425 and one Sol review $0.036781; all 41 reconciled, $0.103047425 captured. Low first preview 16m28.9s, waiting 16m56.1s, two validations passed; one preview action failed before succeeding. Twenty-one agent receipts $0.02501975 and two Sol reviews $0.0590545; all 23 reconciled, $0.08407425 captured. Both independently passed adding and completing a task, reloading, waiting for loading, and seeing it completed. Capture completeness unknown; one sample per arm and scoped browser behavior do not establish broad quality parity or complete cost per success.

### Persistence-explicit Luna reviewer arm

Same original brief, low main reasoning and same runtime source snapshot as low/Sol: Builder 3,959 and Arrusted 5,515 source file hashes match excluding runtime and dependency artifacts. First preview 25m06.7s, waiting 25m46.1s. Three validation repairs preceded passing validation; UI preview failed once and succeeded. All 32 captured receipts matched Gateway: 30 agent $0.040508675 and 2 Luna reviews $0.00523199, total $0.045740665; capture completeness unknown. Both Luna source assessments were unassessed due to unavailable or mismatched requirement/source citations, so reviewer coverage is not comparable to Sol. Browser independently observed add, complete, reload, wait for loading, and retained completion. Scoped browser success is not review parity or broad quality parity.

Offline replay after citation reconciliation change: first persisted Luna judgment remains unassessed due unmatched requirement evidence; second becomes reviewCompleted with three cited findings and two runtime checks, by relocating exact unique partial-line excerpts to their actual lines. This is evidence-validation recovery, not behavioral verification of findings, and does not retroactively change the original run's outcome or measured cost. Focused tests 20 passed, typecheck and type-aware lint passed.

### Expense-log Sol versus Luna reviewer

Same expense brief, low main reasoning and identical 3,959 Builder source files after runtime/dependency exclusions. Sol preview 23m52s, waiting 24m19s; 41 reconciled captured receipts $0.21860317 including 4 reviews $0.1457065. Luna preview 27m38s, waiting 28m11s; 34 reconciled receipts $0.04941832 including 2 reviews $0.004432725. Two Luna judgments revalidated with completed status; one has 2 cited findings, the other none. Both previews independently passed adding two categories, editing amount, verifying total and filtered total, and retaining both after reload/loading. Complete capture remains unknown; single runs do not establish broad quality parity. Sol had an additional ordinary chat build confirmation, so times include different interaction paths.

### Terra low versus medium replay

Two previously approved source snapshots: Terra low $0.028251 total, 6.764s and 6.018s; medium $0.037261 total, 14.847s and 20.720s. All citations validated; both identified a possible ID collision and failed-load empty state; medium additionally flagged unclear recovery guidance. Findings not reproduced at runtime. Provider default Terra runs cannot be classified as low or medium.

### Expense Terra configured low

First waiting without preview 16m21s after start after two build failures; ordinary user continuation requested recovery. Ready preview 26m04s, final waiting 27m20s. All 33 captured receipts reconcile, $0.12179846 including four Terra reviews $0.0763795; capture completeness unknown. Browser after recovery passed add, edit, category filter, totals and reload with both entries. Four retained judgments validated with 3, 4, 2, and 0 findings (not asserted chronological). Local launch configured low; accounting whitelist omitted reasoningEffort and trace does not independently prove transmitted setting. Runtime source differed from Sol in nine experimental reviewer/config files, so comparison is not fully identical. Subsequently fixed local whitelist to preserve nullable low/medium; 37 focused tests, tsc, and type-aware lint passed. This does not retroactively restore the missing effort metadata.

### Synthetic same-source review screen

15 invented cases, 9 positive, 4 clean and 2 missing-evidence; one sample per model. Independent semantic oracle review: Sol and Terra valid 9/9 positives; Luna valid 8/9, with the ninth correct raw finding rejected only because requirement quote had typographic outer quotation marks. No cited findings on the six clean/missing cases; missing cases retained runtime checks. Captured costs for 15 calls: Sol $0.044548, Luna $0.0030634, Terra provider-default $0.026069. Small synthetic examples do not establish reviewer parity. The expense/Luna final source also has a plausible unflagged overwrite after a read failure; not reproduced at runtime and Sol did not review the same source.

A bounded validator repair accepts a matching outer quote pair only when its exact inner text appears in retained requirements. Actual saved Luna synthetic judgment now validates offline; invented, empty and mismatched quotes remain rejected. 38 focused tests, typecheck and lint passed. Do not retroactively equate this with a full-workflow rerun.

### Synthetic read-failure overwrite screen

Invented positive fixture independently executed: a failed initial read followed by a successful add overwrites seeded records; guarded control makes no write. One baseline sample each: Sol, Luna, Terra-low and Terra-medium all returned completed valid citations identifying this path, and no findings on guarded control. Captured two-case costs respectively $0.010280, $0.000560, $0.003680, $0.005915. Luna provided no runtime checks on positive. After adding backend-neutral rubric guidance to trace failed initial reads through later writes, a second sample for each setting also detected the positive and left the guarded control without findings. This small example does not demonstrate that the guidance fixes the unflagged real expense-source path or establishes reviewer parity. Focused tests 38 passed, typecheck and lint passed.

### Multi-file synthetic read-failure screen

Four wholly invented 5-file examples, three seeded storage overwrite paths and a guarded control, independently executed for oracle. One sample each of Sol, Luna, Terra low, Terra medium: all 16 assessments completed with valid citations; each correctly identified all 3 overwrite variants and none flagged the guarded case. Luna supplied no remaining runtime checks on the three positives, while others included checks. Captured costs over four calls: Sol $0.035059 (41.322s), Luna $0.00226095 (39.035s), Terra low $0.0147095 (23.257s), Terra medium $0.0199645 (33.444s). This is one defect family on invented source and is not evidence of general parity or of detecting the prior expense app issue.

Adjacent real expense source-review prompts contain 14k–20k unchanged source characters, but actual review receipts recorded zero cached input tokens; earlier authorized reordering replay also produced zero reads. Exact-evidence cache already reuses completed matching reviews. No verified production cost reduction follows solely from repeated content.

### Approved same-source expense replay

User explicitly authorized sending the last-reviewed generated expense specification and source snapshot to Vercel AI Gateway. The trace records no later implementation write, but live preview digest was not independently checked. Updated rubric and citation validator: Sol $0.0400885 / 22.104s completed with 2 findings; Luna $0.002184925 / 20.119s unassessed because a cited excerpt combined source lines and was not verbatim; Terra low $0.01865925 / 14.900s completed with 2 findings; Terra medium $0.02189425 / 21.393s completed with 2 findings. Raw judgments all flagged read-failure then write risk; Sol and both Terra settings identified edit rounding risk, while Luna did not; Terra also noted silent filtering of malformed stored entries. These are source-path hypotheses, not independently reproduced runtime defects. Single sample and snapshot do not prove broad quality parity.

### Terra-low with Sol fallback candidate

The candidate workspace policy uses Terra low primary and Sol fallback only when reviewCompleted is false; design-quality Sol and the user-selected main model remain untouched. Cache binds evidence and whole policy plus actual reviewer/effort; fallback checks abort and source drift. Exact candidate expense workflow first stopped without preview due sandbox validation abort; ordinary user continuation resumed. Preview 22m55s and final waiting 23m29s. Independent browser check passed add, edit, filtered total, and persistence after loading. All 33 captured receipts reconciled: 31 main $0.05092952 plus 2 Terra-low reviews $0.02854725 = $0.07947677; no Sol fallback invoked. Completed review outputs included one with two cited findings and one with none, not chronologically verified. The Sol control was $0.21860317 captured; observed candidate 63.6% lower, single runs and source differs, capture completeness unproven. Fallback unit tested but not exercised in this real workflow. No deployment. Exact candidate focused 44 tests, typecheck and lint passed. A completed Terra review can miss a finding; quality parity and realized production savings remain unproven.

### Candidate follow-up verification

Three same-source expense diagnostic samples each for Sol and Terra low: all six valid and found read-failure overwrite and amount-rounding; Terra also flagged filtering invalid stored records. Sol $0.0949191 and Terra $0.04337955 captured; last request each had 10,161 cached input tokens. Rubric digest not retained across initial vs repeat runs; diagnostic cost is not full workflow cost. Corrected citation relocation to require globally unique exact excerpt when relocating, including occurrences within other lines; exact claimed full-line citations remain valid. Added real SDK/in-memory Gateway integration tests (no provider calls): invalid Terra -> Sol, actual wire body model/effort, separate accounting, cache reuse, double invalid, abort and drift. 48 focused tests pass, tsc and targeted type-aware lint pass. Hosted deployment, complete billing capture and broad review quality parity remain unverified.

### Candidate packaging and hosted-path audit

Current checkout mixes 69 modified tracked files and pre-existing user changes. HEAD model defaults differ from the tested checkout, so copying whole files or assuming HEAD is tested would be unsafe. Source-review fallback now explicitly selects tested Sol independently of the shared design-validation setting; no user model constants changed. Cached assessments are bound to the actual review instruction digest, invalidating old/missing instruction identity once. Synthetic OIDC env-token + real SDK + fake network integration validates Terra-low -> Sol request headers/options and accounting without real credentials/network; does not prove hosted request context or provider identity. 49 focused tests, typecheck, targeted lint and diff check passed. No exact-head publication, Preview or hosted cost evidence.
