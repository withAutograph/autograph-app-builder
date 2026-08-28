---
name: plan-app-creation
description: Validate an accepted AppSpec and produce a canonical, read-only AppSpec-bound app creation proposal. Use when a user explicitly asks to plan app creation, inspect an app contract, diagnose creation blockers, or refresh a stale proposal. Generic app-creation requests belong to $create-app.
---

# Plan App Creation

Guide one continuous user journey to a reviewed proposal. Preserve separate
product-acceptance and mutation authorities: do not create the app, persist its
contract, register routes, materialize schemas, reconcile providers, or deploy
anything.

Planning requires the discovered builder-owned planning tool. If it is absent,
report that the operation is not implemented; never execute the adapter command
through a generic shell.

## Workflow

1. If the user explicitly requests only a bare/local Next.js workspace, hand off
   to `$scaffold-app-workspace` and stop this route-owned flow. Do not interpret
   a generic “create an app” request as bare scaffolding.
2. Read [the AppContractV1 reference](references/app-contract-v1.md) completely.
3. Inspect the prepared target workspace's `git status --short`, workspace package identities, existing
   `apps/<id>` directories, `microfrontends.json`, and the
   conventional `prototype/<id>/app-spec.md`. Do not modify production source
   or topology.
4. Collect only the lowercase kebab-case app id as contract input. Do not ask
   for or copy mechanical identities, routes, ports, schema paths,
   authorization summaries, dependencies, capabilities, or provider choices
   into the contract.
5. Require exactly one valid, explicitly accepted `Build handoff` block. If
   the AppSpec is missing or not build-ready, direct the active `$create-app`
   workflow to [$design-app](../design-app/SKILL.md). When invoked directly,
   report the missing product authority and stop; never infer or silently repair
   product policy.
6. Give `{ "version": 1, "appId": "<id>" }` to the builder-owned planning
   operation. The selected adapter owns the exact target command; never
   construct or guess a repository script path.

7. If validation reports blockers, return them precisely. Do not work around
   AppSpec, identity, topology, or authority failures.
8. If validation succeeds, return the canonical `contract`, including its exact
   AppSpec path and SHA-256 digest, the `futurePath`, derived
   product/source/topology `plan`, empty `blockers`, and `mutations: []`.
9. State explicitly that nothing was created, written, routed, provisioned,
   admitted, or deployed. `$create-app` may persist and apply this exact
   proposal only after a separate source/topology approval gate.

## Boundaries

- Keep `$scaffold-app-workspace` as the separate bare-workspace primitive. Use
  it only for explicit bare-workspace intent, never as the apply step for a
  prepared route-owned app.
- Never run `turbo gen app`, `create:app`, a provider reconciliation command, or a deployment command.
- Never edit `microfrontends.json`, `amp.yaml`, provider specifications, registry files, environment configuration, or application source.
- Treat the accepted AppSpec and its digest as the product and authorization authority. Any AppSpec change requires a new digest and review.
- Treat handoff capability identifiers as provider-neutral planning intent only. Reject credentials, secrets, provider ids, plan or region settings, environment values, deployment ids, and provider-specific configuration.
- Do not allocate or persist a local port. Pitchfork and Worktrunk resolve runtime ports; the existing launcher owns its direct-use fallback.
- Never claim that a valid proposal means the app exists or is locally valid, routed, admitted, provisioned, deployed, or Production-ready.
