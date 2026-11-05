# Optional provider integrations

Use this only when the product brief or accepted existing-app revision requests
provider data or an integrations management experience. Ordinary apps retain
their standard dependencies, routes and navigation.

The integration runtime setup/activation implementation is deferred in this
delivery cut. Report it as **unavailable**, not `not_configured`: the latter is
reserved for a supported implementation that has actually verified no authorized
binding. Do not call missing setup tools, fabricate a connection state, or build
a replacement provider backend. The retained source contracts below do not
establish a deployed integration service. Normal app/Auth/resource delivery may
continue when the accepted intent explicitly defers this optional capability.

The supported server boundary is `readIntegrationAvailability` from
`@autograph/integration-runtime/availability`, when that export is present in the
selected platform. It authorizes before and after its actual implementation's
binding read. A deferred implementation stays unavailable and performs no binding
read. Only a successful authorized `null` result is `not_configured`; malformed or
failed reads are unavailable. A configured binding is metadata, not activation,
health or permission to ingest. Do not supply a fake implementation, empty account
array or synthetic binding to obtain a desired status. Keep normal app route and
action authorization in force independently of this optional availability UI.

## Explicit deferral and independent app delivery

When the user defers optional integrations, first revise and accept the ordinary
AppSpec intent. Keep the same app, repository, destination, data model and Auth
realm. Apply a fresh reviewed existing-app source change that removes the active
executable selection (`app/integrations/definition.ts` absent, or `providers: []`)
and reconciles app-owned imports/navigation. Then use `install-app-integrations`
in the approved checkout even though no provider remains selected. It uses the
same repository installer to remove only unchanged installer-owned outputs and
returns `status: "omitted"`; continue normal validation, review, publication and
public release. Do not wait for a central Integrations host, provider connection,
activation or ingestion for that integration-independent app journey.

A disconnected/unavailable placeholder may remain only as ordinary app-owned UI
with no executable integration host, machine ingress, Connect action or installed
capability claim. Do not render the configured shared Integrations surface without
its runtime. Preserve existing provider bindings, data, receipts and uncertain
operations. Source reconciliation is not provider disable/drain, retirement or
cleanup. An installer conflict is a concrete source repair requiring ordinary
approval; never force-delete app-owned files or rewrite installation history.

The public release still independently reads the actual described capability and
retained custody. If installed integration metadata remains, satisfy its existing
capability guards or reconcile the source through the accepted revision. Never
ignore the metadata, fabricate readiness, add a bypass environment flag, or reuse
an old approval for the changed release. No AppSpec schema extension or second
persisted capability authority is needed to defer the optional feature.

## Active integration authoring

Read the selected Arrusted checkout's current integration contract, public
`@autograph/integration-runtime` recipe exports, `app-definition` export, and
`@modules/integrations` surface types through `inspect_repository`. Discover
QuickBooks, Xero and Ramp support from executable recipes and host bindings;
a catalog label or prototype card does not establish provider readiness.
Describe an unsupported object, unavailable provider adapter, or missing central
connection/activation capability precisely. Do not generate TODO handlers,
fabricate successful actions, request pasted credentials, or add an alternative
backend to hide that gap.

Keep provider choices, source-of-truth rules, refresh, reconciliation, approval
and app scope in the AppSpec's existing integration prose. Do not add an
`optionalCapabilities` handoff, connector metadata, schema extension or second
persisted-schema authority.

For both new and existing apps, author the app-owned executable
`app/integrations/definition.ts` using `defineAppIntegrations` from
`@autograph/integration-runtime/app-definition`. Import the app's checked
generated schema definition and bind supported provider recipe factories to its
actual writable model and field vocabulary. The helper validates those
bindings against generated metadata. Reuse the same source-reference identity,
matching and clearing policy for retries; never infer cross-source relationships
from a provider ID or bypass generated SQL with raw writes.

Executable integration definitions run in the repository installer too. Import
`definition` from the selected checked release's `data-operations.ts`, which
retains the generated literal model/field types. The normal `@/schema` server
entry adds Next's `server-only` marker and cannot be evaluated by the Bun
repository command. Follow the current `schema/index.ts` release selection and
update the app-owned integration import when compiling a new release. Do not
edit checked release artifacts, mock the marker, or copy schema metadata into
an app integration definition.

For the configured public development path, the executable definition also
includes `readObjects` for every selected provider and
`checkedRelease: { directory, sourceCue }` in `defineAppIntegrations`. Use the
actual supported typed provider read configuration: object name, destination,
schedule and selected field/value mappings as applicable. Use an app-scoped
destination name for its actual installed ingress and public origin. Two apps
may share a tenant connection but retain distinct destinations, delivery URLs and
signing keys. Never copy another app's static destination name or manually
retarget an existing destination; revise a mismatched source declaration through
the normal Builder flow. The provider signing key stays in encrypted central
authority, never generated app code or environment. Do not invent provider
object names, recipe IDs or mapping defaults from UI labels. The current
configured public adapter supports one QuickBooks selection; a generic recipe
export for another provider does not establish configured public delivery.

