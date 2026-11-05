# Hosted operator worker source catalog

Fresh, unregistered apps select the deployment-owned
`sandbox.genericInstallerWorker`, not a deduplicated alias from
`sandbox.workers`. Its install scope/subcommand and `sourceCapture` are required.
An absent descriptor returns `generic_installer_configuration_required`.
Existing registered apps retain their explicitly selected per-app descriptor;
frozen plans, their hashes and approvals retain their original meaning.

The current generic descriptor identifies an immutable catalog receipt by
absolute deployed `catalogPath`, raw `catalogSha256`, family `genericInstaller`,
and the exact Builder and Arrusted commit/tree pairs. A new plan freezes this
reference with the installer. Before dispatch, the operator independently hashes
the actual executable and reads the actual catalog bytes from its selected
Sandbox. The receipt must match the frozen sources, selected binary hash and
relative executable path. Claimed config metadata alone is not source proof.
Legacy descriptors without receipts continue under their existing hash pins;
this does not retrospectively establish their authored source.

## Offline release build

From a clean committed Builder checkout, with a clean committed platform-only
Arrusted checkout and each checkout's own maintained dependencies, run:

```sh
mise run source:operator-worker-catalog -- /absolute/arrusted-source /absolute/fresh-external-output "$(mise which bun)"
```

The output directory must not exist and must be outside both source checkouts.
The operation invokes the maintained builders with Bun 1.3.14 for Linux x64:

| Family                        | Maintained source/build                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Generic install/access/export | Arrusted `build-protected-generated-app-worker.mjs`; `packages/generated-app-runtime/protected-installer-worker.ts` |
| Auth proposal                 | Arrusted `build-protected-auth-proposal.mjs`; `auth-schema-proposal.ts`                                             |
| Auth schema/membership/signup | Arrusted `build-protected-auth-worker.mjs`, then explicit Linux compilation                                         |
| Neon resources                | Arrusted `build-neon-resource-bootstrap-worker.mjs`, then explicit Linux compilation                                |
| Managed runtime               | Builder `scripts/build-managed-runtime-worker.mjs`, importing Builder runtime and Arrusted Gateway verifier         |

The catalog binds both repositories because managed runtime imports both.
`catalog.json` is written last, after actual ELF x64, mode, bytes and SHA256
readback of all five executables and an unchanged source commit/tree readback.
Failed builds retain their owned partial output without a completion receipt.
Intermediate JavaScript is build output, not additional deployment authority.

The central resources/schema/application three-worker bundle is separate. It
must also be rebuilt from the same final Arrusted source. It does not replace
this five-family catalog or prove the source of older installed binaries.

## Qualification and deployment boundaries

This task builds local code artifacts only. It does not create/resume a VM,
upload a bundle, configure an operator, select a deployment or grant approval.
Keep all old worker paths, hashes and receipts available in their legacy catalog
for frozen operations. Use a separate namespace for the new catalog. Do not
relabel old binaries as current because they hash consistently.

Before configuring a current catalog, independently verify its receipt and all
five binary hashes against the final source cut; run the maintained Linux
credential-free protocol checks for the operations being released. Then obtain
ordinary approval for the concrete snapshot/configuration effects and read back
the actual selected image, receipt and worker bytes. Update new-operation
Auth, resource, export and managed-runtime descriptors to the freshly qualified
family binaries, retaining their existing operation scopes and subcommands.
The catalog's generic family serves install/access/export; Auth serves the
separate Auth logical descriptors. Old pins remain available for old plans.

A source build, READY deployment, Git ancestry or config string does not establish
provider activation or A-469 acceptance. Final delivery still follows native
Git deployment, provider activation, Gateway routing and independent readback.
