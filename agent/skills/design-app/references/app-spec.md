# AppSpec and Build-Ready Contract

Keep `app-spec.md` human-readable and synchronized with prototype revisions.
This is internal planning guidance. Derive it from the brief and safe revisable
defaults without asking for formal specification or UI-finalization acceptance.
After the implementation plan is ready, present **Build this app?** for private
preview or **Build and release to Production?** for a new private Arrusted app
explicitly requested in Production. The Browser prototype is optional.

## Inference labels

- `user_stated`: directly supplied by the user.
- `evidence_observed`: demonstrated by a supplied artifact or existing system.
- `agent_inferred`: plausible but not accepted.
- `system_default`: supplied by an Autograph contract or declared prototype
  default.
- `user_confirmed`: reviewed and accepted.
- `unresolved`: unknown and potentially blocking.
- `deferred`: explicitly excluded from the first production version.

Apply labels to material decisions, not every sentence.

## Suggested coverage outline

Before recording or accepting an AppSpec, use the outline below to consider
this app's product meaning, prototype references, and labeled defaults or
deferrals. Section names, order, counts, and formatting are advisory. Organize
the document for the actual product; do not invent irrelevant roles, schemas,
interfaces, or capabilities merely to fill a heading. Do not submit the outer
four-backtick fence or these instructions as the specification.

Declare explicit intent in a JSON fenced block with `status: "build-ready"`
when ready. Its heading, location, spacing, and fence capitalization do not
control acceptance. The last valid JSON object declaring a top-level status
controls readiness; a later `draft` or other status does not enable planning.
The marker records intent only, never identity, grants, or provider approval.

````markdown
# AppSpec: <product name>

## Status and prototype

Version 1. Record the current Browser prototype paths and revision. Label safe
revisable defaults as system_default; do not call them user_confirmed.

## User and outcome

Describe the primary user, job to be done, desired outcome, and observable success.

## Interfaces and navigation

List the approved interfaces, navigation, and first-use path from the prototype.

## Controls and behavior

Give every visible control an action, state transition, and cross-interface effect. Record each control's precondition, observable result, cancellation/error behavior, and any explained unavailable state using `references/interactions.md`; distinguish simulated effects from intended production behavior.

## Data model

Describe owned objects, stable identities, fields, and relationships, or explicitly
state that no owned data is needed. Describe persistence needs in product terms.

## Integrations and reconciliation

Describe provider choices in prose, source of truth, refresh, imports, and
reconciliation. For a GitHub and Vercel workflow, describe which source-control
and application-hosting operations are required and which need separate approval.
Explicitly defer integrations that are outside the first version.

When requested, describe which provider accounts the app uses, who can connect
and activate them, the target data and reconciliation outcome, and whether an
Integrations page belongs in navigation. Executable recipe selection and typed
schema bindings belong to the app's integration definition during implementation;
keep this section as product intent and preserve separate outward-effect approval.

## Temporal semantics

Define timestamps, as-of/effective dates, stale data behavior, or an explicit non-goal.

## Writes, review, and authority

Identify reads, writes, drafts, review, provenance, and human approval before
repository publication, deployment, or other outward effects.

## Access and tenancy

Define roles, permissions, data sensitivity, and tenant/app scope.

Production apps default to private creator and invited-user access. When the
brief asks for self-signup, describe its eligibility and intended nonprivileged
app roles, then record that choice with `accept_app_spec.access`. Omit the
argument on an ordinary revision to retain the app's existing choice; use an
explicit private mode to stop new signup. This product intent does not grant
access: the Production operator validates the app's role catalog and obtains
the existing resource/access approval. Both modes use normal Production
delivery and the shared Auth/sender setup; they do not require a special Preview
or a separate Auth database for each app.

## Agent behavior

Define agent jobs, evidence, tools, limits, and human confirmation points,
or state that the first version has no agent behavior.

## Operational states

Define first-use, empty, loading, degraded, error, and recovery behavior.

## Defaults, non-goals, and risks

Label revisable defaults, explicit deferrals, non-goals, and risks. Resolve
material product questions before marking build-ready.

## Acceptance walkthrough

Describe a concrete sequence from first use through the primary user's successful
outcome, including every enabled navigation and action path, expected visible state changes, review, one failure/recovery path, and any behavior not yet verified in the Browser.

## Build handoff

```json
{
  "status": "build-ready"
}
```
````

Replace the instructional prose above with actual product decisions;
completeness includes meaningful section content.

## Build handoff

The consumed readiness field is `status`, exactly `build-ready`. Set it
after the complete AppSpec is internally validated from stated decisions and
safe revisable defaults. Omit the marker or use `status: "draft"` while a
materially product-changing choice remains unresolved. Other metadata is
ignored by readiness recognition and cannot supply execution authority.

Repository creation derives identity and default routes from the app ID. The
AppSpec is an optional product-intent snapshot; a convention CUE input selects
the generated data boundary. Additional public routes require a separate
reviewed topology edit. Record accountable teams, integrations, resources, data
needs, and write behavior in product prose rather than machine metadata.

Do not include app id, runtime, workspace, package, project, local port, schema
path, authorization copies, workspace dependencies, credentials, secrets,
provider ids, plan/region choices, environment values, or deployment ids. The
AppSpec records product meaning, not approval for outward effects; repository
conventions derive mechanical values, and provider configuration remains a
separate authority.

## Synchronization rule

For every visible prototype element, record its production meaning or mark it
illustrative/deferred. For every first-version AppSpec requirement, identify the
prototype interface that demonstrates it or note that it is nonvisual.

## Build-ready checklist

Mark build-ready only when:

- current UI revision and interface inventory follow stated preferences or clearly
  labeled safe revisable defaults;
- integrations and data objects are confirmed or deferred;
- sources, identities, relationships, and temporal meaning are adequate for the
  first workflow;
- every visible control and action has host-owned behavior;
- writes, review, provenance, access, and agent authority are settled;
- blocking inference labels have become confirmed, defaulted, deferred, or
  non-goals; and
- the walkthrough is complete enough for product review.

After those conditions pass, record explicit readiness with status
`build-ready`. When the design changes, update the internal specification and
plan silently. Do not turn internal recording or preparation into another user
approval.

Formal AppSpec recording is internal planning state. **Build this app?**
authorizes editing and validating the private checkout. **Build and release to
Production?** also authorizes the reviewed draft, managed setup, and merge
after required checks for the approved app and destination.