Resolve `directory` and `sourceCue` from the app's real checked release selection,
matching the generated definition import and the app DAL. The configured runtime
verifies the source CUE, release manifest and artifact hashes, recipe identity
and exact readObjects digest. Keep those source facts importable by the Bun
installer without runtime credentials or Next-only `server-only` imports. When
a normal schema revision selects a new checked release, update these references
together. Installer inventory alone is not runtime readiness.

Use the existing shared Next host in the app-owned server module named by
`hostModule`:

```ts
import "server-only";
import { createConfiguredAppIntegrationHost } from "@autograph/platform-microfrontends/app-integration-host";
import { integrationDefinition } from "./definition";

export const integrationHost = createConfiguredAppIntegrationHost({
  definition: integrationDefinition,
});
```

This host supplies the normal authenticated request/DAL, central control client,
connection setup, activation, app-specific disable/drain and shared read ingress.
Do not compose new provider clients, SQL pools, service actors, signing keys or
central adapters in the generated app. The lower-level `createAppIntegrationHost`
is a platform composition primitive; it is not the normal generated Next host.
Missing separately approved capability or central configuration stays an explicit
prerequisite. Installing this module does not grant provider access.

Connection setup also exposes protected `prepareConnection(providerId)` and
`completeConnection(providerId, setupId)` server callbacks. Use the shared
`AppIntegrationClient` wrapper emitted by the installer; it opens the authorized
provider URL, offers an explicit Check connection action, and refreshes the
current route after successful actions so embedded surfaces update too.
The provider URL and callback are selectors only. Completion independently
verifies the exact provider, fresh connection slot, app, organization and actor;
central registration verifies ownership again. Cancellation never registers
the connection.

For Ampersand, the platform binds `createAmpersandConnectionSetup` from
`@autograph/integration-runtime/ampersand-connection`. It uses the official
[server OAuth authorization URL API](https://docs.ampersand.ai/reference/oauth/generate-oauth-authorization-url),
keeps provider credentials server-side, and accepts only configured HTTPS
provider authorization origins. Approved provider-app metadata, protected
credential lookup and the platform's existing purpose-bound proof signer are
configuration inputs. No new setup database is required. Missing provider auth
configuration leaves Connect unavailable. The browser SDK's existing-account
controls require broader credential authority, so this flow uses the documented
server URL alternative and sends no broad SDK token to the browser.
The DAL authenticates the request, derives app/organization/actor authority,
loads current connections and bindings from the central control plane, verifies
provider signatures before parsing exact raw bytes, holds the central binding
lease through generated SQL apply, and reauthorizes every mutation. Recipes and
browser identifiers cannot grant any of that authority. Reuse platform-owned
connection, activation, disconnect and ingestion mechanics; thin generated
routes call this supported boundary.

After the accepted private build is applied, call `install-app-integrations`.
It invokes the one repository-owned installer, `mise //apps/integrations:install
<app>`, in the selected approved checkout. Do not invoke this operation through
generic shell access or invent an adapter command. An omitted result means no
opt-in was installed. A failed result is a concrete repair or capability gap;
it is never provider readiness. The same operation handles new and existing
apps and preserves conflicting app-owned files.

Compose the generated app-bound server
component `Integrations` into the accepted experience. It renders shared
`IntegrationsSurface` from `@modules/integrations` with safe providers, accounts,
health and activity data from the app DAL. Its action contract is
`onAction(request): Promise<void>`; actual failures reject. Compose the generated
`integrationsNavigation` entry or `IntegrationsNavigation` link into the app's
existing navigation when `includePage` is requested. The app-bound component is always available for embedding; page/navigation installation is optional. The installer preserves existing layouts. Use the existing
palette and section loading/error states, and preserve independently usable
catalog, accounts, health and activity sections.

Run the selected app's ordinary validation after installation and repair actual
errors. Include authenticated provider/binding isolation, revocation during
apply, replay, safe action errors and independent data readback in acceptance
when applicable. Report source installation, focused tests, live connection,
activation and hosted ingestion as separate evidence. Connecting accounts,
activating shared access, disconnecting accounts and other outward effects
retain their existing approvals.
For a public isolated development release, installing source never configures
provider access. Runtime capability provisioning and Connect/Activate remain
unavailable in this lifecycle cut; do not invoke the parked
`plan-app-integration-capability` / `prepare-app-integration-capability` tools or
try to satisfy their central-host prerequisites. Explain that unavailable scope
and use only the user's explicitly accepted deferral for independent app delivery.

Previously frozen v1/v2/v3 plans retain their original effects, signing modes and
approval meaning. Preserve their receipts and uncertain operations without
resending, fabricating settlement or transferring old consent. Restoring that
separate implementation later requires its own qualified source, current actual
authority, ordinary concrete approval and exercised acceptance. Neither source
installation nor a prepared record is live provider/hosted acceptance evidence.
