# AppSpec and Build-Ready Contract

Keep `app-spec.md` human-readable and stable across prototype revisions.

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

## Required sections

Use each of these exact level-two headings once. Content may be concise, but it
must record confirmed behavior, an accepted default, an explicit deferral, or a
non-goal rather than silently omitting the decision.

1. `## Status and prototype`: version, prototype paths, and status.
2. `## User and outcome`: primary user, JTBD, desired outcome, and observable
   success.
3. `## Interfaces and navigation`: approved interfaces, navigation, and
   first-use path.
4. `## Controls and behavior`: visible controls, actions, states, and
   cross-interface behavior.
5. `## Data model`: data objects, identities, fields, and relationships.
6. `## Integrations and reconciliation`: integrations, imports, refresh,
   source-of-truth, and reconciliation policy.
7. `## Temporal semantics`: as-of and effective-date behavior.
8. `## Writes, review, and authority`: reads, writes, drafts, review,
   provenance, and authority.
9. `## Access and tenancy`: roles, permissions, sensitivity, and tenant/app
   scope.
10. `## Agent behavior`: agent jobs, evidence, tools, limits, and human
    confirmation points.
11. `## Operational states`: empty, loading, degraded, error, and first-use
    behavior.
12. `## Defaults, non-goals, and risks`: accepted defaults, non-goals,
    explicit deferrals, risks, and unresolved questions.
13. `## Acceptance walkthrough`: the plain-language acceptance walkthrough.
14. For a build-ready AppSpec, one strict `## Build handoff` block using the
    shape below.

## Build handoff

Include exactly one level-two `Build handoff` heading followed by exactly one
`json` fenced block. This is the machine-readable projection of the accepted
AppSpec, not a second product specification:

```json
{
  "status": "build-ready",
  "owner": "finance-platform",
  "schema": {
    "kind": "kernel"
  },
  "additionalPublicRoutes": ["/expenses", "/expenses/:path*"],
  "optionalCapabilities": {
    "integrations": ["accounting-sync"],
    "hostedResources": ["relational-database"]
  }
}
```

Every object is closed. Arrays must be sorted and contain no duplicates.

- `status` is exactly `build-ready`, and may be set after the complete contract
  is internally validated from stated decisions and safe revisable defaults.
  Omit the entire block while a materially product-changing choice remains
  unresolved.
- `owner` is the non-empty accountable team or domain identity.
- `schema.kind` is `none` when the app owns no kernel data, otherwise `kernel`.
- `additionalPublicRoutes` contains only exceptional public routes. Do not list
  the derived `/<app-id>` or `/<app-id>/:path*` routes.
- Capability values are provider-neutral lowercase kebab-case identifiers. Use
  empty arrays when none apply.

Do not include app id, runtime, workspace, package, project, local port, schema
path, authorization copies, workspace dependencies, credentials, secrets,
provider ids, plan/region choices, environment values, or deployment ids. The
accepted AppSpec already carries authorization and product meaning; repository
conventions derive mechanical values, and provider configuration remains a
separate authority.

## Synchronization rule

For every visible prototype element, record its production meaning or mark it
illustrative/deferred. For every first-version AppSpec requirement, identify the
prototype interface that demonstrates it or note that it is nonvisual.

## Build-ready checklist

Mark build-ready only when:

- accepted UI revision and interface inventory follow stated preferences or clearly
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
`build-ready`. Any subsequent AppSpec byte change invalidates its prepared
digest and requires a new review and preparation result.

Formal AppSpec recording is internal planning state, not authority to mutate the
target. Target mutation still requires its own explicit approval.
