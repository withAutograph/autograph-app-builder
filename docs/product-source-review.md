# Product source review

Independent source review runs at final `accept_change_set`, after implementation
and technical validation are ready. `validate_app_creation` continues to run the
repository commands, runtime preparation, release capture and applicable
persistent-backend browser tests, but returns deferred/unassessed source evidence.
The deferred result has `status: "unassessed"`, `reviewCompleted: false` and
empty findings. It uses the existing apply receipt's source digest as a known
binding; it does not claim a fresh source observation. That deferral is expected
and does not require another validation attempt.

Final acceptance reads current source and performs the independent assessment
before private preview completion or publication. A matching completed assessment
is reused; an interrupted matching assessment resumes its journal work. Source
repairs still require current technical validation before final acceptance. An
interrupted review alone is not a reason to rerun repository checks. Product
behavior still requires executed evidence; source review cannot establish it.
Final findings or an unavailable assessment remain explicit in the result and
must not be presented as a clean completed review.

At final review, Builder reads selected app source, changed paths and root
manifests through the Sandbox byte stream. It hashes each complete file
against the observed overlay and divides source into bounded pages. A long line
is split with its original starting line and column recorded. Pages are transport
units, not file or repository size ceilings.

Builder divides the original request, clarifications and AppSpec into overlapping
excerpts. Every selected source page is checked against every excerpt, preserving
complete coverage. Multiple pending page/context pairs are packed into one
independent model request under a 128 KiB serialized JSON prompt byte bound.
Rubric instructions and output schema are outside that JSON budget. Batching
reduces request fanout without changing the selected review model, rubric,
required coverage or citation rules. This bound limits one prompt, not total app
size, review work or session duration.

Each response identifies its individual pair judgments. Builder checks source
excerpts and requirement quotes mechanically, translates valid page citations to
original file line numbers, and journals completed pair judgments independently.
Results aggregate in original source/context order. Provider context rejection
or an SDK structured-output failure explicitly ending for length splits the
affected batch; a rejected singleton pair splits its source page or
requirement excerpt and retries. If the smallest pair cannot be accepted, review
remains blocked with its source location and excerpt identity.

Multi-pair requests use caller cancellation without the singleton's 120-second
deadline. Singleton requests retain that deadline. Invalid structured output
with another finish reason remains blocked. Fresh usage includes billed
truncated responses as well as their successful continuation requests.

An unchanged later review reuses the retained exact assessment. An interrupted
review reuses matching completed pair records through the
[continuation journal](source-review-continuation.md). The current binding
includes the complete observed overlay and request history: a source edit or
clarification creates new keys even for otherwise unchanged page/excerpt pairs.
Batching does not add incremental repair reuse.

A changed file digest, changed overlay tree, failed judgment or invalid citation
prevents a completed assessment. Source judgments remain advisory. Runtime
behavior and hosted readiness require separate executed evidence.

The assessment's historical `usage` describes tokens attached to its review
judgments, including replayed evidence. Per-invocation counters distinguish new
provider attempts and fresh reported tokens from journal reuse; see
[model cost accounting](builder-model-cost.md#accounting-and-evidence).
