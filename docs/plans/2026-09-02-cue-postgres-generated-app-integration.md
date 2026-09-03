---
title: "CUE/Postgres generated-app integration plan"
created_at: 2026-09-02
type: implementation-plan
status: proposed
---

# CUE/Postgres Generated-App Integration

This plan defines how App Builder will create new applications whose data
backend is authored in CUE, compiled into a private PostgreSQL kernel plus a
public, typed PostgreSQL `api` schema, and consumed through a type-safe Next.js
boundary. Here, public means available to the selected private runtime adapter,
not reachable from a browser or the public internet. This plan covers newly
generated applications only.
Existing HC, Vendor, and other Arrusted applications are behavioral and parity
references; this plan does not migrate them.

It also defines a pre-application evaluation of
[Fate](https://fate.technology/) as an optional React projection and mutation
runtime backed by generated integration. Fate is an unselected frontend
candidate. It cannot become a
schema, authorization, database, or runtime authority.

The canonical compiler and runtime design lives in the Arrusted
[generated-app CUE/Postgres backend plan](https://github.com/withAutograph/arrusted-development/blob/main/docs/plans/2026-09-02-generated-app-cue-postgres-backend.md).
That document owns the PostgreSQL API seam, the runtime-adapter and
database-binding decisions, the migration-tooling decision, and the compiler
and database invariants that every frontend view layer must preserve. App
Builder must not select, duplicate, or weaken those decisions. This document
owns the separate Next.js view-layer spike and ADR, plus the external
access-surface spike and ADR. Platform/control-plane APIs and MCP remain
separate from generated-app data-plane access.

## Objective

A user should be able to describe an application's data model and behavior in
an accepted AppSpec and receive a working Next.js application without writing a
separate data service, SQL, DAL, route handler, or Server Action.

The normal generated path is:

```text
accepted AppSpec
  -> app-owned CUE source
  -> normalized compiler contract
  -> desired private PostgreSQL kernel and public typed PostgreSQL API schema
  -> typed migration intent and selected migration-engine input
  -> selected migration engine
  -> validated artifact activation in PostgreSQL
  -> adapter metadata, validators, and TypeScript bindings
  -> server-only DAL and generated actions
  -> generated frontend projection metadata and selected view integration
  -> generated Next.js application
```

CUE is the only app-authored data-backend source. The public PostgreSQL `api`
schema is the stable generated seam consumed by every runtime projection. SQL,
runtime-adapter metadata, protocol and database bindings, validators, DAL
modules, actions, and any frontend view metadata are generated artifacts and
are never edited as independent authorities.

All application data reads, authorization and tenant decisions, constraints,
lifecycle transitions, atomic commands, and artifact-compatibility checks
terminate in PostgreSQL. External provider calls are not database operations;
later versioned capabilities must authorize and record their durable state in
PostgreSQL while platform-owned adapters retain credentials and network
protocols.

## Scope and decision boundary

This plan introduces the App Builder side of the architecture, but it does not
choose any of the following:

1. direct PostgreSQL, private PostgREST, private PostgREST plus `pg_graphql`,
   private Hasura v2, private Hasura DDN/v3, or private PostGraphile as the
   runtime adapter; or
2. CUE-generated or PostgreSQL-introspected database bindings; or
3. the existing Arrusted Rust planner and installer, Atlas Community, Atlas
   Pro, `pg-schema-diff` with a thin Arrusted lifecycle adapter, or `pgroll` as
   the schema-migration implementation; or
4. direct Server Component-to-DAL reads or Fate component views backed by a
   generated read Server Action as the frontend view layer; or
5. the external REST/GraphQL, SDK, CLI, and generated-MCP access surface or
   its generator path.

The first three choices require the conformance comparisons and accepted ADRs
defined by the canonical runtime plan. The fourth requires the view-layer
spike and accepted ADR in this document; the fifth requires the access-surface
spike and accepted ADR. App Builder work may define and test
the adapter-neutral handoff before those decisions. It must stop before
generating the first product application against a provisional adapter,
binding source, migration engine, or view layer.

No runtime adapter, database-binding source, migration engine, frontend view
layer, access surface, or generator is selected by this plan. In particular,
Atlas Community, Atlas Pro, `pg-schema-diff`, `pgroll`, and Fate remain
unselected.

Whichever candidates are selected, the product-facing server contract remains
generated named operations over a server-only DAL. Every adapter consumes only
the generated PostgreSQL `api` schema and may translate its typed views and
functions into SQL, REST, RPC, or GraphQL. It cannot become an independent
schema, relationship, authorization, or operation authority. Client Components
invoke generated, authenticated mutation actions. The baseline view candidate
has Server Components call DAL reads directly; the Fate candidate additionally
permits bounded, authenticated read actions after hydration.

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

The AppSpec never selects a migration engine or supplies migration files,
engine revisions, operational roles, connection details, or activation
instructions. The engine is an environment and architecture decision applied
to compiler-generated artifacts after application generation.

## Migration-tooling handoff

The compiler hands the selected migration engine deterministic, hash-bound
inputs rather than an independently editable migration source. The handoff
contains the desired private-kernel and public-API catalogs, immutable logical
identities, predecessor and target artifact hashes, typed migration intent,
data-preservation and compatibility requirements, validation requirements, and
source mappings.

The accepted migration-tooling ADR may authorize an engine to inspect, plan,
execute, maintain a private operational ledger, serve active and candidate
schemas concurrently, activate, and roll back. Any such lifecycle remains a
mechanical realization of the compiler contract:

- engine state maps one-to-one to compiler artifact hashes;
- handwritten or app-authored migration input is rejected;
- engine metadata, ledgers, roles, and administration objects remain private
  and absent from runtime-adapter introspection;
- activation succeeds only after compiler-required validation and an atomic
  expected-artifact transition; and
- the engine emits a canonical lifecycle receipt identifying its pinned
  version, source and target artifacts, plan hash, completed phases, validation
  result, active artifact, and rollback disposition.

App Builder includes only the selected pinned integration and generated input
format after the ADR. Components, Server Actions, DAL methods, and AppSpec
remain migration-engine independent. The five migration candidates and their
complete conformance requirements are owned by the canonical Arrusted plan.

## Generated application contract

Each `cue-postgres` application receives generated artifacts in four groups.

### Compiler artifacts

- normalized application contract;
- deterministic private PostgreSQL kernel, including physical lifecycle and
  version tables, constraints, forced RLS, and internal JSON kernel functions;
- public typed PostgreSQL `api` schema containing security-invoker read
  projections, stable named-read functions, volatile CRUD/lifecycle/command
  functions, named parameters, typed row or composite results, and generated
  grants;
- deterministic desired PostgreSQL catalog and typed migration intent for both
  layers, including predecessor and target identities, preservation rules,
  compatibility requirements, validation requirements, and source maps;
- selected engine input plus the canonical plan and lifecycle-receipt contract;
- artifact manifest, compiler version, content hashes, and migration-engine
  compatibility metadata; and
- relationship, limit, active-artifact, runtime-adapter, protocol-binding, and
  database-binding compatibility metadata.

Physical tables, installer and administration functions, and internal JSON
kernel primitives are not adapter introspection surfaces. Typed API functions
may wrap those kernel primitives without changing their internal behavior.

### Type and validation artifacts

- serializable model and projection DTOs;
- branded model and field identifiers;
- nullability, enum, relation, input, pagination, and result types;
- runtime parsers for every caller-controlled operation input; and
- a stable discriminated error contract.

The accepted ADR determines whether the internal database-binding types come
from the normalized CUE contract or introspection of an installed PostgreSQL
API schema. Operation exposure, trusted fields, authorization requirements,
runtime masks, capability manifests, and public DTOs always come from the
normalized CUE contract because database or protocol introspection cannot
recover those semantics.

The selected runtime adapter may additionally use private generated protocol
bindings. PostgREST candidates may use its OpenAPI description or compatible
PostgREST type generation; GraphQL candidates may use GraphQL introspection and
generated typed documents; direct PostgreSQL may use catalog-derived bindings.
Those bindings are implementation details behind the DAL, not application
imports or additional authorities. A managed PostgREST-compatible service such
as Neon Data API is a deployment form of the PostgREST candidate rather than a
separate semantic candidate.

If the Fate candidate is being evaluated, the compiler also emits candidate
entity identity and relationship metadata, TypeScript view types, server-side
field and relation masks, allowed named read roots and argument validators,
and cache invalidation and active-artifact metadata. These artifacts must work
in Next.js without depending on Fate's Vite-specific generation path.

### Server-only data access

The generated DAL is marked `server-only` and exposes concrete methods rather
than a caller-typed generic query API. It contains:

- model reads and generated list/get operations;
- CUE-declared named queries;
- internal mutation methods used by generated actions;
- the selected runtime adapter behind a non-exported interface; and
- operation-to-cache invalidation metadata.

The selected adapter receives only fixed generated operation identifiers,
validated input, and trusted server context, and accesses only the public
PostgreSQL `api` schema. App code cannot supply a table, view, function, SQL
fragment, REST path, GraphQL document, role, or implementation identifier.

Under the baseline view candidate, Server Components call read methods
directly. Under the Fate candidate, server rendering still executes through
this DAL, while post-hydration reads may enter through the generated bounded
read action defined below. Neither candidate makes the database or a selected
runtime projection reachable from the browser.

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

If Fate is selected, generated mutation results and invalidation metadata may
reconcile its normalized cache. Optimistic updates must roll back on
validation, authentication, authorization, conflict, constraint, timeout, or
transport failure. Fate does not replace the generated mutation action or its
atomic DAL operation.

## Frontend view-layer candidates

The view-layer comparison does not reopen the server operation contract. A CUE
named query declares an authorized backend operation, including its visible
models and relations, filters, ordering, pagination, arguments, and result
capabilities. A Fate component view is a TypeScript projection composed within
those capabilities. A PostgreSQL API view is a typed compiler output inside the
public PostgreSQL `api` schema and is unrelated to a Fate component view. A
runtime adapter projects that API schema into SQL, REST, RPC, or GraphQL without
changing either meaning.

### Server Component and DAL baseline

Server Components invoke concrete generated DAL reads and pass serializable
DTOs to Client Components. Mutations use the generated actions above. This is
the retained fallback and the production behavior unless the view-layer ADR
explicitly selects Fate.

### Fate as a generated projection runtime

Fate provides explicit, composable component views, normalized caching, and
server-side data masks. Its official maturity guidance is currently
inconsistent: the Getting Started page retains an alpha warning while the
[Fate 1.0 announcement](https://fate.technology/posts/fate-1.0) describes the
release as production-ready. Its documentation also provides Vite-oriented
automatic type wiring, so none of those capabilities or maturity claims are
assumed to satisfy this Next.js architecture without proof. References:
[views](https://fate.technology/guide/views),
[server integration](https://fate.technology/integrations/server), and
[getting started](https://fate.technology/guide/getting-started).

The intended candidate architecture is not CUE versus Fate. CUE compiles the
secure data capability graph; PostgreSQL enforces it; Fate is the React
projection and mutation runtime over that graph. CUE declares model identities,
read and command-result capabilities, relations, filters, pagination, command
inputs, authorization references, and artifact compatibility. It does not
declare a component, a Fate `view`, a React event handler, a `dataView`, or a
client cache policy.

For the candidate, the compiler emits a deterministic Fate manifest alongside
SQL, the DAL, and actions:

```text
app-owned CUE
  -> normalized data capability graph
      -> private PostgreSQL kernel
      -> public typed PostgreSQL API schema
      -> selected private adapter and generated DAL/actions
      -> generated Fate entity types and roots
      -> generated server data-view masks and relation resolvers
      -> generated read/mutation transport maps and cache metadata
```

The generated Fate server integration resolves through the DAL rather than
calling Fate's Prisma, Drizzle, or native browser HTTP helpers. Direct
PostgreSQL and REST candidates use the generated custom Fate transport.
GraphQL candidates may evaluate Fate's
[`createGraphQLTransport`](https://fate.technology/api/%40nkzw/fate/functions/createGraphQLTransport)
behind the authenticated Next.js read boundary after the generated root,
selection, argument, and scope checks pass. It never receives a browser-visible
gateway URL or credential. `dataView` masks, procedure IDs, mutation maps,
TypeScript types, protocol bindings, and cache scopes are compiler outputs and
are never app-authored parallel authorities. The same app-authored Fate
components and component views must run unchanged against all six adapter
spikes. The canonical runtime plan owns this capability-graph contract and its
detailed invariants.

### Precise authoring boundary

This division is mandatory if Fate is selected:

| Layer                              | Owns                                                                                                                                                                                                                                                    | Must not own                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| App-owned CUE                      | data model, relations, permitted named read/command capabilities, constraints, and authorization references                                                                                                                                             | React components, Fate component views, DOM events, cache state, or a transport implementation               |
| Compiler-generated integration     | private PostgreSQL kernel, public PostgreSQL API schema, adapter metadata and protocol bindings, DAL, Server Actions, entity TypeScript types, generated Fate roots/action map, server `dataView` masks, transport, cache scope, and runtime validation | independently edited schema, policy, gateway semantics, component views, or arbitrary client query access    |
| App-authored React/Fate components | presentation, component-local `view<T>()` declarations, view composition, `useView`, `useRequest`, normal React Actions, pending UI, and safe expected-error UI                                                                                         | tables, SQL, RLS, DAL calls, trusted context, operation implementation, server masks, or authority selection |

The compiler does not generate an app's component views or components. A
component author uses Fate normally: it imports `view`, `useView`,
`useRequest`, and `useFateClient` from `react-fate`, and compiler-emitted entity
types from the generated package. It may select and compose only fields known
to the emitted capability types. The generated root types reject selections
that are outside that root's CUE capability at build time; the transport treats
every serialized selection as untrusted and repeats the check against the
current server-side authorization mask.

`dataView` and a Fate component `view` are deliberately different terms. A
`dataView` is a compiler-generated server mask that bounds what can ever leave
the generated DAL boundary. A component `view<T>()` is app-authored React code
that asks for the subset it needs to render. Adding an existing permitted field
to a component view changes neither CUE nor SQL. Exposing a new field or
relation requires a CUE change and recompilation.

React components use normal React event handlers or form actions. They may
call `fate.actions.task.complete` through `useActionState`, for example, but
that action name and its private generated transport mapping originate in CUE.
This candidate does not introduce a global DOM-event router, `data-*` mutation
protocol, or a component-visible Server Action implementation.

The candidate has two read paths:

1. Server rendering creates a request-scoped Fate client, executes reads
   through the generated DAL, and dehydrates only state bound to the current
   app, tenant, user and authorization scope, and active artifact.
2. After hydration, a custom Fate transport invokes a generated
   `executeFateRead` Server Action. The transport batches `byId`, list, and
   named-query work from the same request window into one bounded action call
   rather than creating an action waterfall. Fate exposes a custom
   [transport interface](https://fate.technology/api/@nkzw/fate/interfaces/Transport)
   for this evaluation. With a GraphQL adapter, the generated server-side
   implementation may use Fate's GraphQL transport only after validation; the
   browser-facing action contract is unchanged.

The read action treats the complete batch as untrusted serialized input. It
authenticates and authorizes each operation, derives trusted app, tenant,
actor, capability, provenance, and artifact context on the server, validates
the named root, fields, relations, arguments, selection depth, batch size,
pagination, row limit, and payload size against compiler-generated masks, and
then invokes the DAL. It returns only generated serializable DTOs and safe
errors. There is no `/fate` Route Handler, browser-visible runtime gateway, or
generic table query API.

Generated Fate mutations map one-for-one to CUE CRUD/lifecycle/named commands
and their existing Server Actions. A mutation may request only the command's
declared result capability for cache reconciliation; it cannot select an
operation, function, authority, or field outside the generated manifest.
Expected errors stay safe serialized action results, unexpected failures reach
the nearest configured React error boundary, and optimistic updates roll back
on every failed or rejected command.

### Illustrative generated-app shape

The following is a target sketch, not final CUE syntax or an additional
authoring authority. The app author declares a named read and command in CUE;
the compiler emits the Fate-facing modules from the resulting normalized
capability graph.

```cue
// app-owned CUE, illustrative only
queries: projectBoard: {
  input: { projectId: UUID }
  capability: Project {
    id
    name
    status
    tasks: { id, title, status, dueAt }
  }
}

commands: completeTask: {
  input:  { taskId: UUID, version: int }
  result: Task { id, status }
}
```

```text
generated/
  dal.server.ts
  actions.ts
  fate/types.ts
  fate/data-views.server.ts
  fate/roots.ts
  fate/mutations.ts
  fate/transport.server.ts
  fate/transport.client.ts
```

```tsx
// app/components/task-row.tsx -- app-authored, ordinary Fate component code
"use client";

import { useActionState, useTransition } from "react";
import { view, useFateClient, useView, type ViewRef } from "react-fate";
import type { Task } from "@/generated/fate/types";

export const TaskRowView = view<Task>()({
  id: true,
  title: true,
  status: true,
  version: true,
});

export function TaskRow({ task: taskRef }: { task: ViewRef<"Task"> }) {
  const task = useView(TaskRowView, taskRef);
  const fate = useFateClient();
  const [, startTransition] = useTransition();
  const [result, completeTask, pending] = useActionState(
    fate.actions.task.complete,
    null,
  );

  return (
    <button
      disabled={task.status === "complete" || pending}
      onClick={() =>
        startTransition(() =>
          completeTask({
            input: { taskId: task.id, version: task.version },
            optimistic: { status: "complete" },
          }),
        )
      }
    >
      {result?.error ? result.error.message : task.title}
    </button>
  );
}
```

```tsx
// app/components/project-board.tsx -- app-authored view composition
"use client";

import { view, useRequest, useView, type ViewRef } from "react-fate";
import type { Project } from "@/generated/fate/types";
import { TaskRow, TaskRowView } from "./task-row";

export const ProjectBoardView = view<Project>()({
  id: true,
  name: true,
  status: true,
  tasks: TaskRowView,
});

export function ProjectScreen({ projectId }: { projectId: string }) {
  // `project` is a compiler-generated root, but this is ordinary Fate usage.
  const { project } = useRequest({
    project: { byId: { id: projectId, view: ProjectBoardView } },
  });

  return <ProjectBoard project={project} />;
}

function ProjectBoard({
  project: projectRef,
}: {
  project: ViewRef<"Project">;
}) {
  const project = useView(ProjectBoardView, projectRef);

  return (
    <main>
      <h1>{project.name}</h1>
      {project.tasks.map((task) => (
        <TaskRow key={task.id} task={task} />
      ))}
    </main>
  );
}
```

The example's `TaskRowView` and `ProjectBoardView` are app source, not generated
files. In contrast, `Task`, the `project` root, `fate.actions.task.complete`,
and their transport wiring are compiler outputs. The screen never invokes a
DAL function or Server Action directly. RSC creates the request-scoped Fate
client and preloads the root through the DAL. The browser hydrates that scoped
snapshot before views render, then uses the generated transport for later reads
and mutations. Its cache scope binds the generated contract and active artifact
plus the current app, tenant, actor, and authorization scope. Snapshot, entity,
selection, and cache state cannot cross those boundaries. Automatic route
generation and declarative intent routing remain the separately deferred
explorations below; they are not required to prove this Fate integration.

### View-layer ADR gate

Build both candidates against the same representative compiled schema and the
same Next.js screens before the first real product application. Exercise those
screens through the six runtime candidates defined by the canonical plan; the
app-authored React components, Fate component views, roots, and public DTO
imports must be identical in every run. Only the generated private adapter and
protocol-binding implementation may vary. The Fate candidate must prove:

- production Next.js compilation without Fate's Vite plugin;
- type-level rejection and runtime rejection of forbidden fields, relations,
  query roots, filters, and arguments;
- request-scoped server rendering, dehydration, and client hydration without
  duplicate reads or cross-app, cross-tenant, cross-user, cross-authorization,
  or cross-artifact cache reuse;
- deterministic generation of the Fate types, data-view masks, roots,
  mutation map, and transport from the same normalized contract as SQL;
- ordinary component-local Fate `view`, `useView`, `useRequest`, and React
  Action usage without generating component views or exposing compiler/DAL
  implementation details to component code;
- exact correspondence between generated Fate roots/mutations and CUE named
  capabilities, with no direct ORM, raw SQL, native Fate HTTP handler, or
  Vite-plugin authority path;
- equivalent custom REST/direct and server-side GraphQL-backed transport
  behavior, with no private gateway URL, credential, GraphQL document, REST
  path, or adapter-specific error exposed to component code;
- bounded read-action batching without per-field or per-entity action
  waterfalls;
- tenant isolation, safe errors, cancellation, timeouts, and malformed-batch
  rejection;
- successful mutation reconciliation and deterministic optimistic rollback;
  and
- a documented cutover to the DAL baseline that does not change CUE, SQL,
  PostgreSQL functions, the runtime adapter, or database bindings.

For both candidates, record measured latency, action and database-query counts,
client bundle cost, cache behavior, generated artifact surface, diagnostics,
implementation complexity, and maintenance cost. Attribute adapter-specific
latency, protocol code generation, schema reload, and connection behavior to
the runtime ADR rather than using them to choose the view layer. For Fate, also
record the exact tested version and license, the named alpha-risk owner,
upgrade policy, API stability findings, and fallback procedure.

Fate is production-eligible but is neither preferred nor selected. Conflicting
maturity guidance does not waive any gate. The ADR reports evidence for the
exact tested version and requires explicit architecture-owner acceptance. A
selection produces one generated production view layer; the generator does not
maintain both as permanent runtime options.

## Future exploration: declarative screen orchestration

This is a recorded future exploration, not a current milestone, ADR, first-app
acceptance criterion, or commitment to extend CUE beyond its data-backend
authority. Consider it only after the first real generated-app proof and only
if repeated generated screens show material read and error-handling boilerplate.

A future presentation contract could explicitly bind a route or other trusted
screen input to an already-declared named read, select a generated screen, and
use the generated safe error policy. For example, it could declare that
`/projects/[id]` binds its `id` route parameter to `projectBoard.projectId`.
The generator could then create the Next.js page, loading state, not-found
handling, and safe error boundary rather than requiring an app author to
manually invoke, unwrap, and classify the DAL result.

The input source and binding must remain explicit; the compiler must not infer
that an arbitrary route parameter maps to an operation field. The exploration
does not choose whether such a presentation contract belongs in AppSpec, a
separate app-owned presentation manifest, or a constrained CUE extension.

Any proposal must preserve these boundaries:

- CUE named operations remain the backend authority; screen declarations may
  bind to and narrow them but cannot define tables, policies, queries, or
  trusted context.
- The generated route derives app, tenant, actor, authorization, provenance,
  and artifact context server-side exactly as the DAL and actions do today.
- Error classification remains generated and safe: unauthenticated, forbidden,
  not-found, validation, conflict, and unavailable outcomes cannot become
  caller-controlled presentation or data-disclosure behavior.
- Fate, if selected later, may consume the same explicit screen binding for
  preload and component views; it does not make that binding a generic browser
  query API.

This exploration requires its own proposal and evidence before implementation.
It must demonstrate less generated-page boilerplate without obscuring route
inputs, access behavior, error semantics, Next.js ownership, or the DAL
boundary.

## Future exploration: declarative intent routing

This is another recorded future exploration, not a current milestone, ADR,
first-app acceptance criterion, or state-management selection. It may be
considered only after the first real generated-app proof and a separate
proposal. It does not replace generated Server Actions, the DAL, PostgreSQL
enforcement, or the operation contract.

A generated app could render a `CommandForm` or equivalent interactive element
with a compiler-generated `data-autograph-command` identifier. A single
generated client `IntentRouter` could capture native submit and selected click
events, collect caller-controlled `FormData` or explicitly declared safe data
attributes, validate them through the generated command parser, and dispatch
the matching generated action from a closed registry. This would remove direct
function calls from individual element event handlers without creating a
generic browser mutation API.

Native forms are the default candidate because they retain semantic controls,
keyboard behavior, and a path to progressive enhancement. Click routing is a
candidate only for compact commands that do not have form input. A raw DOM
attribute is always caller-controlled: it may carry declared IDs, versions, or
form fields, but never app, tenant, actor, roles, capabilities, provenance,
artifact identity, database identity, implementation names, or authorization.

Any proposal must preserve these boundaries:

- command identifiers, trigger kinds, input bindings, parsers, action targets,
  safe error handling, feedback keys, and cache invalidation come from the
  generated contract; callers cannot name arbitrary commands or payload shapes;
- pending, success, error, retry, cancellation, and optimistic state remain
  scoped to a command and subject rather than a single global action queue;
- Redux, signals, or another client-state library are optional implementation
  choices for local feedback state, not the command transport or authority;
  and
- Fate, if selected, may reconcile its cache from a generated command result
  but does not own mutation authorization or command execution.

The evaluation must compare generated React form Actions with the intent-router
candidate, including accessibility, no-JavaScript behavior, event semantics,
concurrent commands, safe error delivery, optimistic rollback, generated code
size, and developer-facing simplicity. It must not introduce arbitrary
client-selected server functions, a generic route handler, or a permanent
global event bus.

## Cross-channel vocabulary

The generated contract uses one machine vocabulary across every channel. App
Builder may generate channel-specific presentation labels, but those labels
always map back to the canonical operation identity.

| Term | Meaning |
| --- | --- |
| App | Generated application boundary |
| Tenant | Isolation and billing boundary |
| Actor | Authenticated human or service principal |
| Role | Server-derived authorization grouping |
| Capability | CUE-declared allowed data or behavior scope |
| Named query | Authorized read with fixed roots, fields, relations, filters, ordering, and limits |
| Named command | Authorized atomic mutation or domain action |
| Lifecycle operation | Generated state transition such as approve, revert, or archive |
| Resource | Stable logical entity exposed by a capability |
| Projection | Channel-specific representation of a capability |
| DTO | Serializable operation result |
| Input | Validated caller-supplied arguments |
| Context | Trusted server-derived app, tenant, actor, role, provenance, and artifact identity |
| Artifact | Versioned compiler output and activation identity |
| Receipt | Durable execution, migration, activation, or publication record |
| Error | Safe discriminated failure with stable code and retry/field metadata |
| Event | Optional fact or notification, never an authorization source |
| Channel | REST, GraphQL, Server Action, SDK, CLI, MCP, or chat integration |

Queries, commands, and lifecycle operations remain distinct; capabilities are
not roles; resources are not database tables; projections are not authorities;
events are not commands; artifact identity is not caller input; and a channel
adapter is not the database runtime adapter.

REST uses paths and HTTP verbs, GraphQL uses fields and persisted operations,
SDKs use typed methods, CLIs use stable verbs/flags and safe output, and MCP
uses bounded tools and confirmations. Slack and other chat channels use the
MCP-only bridge and conversational labels; they cannot define new operations or
access the database directly. Platform MCP remains a separate control-plane
contract.

The compiler operation manifest contains canonical operation IDs, operation
kind, resource/capability identity, typed inputs and DTOs, field/relation
allowlists, limits, context requirements, idempotency/concurrency rules, stable
errors, artifact compatibility, and channel projections. Renames require aliases,
deprecation metadata, compatibility windows, and receipts.

## Generated operation surface

Model CRUD maps to the compiled lifecycle rather than direct table mutation:

- create and update use the generated apply contract;
- update carries the required version or concurrency token;
- delete uses the compiled versioned deletion/tombstone behavior; and
- draft, approve, discard, revert, history, and activity methods are emitted
  only when enabled by the schema contract.

Named queries use compiler-supported projections, relationships, filters,
ordering, and bounded pagination. A Fate view, if selected, can narrow and
compose the declared result capability but cannot expand it. Named commands
compile to one atomic database operation using the runtime's closed mutation
vocabulary. App Builder must reject arbitrary SQL, arbitrary executable code,
network access, and provider credentials in CUE.

## Serving and access surfaces

The generated application is served from the public typed PostgreSQL `api`
schema through selected private adapters; no protocol branch is an authority:

```text
CUE -> normalized named operations -> private kernel + public PostgreSQL api
                                      |          |          |
                                   REST      GraphQL   Next Server Actions
                                      |          |          |
                                  SDK/CLI   SDK/CLI/Fate   RSC/browser
                                      \          |          /
                                  generated app MCP
                              (agents, ChatGPT, tools)
```

The compiler emits one operation manifest (roots, arguments, DTOs, relations,
field capabilities, limits, auth references, errors, artifact and version)
from which it generates OpenAPI/REST, GraphQL persisted operations, DAL and
Server Action bindings, SDKs, CLI commands, MCP tools, documentation, and
compatibility metadata. These are projections, never independently editable
contracts. PostgreSQL credentials, private tables, SQL, and unrestricted query
controls are never distributed.

| Actor                | Surface                                  | Boundary                                                             |
| -------------------- | ---------------------------------------- | -------------------------------------------------------------------- |
| Generated-app user   | RSC reads, Server Actions, optional Fate | Next derives app, tenant, actor, role, provenance, artifact          |
| External application | Versioned REST or GraphQL                | Authenticated gateway; named roots and masks remain compiler-derived |
| SDK or CLI consumer  | Generated language clients and commands  | Ergonomics only; no extra fields or operations                       |
| Agent or ChatGPT     | Generated app MCP                        | Authenticated tools mapped to named operations                       |
| App Builder/operator | Platform APIs and platform MCP           | Separate control plane, never generated-app data plane               |
| Migration/deployment | Private PostgreSQL and migration engine  | Private roles, ledger, DDL, activation                               |

External HTTP defaults to authenticated server-to-server use. Browser exposure
requires an explicit fifth access-surface ADR covering CORS, browser tokens,
abuse controls, limits, and tenant isolation. Candidate generators are
[OpenAPI Generator](https://openapi-generator.tech/),
[Stainless](https://www.stainless.com/docs/openapi/),
[Speakeasy](https://www.speakeasy.com/docs/sdks/introduction),
[liblab](https://liblab.com/), and [Smithy](https://smithy.io/2.0/spec/index.html),
with [GraphQL Code Generator](https://the-guild.dev/graphql/codegen/plugins/presets/preset-client)
for GraphQL clients. Seamless is deferred until its product identity is clear.

### Access-surface ADR gate

The fifth ADR compares private versus external REST/GraphQL, auth and tenant
context, field/operation allowlists, limits, parity with DAL and Actions,
SDK/CLI/MCP generation, deterministic release artifacts, compatibility and
deprecation, licensing, diagnostics, and fallback. It records exact versions
and whether each tool requires hosted login. Only one strategy and generator
path may ship; all others remain disposable spikes.

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

1. all five ADRs have been accepted and the generated application contains
   only the selected runtime adapter, database binding, migration-engine
   integration, and view layer;
2. App Builder produces and validates the app-owned CUE source from the
   accepted AppSpec;
3. the repository is created with no handwritten data-backend implementation;
4. the private PostgreSQL kernel, public PostgreSQL API schema, adapter
   metadata, and generated TypeScript are deterministic and current, and
   adapter introspection exposes no private tables, kernel functions, installer
   functions, or administrative operations;
5. the selected view layer reads through the generated DAL, including
   request-scoped preload and bounded read-action behavior when Fate is
   selected;
6. a Client Component mutates through a generated Server Action;
7. invalid input, forbidden field selections, malformed view requests,
   unauthorized access, and cross-tenant access fail closed;
8. a successful mutation refreshes the affected rendered data and reconciles
   the selected cache behavior;
9. the accepted view-layer fallback is executable without changing the
   database contract; and
10. one CUE schema evolution runs through the selected migration engine,
    preserves representative persisted data, produces the canonical lifecycle
    receipt, activates atomically, and remains compatible with the regenerated
    application.

All local proof uses `mise run dev` and the repository's supported generated-
app validation entrypoints. Provider-backed Preview or Production proof is a
later, separately authorized step.

## Rollout

1. Land the canonical runtime plan and this integration plan with working
   cross-links.
2. Add the adapter-neutral normalized operation and artifact handoff without
   generating a product app.
3. Complete the six-candidate runtime comparison, independent binding and
   five-candidate migration-tooling comparisons, Next.js view-layer spike, and
   access-surface/SDK/CLI/MCP spike; record and accept all five ADR decisions. These
   evidence lanes may run in parallel once the normalized operation contract,
   desired PostgreSQL catalog, and typed migration intent are stable.
4. Add `cue-postgres` to the AppSpec, planning, validation, and app-creation
   contracts while preserving `none` and legacy-read compatibility for
   `kernel`.
5. Generate the selected DAL, action, and view-integration templates and prove
   them against compiler fixtures.
6. Run the first real generated-app acceptance flow.
7. Make `cue-postgres` the normal data-backed choice only after that proof is
   green and the generated repository remains reproducible from CUE.

## Non-goals

- migrating existing Arrusted applications;
- exposing PostgreSQL, PostgREST, `pg_graphql`, either Hasura architecture, or
  PostGraphile directly to browsers;
- exposing physical tables, kernel functions, installer functions, or
  administrative operations through the public PostgreSQL API schema;
- allowing a gateway, protocol schema, or generated protocol binding to become
  an independently edited model, relationship, authorization, or operation
  authority;
- selecting a migration engine in AppSpec, exposing engine administration or
  ledger objects to a runtime adapter, or accepting handwritten migration
  input alongside the compiler contract;
- treating a Fate component view as a PostgreSQL API view or backend authority;
- introducing a `/fate` Route Handler or unbounded client query language;
- selecting the runtime adapter, database-binding source, or migration engine
  in this document, or selecting Fate without the required view-layer ADR;
- encoding provider protocols, secrets, or arbitrary orchestration in CUE;
- running installation or activation inside a request or Server Action; or
- claiming that every application behavior is declarative in the first data-
  backend milestone.
