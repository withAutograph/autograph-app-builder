# Synthetic Neon enrollment for the protected operator

The REST and OAuth MCP readers preserve their existing restricted policy when
`nativeNeon.configuration.syntheticEnrollment` is absent: the selected branch
must be nondefault, with `parent-schema` or `schema-only` initialization. They
continue to check the current owner, native store, approved resource scope,
endpoint, database, role and SQL login. Metadata planning uses its separate
current-owner planning guard and never requests a URI or opens SQL.

A reviewed deployment configuration can enroll one exact synthetic-only Neon
project, its default root and explicitly listed descendants. Only that root may
be default. A `parent-data` child is allowed only when its recorded origin and
every ancestor match independent provider readback back to the enrolled root.
There is no project-wide allow-default switch, name-based trust, implicit child
enrollment or fallback to the legacy policy when enrollment is present.

This is source support for the [qualification plan](plans/2026-10-07-hosted-operator-deployment-and-spend-review-qualification.md).
It creates no project, branch, database, role, binding, approval or grant. It
changes neither the encrypted journal nor resource fencing, worker protocols,
shared Auth adoption or existing Production storage.

## Required operational evidence

The provider coordinator must obtain approval for the actual fresh-project
creation and source-derived baseline installation **before** enabling this
configuration. The reviewed operational plan must retain:

- Exact Neon organization/project and Vercel owner/native-store/operator
  identities; creation approval and independent creation readback.
- The reviewed source baseline and owning fixed workers that install its
  schema, release/activation metadata and permitted noncustomer reference
  vocabulary. No copy of Production business data, Auth users, sessions or
  credentials is authorized by enrollment.
- Exact root ID/creation time/initialization source, each enrolled child's
  creation time, parent ID and every returned fork LSN/timestamp, plus the
  selected endpoint, maintenance database and installer principal.
- The approved compute, region, cost, retention and resource consumer plan,
  together with who may write, import, restore, reset or change defaults. No
  existing project, root, Auth realm or control-plane database becomes a
  synthetic baseline by assigning a label or inserting configuration.

`creationApprovalReference` and `sourceBaselineReference` refer to that reviewed
private evidence. The reader checks their presence; it does not fetch or
validate the evidence contents. Deployment review supplies synthetic-only
authority. Provider metadata verifies identity and observed lineage, **not the
absence of customer data**. Neither a schema-only initialization source nor
`synthetic_storage_size`, a branch name, table counts or a successful SQL login
establishes that property. Ordinary writes/imports through SQL can be invisible
in this metadata. Control all writers and keep actual evidence under the
existing approval and operation ownership boundaries.

Do not enroll the current Production project/root or any existing app/Auth
resource as a shortcut. The previously proposed Production-project Spend
Review child remains outside this configuration and must not be created by
this source task.

## Provider readback

