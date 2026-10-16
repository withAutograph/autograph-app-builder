# Separate protected operator host

The native entrypoint wires the trusted `createDependencies` factory from
`hosted-operator-composition.ts`. Missing or invalid deployment-owned
configuration returns HTTP 503 for `/v1/runtime`. Native deployment READY,
module import and focused source checks do not prove operator readiness,
installed resources or app behavior; see the
[current composition contract](hosted-operator-native-composition.md).

Use a physically separate Vercel project linked to the normal Builder Git
repository, with root `lib/provisioning/operator-host` and outside-root repository
source enabled. Its native config declares only the operator service rooted
at `.` within that project root, using the `hono` preset and `entrypoint.ts`.
Neither Builder web/Eve nor generated app processes are declared in this project.
The only ingress rewrite is exact `/v1/runtime`;
this is a reachable protected HTTP service, not an unrouteable private-only service.

The function uses Vercel's Web-standard `fetch(Request): Promise<Response>` export.
It wraps the existing protected operator handler and does not implement planning,
approvals, ownership, leases, effects, readback or resource orchestration again.
Unknown paths/methods return 404 before initialization. Missing, failed or incomplete
composition returns 503 with no readiness response, private error text or receipt.
Successful initialization shares the dependency instance; failed initialization
can retry. Construction/import itself performs no provider effect.

## Trusted source composition

`lib/provisioning/hosted-operator-function.ts` statically wires the existing
factory into the native handler:

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
   private operator project; app/Gateway projects must not receive it. Save these
   project settings:

   ```json
   {
     "rootDirectory": "lib/provisioning/operator-host",
     "sourceFilesOutsideRootDirectory": true
   }
   ```

   Outside-root source access lets the operator import the shared Builder
   composition without changing its service root.

2. Configure deployment protection and Trusted Sources for the exact approved
   Builder caller team/project/environment. The client sends its verified workload
   bearer for operator authorization and the provider Trusted Sources header for
   ingress; neither substitutes for the other. This operator ingress rule is
   separate from the Gateway rules below.
