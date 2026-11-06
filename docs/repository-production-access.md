# Builder-owned access for an existing Production repository

Normal delivery into an existing repository uses the protected
`/v1/repository-production` endpoint. It does not need a prepared synthetic
runtime or an isolated Preview enrollment. The older Preview operations keep
their existing contracts.

The deployment owns `REPOSITORY_PRODUCTION_CONFIGURATION`. It identifies the
Builder and operator Production workloads, fixed installer workers, managed
Neon connection, protected Vercel credential binding, and authorized mappings
from a Builder workspace and repository to an organization, native app project,
public origin, and shared Auth resource. A mapping covers every app in that
repository; creators do not provide database IDs or connection strings.

The operator independently reads the canonical Builder owner and saved
repository choice, including recovered session lineage. App descriptions and
compiled releases come from owner-scoped captured artifacts. The normal plan
operation returns the app's resource and access intent; preparation reads the
actual approval from Builder's private history. A caller-supplied approval ID
alone is insufficient. Source hashes remain diagnostics; the reviewed resource,
schema, organization and role effects determine approval identity.

For a persistent app, setup records its owned database, roles, and encrypted
credentials in the existing provisioning journal before any provider write.
It allocates the database, installs the checked schema, prepares creator
membership and app roles, and binds only that app's encrypted Production
runtime variable. Frontend-only apps use shared Auth and skip app storage. The current captured
description has no explicit anonymous-access contract, so this path defaults
to private access; it does not infer public access from a static backend.
The native deployment provider continues to own deployment and activation.
There is no external product-test or synthetic-data release requirement here.

The creator receives a Builder-managed, one-time invitation through the saved
Builder account. Email is a delivery address, never account-linking authority.
The protected Auth service supplies the actual verified actor and session.
After sign-in, its workload-authenticated completion callback resumes the
original Builder setup. It grants organization membership only at member
level, plus the app's reviewed roles. Creator access and subsequent invitations
use the same protected Auth and generated-data workers.

Setup, access changes, and callbacks share one physical lock per repository and
app. Worker effects carry a positive durable fencing generation and are
checkpointed before dispatch. Interrupted writes are read back before retry;
uncertain results remain pending. Revisions retain the database and credentials.
After the initial creator grant finishes, setup never regrants it automatically:
People-page revocations and role changes remain authoritative. When a new
reviewed schema changes creator roles, an existing active creator is updated
through the normal access-management journal under the same app lock. Removed
creators stay removed. Interrupted role updates retain their active preimage
and command identity; conflicting new People commands wait for reconciliation.

The runtime binding cannot adopt or overwrite an unrelated existing variable.
An earlier delivery path's existing database must be reconciled to its original
ownership before enabling this path for that app. A response lost after binding
creation can be recovered from the owned provider record and expected value.

The People page and public delivery tools use the same endpoint. Ordinary
invitation completion accepts only an invitation ID from the authorized Auth
workload, reads the stored inviter and verified invitee, and rechecks current
ownership. Neither an email match nor the invitee's possession of a Creator
Builder session is required or sufficient.
