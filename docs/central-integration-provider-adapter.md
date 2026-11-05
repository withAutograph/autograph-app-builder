# Central integration provider boundary

`createCentralIntegrationVercelProvider` supplies narrow operations for the
separate approved central setup/caller plans. Its enclosing native composition
must supply current owner/approval checks, installation credentials, encrypted
private custody and the physical project lease. Source publication and native
deployment event selection remain separate authorities; this adapter creates no
deployment, alias, domain, bypass secret or environment selector.

The implementation follows the official [project update API](https://vercel.com/docs/rest-api/projects/update-an-existing-project)
and [public OpenAPI schema](https://openapi.vercel.sh/), inspected on 2026-11-03.
A trusted project rule has explicit `from.slugs` and `to.slugs`. The inspector
or app caller may reach only the reviewed central Preview environment. The
adapter independently reads the source project owner and the target Services
project/root/Git link/OIDC configuration. It preserves all observed sibling
project rules, external OIDC providers and the existing same-repository CI flag.
It never edits Deployment Protection or enables its bypass features.

A grant plan freezes the canonical hash of the complete Trusted Sources object.
The adapter records both before/merged-after hashes durably before one PATCH,
then immediately rereads the previous state, patches and verifies the complete
result. A resumed pending operation can settle only from its exact retained
after hash. The successful caller grant has its own stable hash of the exact
project/environment rule, so adding a sibling app does not invalidate it.
Missing or changed pending state remains unknown and cannot trigger retry.
An existing caller with omitted rules has implicit same-environment/custom
semantics; changing that entry requires an explicit reviewed migration rather
than replacing those defaults with a narrower guessed rule.

The API exposes no documented conditional-write or per-rule compare-and-swap
contract. The project lease serializes Builder operations, while immediate
readback detects observable outside drift. A concurrent external dashboard
writer between the final read and PATCH cannot be made atomic by this adapter.
It must not be described as provider-enforced compare-and-swap. No invented
If-Match support or automatic restoration/retry is used.

The official [webhook creation schema](https://github.com/vercel/sdk/blob/main/src/models/createwebhookop.ts)
returns a provider-generated signing secret. The
[list schema](https://github.com/vercel/sdk/blob/main/src/models/getwebhooksop.ts)
does not return that secret. Creation therefore requires an atomic private
checkpoint of the accepted ID plus encrypted secret before acknowledging the
effect. Public receipts retain only ID and secret hash. Readback verifies that
accepted ID's exact receiver URL, project and two deployment events. A lost
response or missing secret checkpoint stays unknown; a matching URL never
permits adoption, recreation or deletion.

Runtime binding creates encrypted rows scoped to Preview and the exact frozen
operation branch. Each key is claimed before its singular provider write and
its accepted ID is persisted before independent private value readback. Global
and other-branch rows are preserved. Selected-branch foreign or unreviewed rows
fail visibly; unknown per-key writes cannot be repeated. This readback proves
provider configuration, not that a deployment has loaded it. The enclosing
central readiness flow must separately verify actual loaded runtime, database,
caller authorization and accepted native deployment evidence. The global setup
must also review inherited project-level environment inventory; branch-scoped
write isolation does not imply per-Service secret isolation.