3. Deploy the selected immutable Git commit as a Git-source deployment using
   `lib/provisioning/operator-host/vercel.json`. Deployment requests must retain
   the operator project root and select this nested configuration. Its service
   root `.` is relative to `lib/provisioning/operator-host`; the service uses
   the `hono` preset and `entrypoint.ts`.

   Operator-managed app and Gateway delivery calls Vercel's REST deployment API
   with the approved repository, ref and immutable commit. Git supplies the build
   source; this is not an automatic deployment triggered by pushing a branch.
   The operator starts these deliveries after their approved runtime bindings
   are ready and records the resulting deployment candidates in its journal.

   The repository-root `vercel.json` builds the Builder, including Eve and
   Next.js. A saved `rootDirectory: null`, or a deployment request that selects
   the repository root instead of the operator configuration, can run that
   Builder build in the operator project. Keep the saved operator settings and
   deployment configuration aligned when refreshing this project.

   For a standard Preview deployment, omit `target` from the deployment request;
   do not send the literal `preview`. The API's `staging` target is distinct and
   assigns a staging alias. Do not assume it is equivalent to an omitted target
   for Trusted Sources, even when OIDC reports the Preview environment.

   A redeploy using `deploymentId` inherits the original deployment's project
   settings and environment variables unless explicitly overridden. Keep the
   intended operator configuration and current rotated automatic binding through
   the provider's supported deployment settings. `withLatestCommit: true` only
   removes the previous Git SHA selection so the latest commit is used; it does
   not refresh inherited settings or environment variables. These request semantics
   are defined in the [official Vercel SDK deployment request schema](https://github.com/vercel/sdk/blob/main/docs/models/createdeploymentrequestbody.md).

   Observe the exact immutable operator deployment URL and source/target identity.

4. Exercise unauthorized/mismatched callers and actual owner-approved Preview
   operations, independent provider/database readback, recovery and isolation.

These are reviewed external effects and qualification requirements. Importing the
native entrypoint creates no projects, deployments, secrets or provider resources.

## Shared Gateway host setup owns Trusted Sources

Deployment Protection for the shared Gateway is configured during approved host
setup. New generated-app plans consume that host and do not include
`gatewayBindings.trustedSources` or authorize provider protection-setting writes.
The host setup names the exact source and target project IDs and installs these
two fixed rules on the shared Gateway project:

- Builder project **Production → Gateway Preview**, for protected JWKS and identity readback.
- Operator project **Preview → Gateway Preview**, for protected identity readback.

The coordinator independently reads the provider's actual Gateway protection
policy after the approved setup and retains the exact project/environment pairs.
Preserve unrelated project and external rules, self access, environment pairs and
CI settings. Successful runtime access proves reachability for that caller; it
is not proof that these exact policy rules are installed. A deployment marked
READY is not that policy readback either.

App plans still carry native caller verification, app/Auth environment bindings
and Gateway delivery effects. The optional `trustedSources` contract and binder
remain for already frozen plans: their existing approvals and reconciliation
semantics are unchanged. Removing the field from new plans does not rewrite a
pending old operation, authorize a retry of an unknown provider write, or resolve
its recovery boundary. Use the existing approved recovery path for that operation.

`readonlyAttesters` configures application verification of native callers. Trusted
Sources separately admits those callers through Vercel Deployment Protection.
Observe protected `/_platform/jwks.json` and
`/api/auth/platform/operator-identity/readback` with the intended native OIDC
callers during the normal account connection, and retain provider readback as
evidence. The fixed native readback POST sets its Origin from the exact owned
journal endpoint after native workload verification and cookie rejection. It never
copies an incoming Origin or synthesizes browser Fetch Metadata; JWKS GET headers
are unchanged. A saved connection can therefore retain its original immutable
Gateway endpoint through a source refresh. The browser entrypoint is a separate
provider-owned address: when it moves, renewal verifies its current deployment
still belongs to the approved owner/project, native Preview environment and
branch and is READY. That read does not replace the saved immutable transport or
require the previous deployment to retain the browser alias.

Host setup is shared infrastructure work, not a new per-app approval or
qualification step. Source checks, provider policy readback, runtime access or
a repair to the current native session do not establish automatic hosted recovery or
[out-of-the-box self-reproduction](evals/self-reproduction.md).

## Preparation before normal Auth identity

A source-owned `auth-bootstrap` plan has two resource effects and exactly one
Auth schema effect. It carries no actor grants and cannot complete app bindings
or app readiness. Completion requires the fixed restricted Auth runtime query
`_auth_schema_readiness.read_current()`, exact database/login/runtime role,
approved target and SQL asset identities, and equality of the native catalog
fingerprint with its own publication. This catalog algorithm is distinct from
the TypeScript desired-target digest. Its public status is
`auth-schema-prepared`, with authenticated behavior unassessed.

Known completion without an unresolved pending attempt permits a same-resource
full plan, preserving matching completed resource/Auth effects. The new full
plan requires its own durable approval. Unknown effects retain their recovery
boundary. Normal Gateway signup/sign-in, verified realm actor/organization
mapping, and actual membership are required inputs; Builder user IDs are not
copied into a new Auth realm. Creating an operator-owned organization/member
requires the separately configured and approved fixed membership effect for an
existing normally authenticated user. No user seeding, recovery impersonation or app
business implementation is part of schema preparation.

Planning reads private canonical accepted AppSpec state and its exact finalized
artifact selection under current owner authority. Native Neon planning uses a
separate metadata-only guard and the fixed project/branch/endpoint/database/role
read tools. It neither manufactures an approved SQL effect nor calls the
connection-string tool. Actual approved maintenance credentials remain confined
to the leased private resource effect.
