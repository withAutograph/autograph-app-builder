# AppSpec and Build-Ready Contract

Keep `app-spec.md` human-readable and synchronized with prototype revisions.
This is internal planning guidance. Derive it from the brief and safe revisable
defaults without asking for formal specification or UI-finalization acceptance.
The first normal prompt remains **Build this app?** after the Browser prototype
and implementation plan are ready.

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

## Canonical complete skeleton

Before the first AppSpec recording or `accept_app_spec` call, copy the entire
Markdown block below. Replace the section bodies with this app's product
meaning, prototype references, and labeled defaults or deferrals. Keep all 14
exact level-two headings once, even when a section only says why it does not
apply. Do not submit the instructions around the block or the outer four-backtick
fence. Do not use a shorter example or reconstruct the headings from memory.

The final section must be exactly `## Build handoff`, one blank line, and one
lowercase `json` fenced block. End the document at that block's closing fence:
no conclusion, checklist, comments, or additional sections after it. The
handoff is a machine-readable projection of this same product specification.

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
state that no owned data is needed. Match schema.kind below to this decision.

## Integrations and reconciliation

Describe provider choices in prose, source of truth, refresh, imports, and
reconciliation. For a GitHub and Vercel workflow, describe which source-control
and application-hosting operations are required and which need separate approval.
Use only the provider-neutral intent in optionalCapabilities below. Explicitly
defer integrations that are outside the first version.

## Temporal semantics

Define timestamps, as-of/effective dates, stale data behavior, or an explicit non-goal.

## Writes, review, and authority

Identify reads, writes, drafts, review, provenance, and human approval before
repository publication, deployment, or other outward effects.

## Access and tenancy

Define roles, permissions, data sensitivity, and tenant/app scope.

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
  "status": "build-ready",
  "owner": "product-operations",
  "schema": { "kind": "kernel" },
  "additionalPublicRoutes": [],
  "optionalCapabilities": {
    "integrations": ["application-hosting", "source-control"],
    "hostedResources": []
  }
}
```
````

The skeleton's capability pair illustrates a GitHub/Vercel workflow; include it
only when those operations are part of this app. Empty arrays are correct when
no optional capabilities apply. Replace the instructional prose above with
actual product decisions; completeness includes meaningful section content.

## Build handoff

Every object is closed. Arrays must be sorted and contain no duplicates.

- `status` is exactly `build-ready`, and may be set after the complete contract
  is internally validated from stated decisions and safe revisable defaults.
  Omit the entire block while a materially product-changing choice remains
  unresolved.
- `owner` is the non-empty accountable team or domain identity.
- `schema.kind` is `none` when the app owns no kernel data, otherwise `kernel`.
- `additionalPublicRoutes` contains only exceptional public routes. Do not list
  the derived `/<app-id>` or `/<app-id>/:path*` routes.
- Both capability arrays use provider-neutral lowercase kebab-case identifiers.
  Name what the app needs, not the vendor that supplies it. For example:

  | Product prose                                | Handoff intent when required          |
  | -------------------------------------------- | ------------------------------------- |
  | GitHub repositories, branches, pull requests | `source-control` integration          |
  | Vercel previews and deployments              | `application-hosting` integration     |
  | Neon or another relational database          | `relational-database` hosted resource |

  Never put `github`, `github-repositories`, `vercel`, `vercel-deployments`,
  `neon`, or other provider names in either array. The planner rejects provider
  segments even when the identifier is valid kebab-case. Keep the requested
  provider and its behavior in `Integrations and reconciliation` prose; do not
  silently discard a required integration to make validation pass. Do not use
  `hostedResources` to list providers the app connects to; it describes resources
  the app itself needs. Use empty arrays when none apply.

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

After those conditions pass, add the strict Build handoff block with status
`build-ready`. When the design changes, update the internal specification and
plan silently. Do not turn internal recording or preparation into another user
approval.

Formal AppSpec recording is internal planning state, not authority to mutate the
target. **Build this app?** authorizes editing and validating the private checkout;
repository publication and other outward effects require separate approval.
