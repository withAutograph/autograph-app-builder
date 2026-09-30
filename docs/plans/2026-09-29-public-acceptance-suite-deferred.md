# Public app-building acceptance suite

Status: deferred future consideration by user decision on September 29, 2026.

## Decision and purpose

Defer implementation of a repeatable public acceptance suite. The proposed
suite would measure how consistently App Builder builds and revises apps,
recovers interrupted work, and preserves approved publication outcomes through
the ordinary product interface. It addresses an evidence gap; planning did not
identify a new building defect that requires this suite to repair.

The successful public Builder-led Spend Review exercise remains evidence for
that particular workflow and run. Existing deterministic and Sandbox checks
retain their own provenance. Neither establishes success rates across varied
public builds. Preserve the successful exercise without restoring its retired
synthetic demo path or treating it as hosted Production proof.

The broader suite would add fixture maintenance, fault orchestration, live-model
and provider costs, and evidence-retention work. Its current value does not
justify that scope. Address observed defects with focused regression coverage
and exercise the existing public path after substantial workflow changes.

## Reasons to reconsider

Revisit this proposal when repeated public build or recovery failures need a
reproducible comparison, a substantial workflow change warrants broader public
coverage, or an operational decision requires measured completion rates,
elapsed time, retries, and blockers. Start with the smallest case that answers
the concrete question.

## Possible future scope

- A small static app, a CUE-backed app, and an existing-app revision, each with a
  fixed product brief and answer sheet. Exact apps and briefs remain undecided.
- Separately assessed recovery cases for interrupted validation, compute
  replacement, current-base reconciliation, and publication lost-response
  recovery. Distinguish loss of a public reply from loss of a provider
  acknowledgement; do not award one form of recovery from evidence of the other.
- Retained first attempts and every retry, with explicit passed, failed, blocked,
  and unassessed outcomes. Resume saved public sessions and preserve any
  checkpoint-resume parent/child chain instead of selecting a successful reroll.
- Portable redacted reports and private continuation evidence outside the source
  tree. Record scenario, tested revisions, session lineage, replies, approvals,
  observed behavior, elapsed time, retries, and blockers.

Extend the [existing public driver](../../scripts/self-reproduction-public.mts),
[scenario inventory](../../evals/scenario-inventory.json), and
[acceptance/evidence contract](../evals/self-reproduction.md). Use the
[five public MCP tools](../public-mcp-contract.md) or web entrypoint with
ordinary product answers, real connection flows, and explicit approvals. Builder
owns acquisition, setup, implementation, validation, and recovery. Evaluator
faults must affect only authorized, suite-owned infrastructure; evaluator source
repairs and private workflow-stage instructions cannot earn public product credit.

Authenticated persistence and tenant assertions belong to the separate behavior
proof work. Any future handoff must identify the exact case, app revision,
environment, predicates, outcomes, and supporting evidence. Evidence from one
app or environment cannot establish another's behavior. Deterministic cross-repo
command/package compatibility work also remains separate. This proposal does
not duplicate durable dependency logs or atomic response-batch work.

## Choices required before starting

Agree on exact scenarios and answer sheets, approval policy, supported fault
mechanisms, Builder model and live-run budget, fixture ownership and publication
authority, local versus hosted scope and identities, execution frequency, and
evidence retention. Introduce hosted acceptance only as a separately authorized
phase. Any acceptance suite measures the product; it does not become a per-app
admission gate or introduce product quotas.

This record authorizes no suite implementation, live generation, fault injection,
publication, provider mutation, merge, or Production activation.
