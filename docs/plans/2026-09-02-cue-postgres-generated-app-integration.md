---
title: "CUE/Postgres generated-app integration plan"
created_at: 2026-09-02
type: implementation-plan
status: proposed
---

# CUE/Postgres Generated-App Integration

This plan defines how App Builder will create new applications whose data
backend is authored in CUE, compiled into PostgreSQL, and consumed through a
type-safe Next.js boundary. It covers newly generated applications only.
Existing HC, Vendor, and other Arrusted applications are behavioral and parity
references; this plan does not migrate them.

The canonical compiler and runtime design lives in the Arrusted
[generated-app CUE/Postgres backend plan](https://github.com/withAutograph/arrusted-development/blob/main/docs/plans/2026-09-02-generated-app-cue-postgres-backend.md).
That document owns the runtime-adapter and database-binding decisions. App
Builder must not select, duplicate, or weaken those decisions.

## Objective

A user should be able to describe an application's data model and behavior in
an accepted AppSpec and receive a working Next.js application without writing a
separate data service, SQL, DAL, route handler, or Server Action.

The normal generated path is:

```text
accepted AppSpec
  -> app-owned CUE source
  -> normalized compiler contract
  -> PostgreSQL artifact
  -> generated validators and TypeScript bindings
  -> server-only DAL and mutation actions
  -> generated Next.js application
```

CUE is the only app-authored data-backend source. SQL, runtime-adapter metadata,
TypeScript bindings, validators, DAL modules, and mutation actions are generated
artifacts and are never edited as independent authorities.

## Scope and decision boundary

This plan introduces the App Builder side of the architecture, but it does not
choose either of the following:

1. direct PostgreSQL, private PostgREST, or private Hasura as the runtime
   adapter; or
2. CUE-generated or PostgreSQL-introspected database bindings.

Those choices require the conformance comparison and accepted ADR defined by
the canonical runtime plan. App Builder work may define and test the
adapter-neutral handoff before that decision. It must stop before generating
the first product application against a provisional adapter or binding source.

Whichever candidates are selected, the product-facing generated API remains
the same: Server Components use a server-only DAL for reads, and Client
Components invoke generated, authenticated mutation actions.

## AppSpec schema mode

The build-ready AppSpec contract gains a new schema selection:

```json
{
  "schema": {
    "kind": "cue-postgres"
  }
}
```

`none` remains valid for applications with no owned data. Existing `kernel`
inputs remain readable for existing tooling and applications, but App Builder
does not select `kernel` for a newly generated application after this mode is
available.

The schema mode is a product-level choice, not permission to infer provider
resources, credentials, deployment targets, or Production authority. The
accepted AppSpec remains the source for user-visible models, constraints,
relationships, tenancy, temporal behavior, writes, review requirements, and
named operations.

## AppSpec-to-CUE handoff

For `cue-postgres`, the app-creation proposal includes the complete proposed
CUE source and its destination under the new app's owned `schema/` directory.
The proposal also binds that source to:

- the accepted AppSpec path and digest;
- the app's immutable identity;
- the compiler and normalized-contract versions;
- the requested model capabilities and named operations; and
- the expected generated-output manifest.

Before application, App Builder validates the CUE source with the pinned
compiler and produces the normalized contract in an isolated planning
environment. An invalid or incomplete schema is a proposal failure. App
Builder must not create a placeholder path and leave schema authoring to an
untracked follow-up.

Application publishes the reviewed CUE source with the new workspace, then
runs generation through the repository-owned mise entrypoint. It does not run
DDL against a shared or Production database as part of repository mutation.
Database installation and activation remain separate, environment-scoped
operations owned by the canonical runtime contract.

## Generated application contract

Each `cue-postgres` application receives generated artifacts in four groups.

### Compiler artifacts

- normalized application contract;
- deterministic PostgreSQL bundle and materialization plan;
- artifact manifest, source map, compiler version, and content hashes; and
- runtime and database-binding compatibility metadata.

### Type and validation artifacts

- serializable model and projection DTOs;
- branded model and field identifiers;
- nullability, enum, relation, input, pagination, and result types;
- runtime parsers for every caller-controlled operation input; and
- a stable discriminated error contract.

The accepted ADR determines whether the internal database-binding types come
from the normalized CUE contract or PostgreSQL introspection. Operation
exposure, trusted fields, authorization requirements, and public DTOs always
come from the normalized CUE contract.

### Server-only data access

The generated DAL is marked `server-only` and exposes concrete methods rather
than a caller-typed generic query API. It contains:

- model reads and generated list/get operations;
- CUE-declared named queries;
- internal mutation methods used by generated actions;
- the selected runtime adapter behind a non-exported interface; and
- operation-to-cache invalidation metadata.

Server Components call read methods directly. Generated applications do not
route reads through Server Actions and do not make the database or a gateway
reachable from the browser.

### Mutation actions

Generated mutation modules use `use server` and expose model create, update,
delete, lifecycle transitions, and CUE-declared named commands. Each action:

1. treats its serialized arguments as untrusted;
2. authenticates the current user and authorizes the named operation;
3. derives app, tenant, actor, roles, provenance, and active-artifact identity
   from trusted server state;
4. validates caller-controlled input with the generated runtime parser;
5. invokes exactly one atomic DAL operation; and
6. invalidates only the affected generated data after success.

No action accepts a client-selected database role, tenant, app, actor,
provenance, implementation function, or artifact hash. Client Components may
import and invoke generated actions, but receive only serializable DTOs and
safe errors.

## Generated operation surface

Model CRUD maps to the compiled lifecycle rather than direct table mutation:

- create and update use the generated apply contract;
- update carries the required version or concurrency token;
- delete uses the compiled versioned deletion/tombstone behavior; and
- draft, approve, discard, revert, history, and activity methods are emitted
  only when enabled by the schema contract.

Named queries use compiler-supported projections, relationships, filters,
ordering, and bounded pagination. Named commands compile to one atomic
database operation using the runtime's closed mutation vocabulary. App Builder
must reject arbitrary SQL, arbitrary executable code, network access, and
provider credentials in CUE.

## First real generated-app proof

The first acceptance target is a real product application generated through
the ordinary App Builder lifecycle, not a synthetic demonstration app. Its
accepted schema must naturally exercise, or be paired with compiler fixtures
that exercise, all of the following:

- at least two related models;
- required, optional, unique, enum, and check-constrained fields;
- tenant isolation and role/capability authorization;
- create, read, update, and versioned delete behavior;
- one lifecycle operation when the product requires review or drafts;
- one named query with projection, filtering, and pagination; and
- one named atomic command.

Acceptance requires proof that:

1. App Builder produces and validates the app-owned CUE source from the
   accepted AppSpec;
2. the repository is created with no handwritten data-backend implementation;
3. the compiler artifacts and generated TypeScript are deterministic and
   current;
4. a Server Component reads through the generated DAL;
5. a Client Component mutates through a generated Server Action;
6. invalid input, unauthorized access, and cross-tenant access fail closed;
7. a successful mutation refreshes the affected rendered data; and
8. one CUE schema evolution produces a reviewed, non-destructive plan and a
   compatible regenerated application.

All local proof uses `mise run dev` and the repository's supported generated-
app validation entrypoints. Provider-backed Preview or Production proof is a
later, separately authorized step.

## Rollout

1. Land the canonical runtime plan and this integration plan with working
   cross-links.
2. Add the adapter-neutral normalized operation and artifact handoff without
   generating a product app.
3. Complete the runtime and binding conformance comparison; record and accept
   the two ADR decisions.
4. Add `cue-postgres` to the AppSpec, planning, validation, and app-creation
   contracts while preserving `none` and legacy-read compatibility for
   `kernel`.
5. Generate the selected DAL and action templates and prove them against
   compiler fixtures.
6. Run the first real generated-app acceptance flow.
7. Make `cue-postgres` the normal data-backed choice only after that proof is
   green and the generated repository remains reproducible from CUE.

## Non-goals

- migrating existing Arrusted applications;
- exposing Postgres, PostgREST, or Hasura directly to browsers;
- selecting the runtime adapter or database-binding source in this document;
- encoding provider protocols, secrets, or arbitrary orchestration in CUE;
- running installation or activation inside a request or Server Action; or
- claiming that every application behavior is declarative in the first data-
  backend milestone.
