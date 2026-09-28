# Builder workload capacity policy

This policy is normative for App Builder implementation, reviews, tools,
prompts, storage, diagnostics, and generated-app workflows. The default is that
valid work continues regardless of repository size, file count, artifact size,
history length, request count, retry count, or elapsed session time.

## Do not impose product workload ceilings

Builder MUST NOT add a fixed total ceiling that rejects otherwise valid work,
including caps on files, bytes, repositories, pages, events, pending requests,
review output, command output, name candidates, retries, app builds, or session
lifetime. A value does not become safe because it is called a timeout, guard,
eligibility check, implementation detail, default, cleanup rule, or test-only
limit. Product or operational convenience alone is not sufficient justification.

Do not silently truncate, discard, or omit accepted work or diagnostics to fit an
internal ceiling. If a result cannot fit in one tool call, transport message,
database transaction, model context, or process buffer, split the operation and
continue it with streaming, pagination, chunking, backpressure, or durable
continuation. Page and chunk sizes may bound memory for one operation; they
MUST NOT bound the total workload.

## Allowed finite bounds

A finite bound is allowed only when it has a concrete, named basis and its
scope is explicit:

- **Security:** Bound untrusted input, authentication abuse, credentials, and
  identifiers as needed to protect the service. Keep the bound specific to the
  untrusted operation; do not reuse it to cap stored history or trusted output.
- **Correctness and integrity:** Use transaction, lease, path, tenant, digest,
  idempotency, and per-call bounds required to prevent corruption, cross-tenant
  access, duplicate outward effects, or unsafe cleanup. These checks must not
  become speculative repository eligibility or workload gates.
- **Per-operation resource bounds:** Respect actual memory, database,
  transport-envelope, or provider-call constraints by streaming or paging.
  A per-call constraint is acceptable only when the workflow can continue the
  complete operation without a total count, byte, attempt, or duration ceiling.
- **External provider limits:** Let the provider enforce its documented hard
  limits. Report the provider, operation, affected path or resource, safe error
  detail, and a practical recovery option. Never mislabel a provider failure as
  an App Builder quota or silently redesign the app to evade it.
- **Cleanup:** Reclaim compute and temporary files when their leases or
  operations end. Cleanup MUST preserve durable progress, history, approvals,
  and the ability to resume. A compute lease is not a session lifetime cap.

## Retry and recovery behavior

Retry frequency may use exponential backoff, jitter, provider retry headers,
and concurrency fencing. These control pressure on providers; they MUST NOT
impose a total attempt count, session lifetime, or cumulative build deadline.
Persist retry identity, attempt count, next retry time, progress, and sanitized
failure details so automatic retries survive browser closure and process
restarts.

Retry transient failures automatically while authorization remains valid.
Recheck authorization before outward effects. Reconcile uncertain writes before
redispatch; never blindly retry a write that could create a duplicate. Pause
for user action only when the failure is actionable, authorization is missing,
the user cancels, or a real product decision is required. State the exact
operation, evidence, cause, next action, and whether retry is scheduled. Do not
repeat an unchanged deterministic failure without new evidence or a changed
input; diagnose it, preserve progress, and give a concrete repair path instead
of imposing a generic attempt limit.

## Required review for every proposed limit or gate

Before adding or retaining a finite limit, the author and reviewer MUST record:

1. The concrete security invariant, correctness failure, measured per-operation
   resource constraint, or named provider rule that requires it.
2. The limit's owner, unit, scope, and whether it affects one operation or the
   total workload.
3. Why streaming, pagination, chunking, backpressure, retry, or continuation
   cannot address it.
4. What users and operators observe at the boundary, including the affected
   resource, complete retrievable diagnostics, and recovery path.
5. Tests just below and above the boundary, plus interrupted-work and retry
   coverage where relevant.

If an author cannot establish this basis, remove the limit. A total product
quota requires an explicit product decision; engineering MUST NOT invent one.
Reviews MUST look through every layer where a ceiling can hide: UI and prompts,
tool schemas, app contracts, API request parsing, provider adapters, database
schemas, queues, process output, transport serialization, history retention,
retry schedules, cleanup, and test harnesses.

The [live limit and recovery inventory](builder-build-limits-inventory.md)
records current implementation boundaries and known compatibility gaps. It
does not grant permission to introduce new ceilings.
