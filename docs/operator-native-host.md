# Separate protected operator host

This is an opt-in native deployment source, not an operational operator. The
actual entrypoint currently returns HTTP 503 for `/v1/runtime`: concrete dependency
composition has not been wired. Native deployment READY, module import and focused
source checks do not prove operator readiness, installed resources or app behavior.

Use a physically separate Vercel project linked to the normal Builder Git
repository, with root `lib/provisioning/operator-host` and outside-root repository
source enabled. Its native config declares only the Node operator service rooted
at the repository source. The empty service build command prevents the existing
combined Eve/Next root build. Neither Builder web/Eve nor generated app processes
are declared in this project. The only ingress rewrite is exact `/v1/runtime`;
this is a reachable protected HTTP service, not an unrouteable private-only service.

The function uses Vercel's Web-standard `fetch(Request): Promise<Response>` export.
It wraps the existing protected operator handler and does not implement planning,
approvals, ownership, leases, effects, readback or resource orchestration again.
Unknown paths/methods return404 before initialization. Missing, failed or incomplete
composition returns503 with no readiness response, private error text or receipt.
Successful initialization shares the dependency instance; failed initialization
can retry. Construction/import itself performs no provider effect.

## Required source integration

The coordinator must implement and review
`lib/provisioning/hosted-operator-composition.ts` with the exact export:

```ts
createDependencies(): Promise<ProtectedHostedOperatorDependencies>
```

Then statically wire that function into the actual entrypoint:

```ts
import { createDependencies } from "./hosted-operator-composition";
export default {
  fetch: createHostedOperatorNativeHandler({ createDependencies }),
};
```

No request, model-selected module path, environment switch, global registry or
permissive fallback selects those dependencies. The different Builder provisioning
factory in `deployment.ts` is not this operator's composition. Its concrete loader
must own private credentials and clean up partial initialization failures. The
existing handler still requires fresh workload/owner authorization and durable
approval of exact frozen plans before any effect.

## Reviewed provider setup

1. Observe and approve the distinct operator, Gateway/Auth and app project IDs,
   owners, roots and environments. Configure only operator authority in this
   private operator project; app/Gateway projects must not receive it.
2. Configure deployment protection and Trusted Sources for the exact approved
   Builder caller team/project/environment. The client sends its verified workload
   bearer for operator authorization and the provider Trusted Sources header for
   ingress; neither substitutes for the other.
3. Deploy through normal Git delivery after concrete factory integration. Observe
   the exact immutable operator deployment URL and source/target identity.
4. Exercise unauthorized/mismatched callers and actual owner-approved Preview
   operations, independent provider/database readback, recovery and isolation.

These are reviewed external effects and qualification requirements. This source
slice creates no projects, deployments, secrets, provider resources or credentials.