The readers use the existing metadata operations: REST GET project/branch/
endpoint/database/role and MCP `describe_project`, `get_branch`,
`get_postgres_endpoint`, `get_postgres_database`, `get_postgres_role`.
The [current Neon OpenAPI](https://neon.com/api_spec/release/v2.json)
defines `Project.id`, `owner_id`, `created_at`, and `Branch.id`, `project_id`,
`created_at`, `parent_id`, `parent_lsn`, `parent_timestamp`, `init_source`,
`default`, `current_state`, `pending_state`, `last_reset_at`, `restore_status`,
`restored_from` and `restored_as`.

Enrollment requires exact project identity, provider owner and creation time.
Every selected branch/ancestor must match its recorded identity, creation time
and initialization source, be `ready` with no pending transition except
`ready`, and have no reset/restore marker. Missing, malformed or failed
readback denies access. An enrolled root has no parent or fork position and
must be default. A newly created project's root may report `parent-data`
without a parent; that source string is accepted only with the reviewed fresh
project evidence and exact root metadata. `schema-only` is also permitted for
an independently observed root; a source parent recorded in its readback
fails this root contract. `import`, unknown initialization sources and unknown
roots are denied.

Children must be nondefault and match the exact enrolled parent and all
returned fork-position fields. Record both the LSN and timestamp when both
appear; their absence is part of the comparison. At least one fork position
must be returned. Every parent must itself be enrolled, ending at the exact
root; cycles and duplicate enrollment IDs fail. No branch-depth cap is added.
Restored/reset branches require a separate provenance/recovery design; this
adapter does not admit them by clearing a marker or fabricating enrollment.

The selected endpoint must remain the exact read-write endpoint attached to
the selected project/branch/hostname. The existing direct URI checks and
`current_user`/`current_database()` read-only identity query remain in force.
Owner/installation authority is rechecked around every provider call; token
refresh and revoked-grant handling retain the existing Connect behavior.

Each invocation clones and deeply freezes enrollment before asynchronous work.
Enrolled project/lineage and endpoint metadata are reread immediately before
privileged URI acquisition, after acquisition before SQL identity, and after
identity before releasing private material. Planning rereads them before
returning metadata. Observed default changes, resets/restores, endpoint moves,
imports or revocation deny continuation; credential/provider errors remain
opaque and are never logged in a public result.

These reads are not an atomic provider transaction. A concurrent external
writer can change resources after a final read, or write customer rows without
changing the checked metadata. The operational plan must preserve the existing
resource lease and current-owner effect checks and prohibit conflicting
provider/resource writers during the approved operation. This source change
provides no hosted proof of that control or of baseline contents.

## Configuration example

The following is the exact `nativeNeon` fragment of
`PROTECTED_HOSTED_OPERATOR_CONFIGURATION` for OAuth MCP. Replace all angle
bracket placeholders with independently observed values before parsing or
reviewed deployment; the example is not executable configuration. Keep the
other existing configuration sections. The optional field flows through the
existing imported `configurationSchema`, so no duplicate source-configuration
adapter is required.

```json
{
  "nativeNeon": {
    "configuration": {
      "connector": "<existing-owner-neon-oauth-connector>",
      "nativeStore": {
        "configurationId": "<native-store-integration-configuration-id>",
        "resourceId": "<native-store-resource-id>",
        "sourceProjectId": "<source-vercel-project-id>"
      },
      "operator": {
        "audience": "https://vercel.com/<operator-team-slug>",
        "environment": "preview",
        "issuer": "https://oidc.vercel.com/<operator-team-slug>",
        "ownerId": "<vercel-owner-scope-id>",
        "projectId": "<operator-vercel-project-id>"
      },
      "syntheticEnrollment": {
        "authority": "synthetic-only",
        "creationApprovalReference": "<approved-fresh-project-evidence-reference>",
        "sourceBaselineReference": "<reviewed-source-installation-evidence-reference>",
        "project": {
          "id": "<fresh-neon-project-id>",
          "ownerId": "<neon-project-owner-id>",
          "createdAt": "<project-created-at-iso-timestamp>"
        },
        "root": {
          "branchId": "<default-root-branch-id>",
          "createdAt": "<root-created-at-iso-timestamp>",
          "initSource": "parent-data"
        },
        "branches": [
          {
            "branchId": "<approved-child-branch-id>",
            "createdAt": "<child-created-at-iso-timestamp>",
            "parentId": "<default-root-branch-id>",
            "parentLsn": "<observed-parent-lsn>",
            "initSource": "parent-data"
          }
        ]
      }
    },
    "scope": {
      "projectId": "<fresh-neon-project-id>",
      "branchId": "<approved-child-branch-id>",
      "endpointId": "<selected-child-endpoint-id>",
      "hostname": "<selected-child-endpoint-hostname>.neon.tech",
      "maintenanceDatabase": "<approved-maintenance-database>",
      "maintenanceRole": "<approved-maintenance-role>"
    }
  }
}
```

The example assumes a child with an observed LSN and no parent timestamp; add
`parentTimestamp` with its exact ISO value if returned. If readback has only a
timestamp, omit `parentLsn`. Use the actual observed source strings. A root
selection uses the enrolled root ID and its independently read-back endpoint;
`branches` can be empty. REST Connect additionally requires the existing
`connectorInstallationId` at the same configuration level, independently of
the Vercel native-store configuration ID. No credential values belong here.

## Validation and acceptance

Focused source tests cover the two reader paths, legacy restrictions, enrolled
root/child acceptance, mismatched project/owner/root/lineage/default/endpoint,
missing/unknown metadata, reset/restore markers, caller mutation, readback
changes during credential acquisition and current-owner revocation. Planning
checks prove no URI/SQL request. These fixtures do not prove provider behavior,
resource contents, deployment grants or customer-visible qualification.

The coordinator must separately review/deploy the concrete configuration,
verify fresh-project and baseline evidence and exact provider payloads, and
perform the protected original-session acceptance in the qualification plan.
No new public Builder session, live provider action or Production migration is
part of source verification.
