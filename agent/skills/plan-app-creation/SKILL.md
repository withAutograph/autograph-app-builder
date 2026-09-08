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
2. References are bundled files, not skills. Never pass a reference path to
   `load_skill`; that tool accepts only the top-level `plan-app-creation` name.
   After this skill is loaded, use `read_skill_reference` with
   `plan-app-creation` and `references/app-contract-v1.md`, then read the result
   completely.
3. Read only the known product and design references needed from the exact
   prepared `workspacePath`. The typed planning operation owns target identity,
   collision, package, route, and topology inspection; do not run generic Git
   status or pass a sandbox path to the app-runtime `inspect_repository` tool.
   Do not modify production source or topology.
4. Use the lowercase kebab-case app id already preserved or inferred by the
   active `$create-app` workflow as the only authored contract input. Do not ask
   for it again. When invoked directly and no id exists, apply the same
   deterministic inference rule from `$create-app`; ask only for an unsupported
   identifier, real collision, or material ambiguity. Do not copy mechanical
   identities, routes, ports, schema paths, authorization summaries,
   dependencies, capabilities, or provider choices into the contract.
5. Require exactly one valid, internally validated `Build handoff` block. If the
   AppSpec is missing or incomplete, direct the active `$create-app` workflow to
   [$design-app](../design-app/SKILL.md), repair technical completeness, and
   retry silently. Ask only when an unresolved choice materially changes the
   product; never invent product authority.
6. Give `{ "version": 1, "appId": "<id>" }` to the builder-owned planning
   operation. The selected adapter owns the exact target command; never
   construct or guess a repository script path.

7. If existing-app planning reports a missing exact source preimage, call
   `inspect_existing_app` only for the exact app-owned candidate paths in that
   error, rebuild the requested replacements from those contents, and retry
   planning. Do not resolve, inspect, or prepare the source again, invoke the
   standalone dependency tool, or finish with a prose plan. For any other safe
   mechanical completeness issue, repair and retry boundedly. If a material
   product choice is unresolved, ask one
   product-domain question with a visible tradeoff and recommended default. If
   no product answer can resolve the constraint, explain the unavailable outcome
   and offer a product-level alternative. Never expose internal validator,
   specification, receipt, digest, workspace, source-contract, protocol, or
   blocker terminology.
8. If validation succeeds, return the canonical `contract`, including its exact
   AppSpec path and SHA-256 digest, the `futurePath`, derived
   product/source/topology `plan`, empty `blockers`, and `mutations: []`.
9. Present the product-relevant proposal and the next meaningful approval in
   plain language. Keep all internal mechanics and no-mutation boilerplate out
   of public messages. `$create-app`
   may persist and apply this exact proposal only after a separate
   source/topology approval gate.

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
