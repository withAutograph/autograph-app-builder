# Optional provider integrations

Use this only when the product brief or accepted existing-app revision requests
provider data or an integrations management experience. Ordinary apps retain
their standard dependencies, routes and navigation.

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

Bind the platform's configured provider adapters and shared installation
lifecycle through `createAppIntegrationHost` from
`@autograph/integration-runtime/app-host`; do not reimplement that lifecycle
in each app. Its small app-owned server module is named by `hostModule` and
exports `integrationHost.ingress(provider, rawBody, request)`, `loadSurface()`
and `onAction(request)`. Missing platform adapters stay explicitly unavailable.

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
It invokes the one repository-owned installer, `mise run integrations:install
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
