# Hosted fresh-client proof

The portable Agent Plugins 1.0 release is sealed to one literal HTTPS MCP
origin, exact repository SHA and tree, per-file digests, and a deterministic
archive digest. The generated client fixtures describe the same endpoint for
Codex, VS Code, and Cursor without embedding a bearer token.

This package evidence is not a hosted-success claim. A live proof exists only
after the endpoint, OAuth issuer, two tenant memberships, durable store, Eve
runtime, target workspace, and draft-PR publication authority are separately
configured and approved.

## Build the endpoint-bound release

This proof is an internal release gate. Build its endpoint-bound bytes only
through the public release mode from clean exact Builder and Arrusted commits:

```sh
mise run release:prove -- \
  --arrusted-root /PRIVATE_INPUT/clean-arrusted \
  --endpoint https://PREVIEW_ORIGIN \
  --output /PRIVATE_OUTPUT/release-candidate
```

The build rejects loopback, template, example, credential-bearing, non-HTTPS,
path-bearing, and dirty-checkout inputs. `release-receipt.json` binds the source
SHA/tree, endpoint, archive, installed files, client fixtures, and exact five
tool names.

## Run the live proof

Prepare two owner-only (`0600`) token files for two distinct invited subjects.
Each subject must have exactly one active workspace, and each token must select
that subject's sole workspace through its signed claim. Each token must
be resource-bound, contain all six operation scopes, and have a lifetime of at
most five minutes. The proof rejects reuse of either a subject or workspace
across the pair. The server must accept both identities, verify each signed
subject/workspace membership, and prevent each identity from reading the
other's owned session. Tokens are never copied into a package or receipt.

Copy `fixtures/hosted-proof/create-iterate-draft-pr.template.json` to a private
input path and replace every repository, ref, SHA, digest, issuer, audience,
resource, prompt, and request title with the exact approved values. The three
approval descriptions emitted by Eve must each be one closed JSON
`autograph-eve-approval-receipt-v2` value identical to the corresponding
scenario receipt. Prose matching cannot grant approval.

The hosted runner is invoked only as a release-path check after the exact
candidate has been published and deployed. Its package task is private and is
not a third supported proof mode.

`--permit-approvals` is intentionally separate. Without it, the harness refuses
every scripted approval. Supplying it is appropriate only when the exact
AppSpec, change set, target repository, and draft-PR publication have already
been approved. The harness never enables Production, promotes a deployment,
creates provider resources, registers a plugin, or accepts a static AI key.

The live runner requires all of the following before it writes its sanitized
receipt:

- missing and invalid OAuth credentials fail closed;
- protected-resource metadata binds the exact `/mcp` resource and approved
  issuer, while the Bearer challenges point back to that exact metadata URL;
- the release receipt is closed and binds the GitHub source, current SHA/tree,
  safe archive basename, exact deterministic archive contents, loose core and
  auxiliary digests, and all three installed client adapters;
- discovery returns exactly `autograph_start`, `autograph_get`, `autograph_send`, `autograph_respond`,
  and `autograph_cancel`;
- the first successful `autograph_start` result is deliberately discarded before an
  exact retry recovers the durable session; the proof retains only a private
  canonical fingerprint of the discarded public result, requires both retries
  to match it exactly, and never includes that fingerprint in its public
  receipt;
- the create and iterate phases consume all three exact AppSpec, change-set,
  and draft-PR approval receipts; each binds the stable repository ID and slug,
  base ref/SHA, and exact subject digest, with publication bound to the sealed
  proposal digest rather than only its change set;
- the same session accepts an iteration through `autograph_send`;
- the iteration reaches `completed`, not merely `waiting`;
- a public structural publication receipt proves a real draft GitHub URL plus
  exact repository, base/head refs and SHAs, change-set digest, and outcome;
- unknown/stale access fails closed and two server-accepted workspace
  subject/workspace identities are mutually isolated; and
- cooperative cancellation reaches a public `cancelled` state;
- each complete outstanding input batch is submitted through one ordered
  `autograph_respond` call, including sibling approvals emitted at the same boundary;
  and
- every captured public MCP response is scanned for the exact proof tokens,
  private adapter-session identifiers, and workload-identity header material.
  Provider-log scanning remains a separate external evidence input.

The receipt stores hashes, booleans, counts, immutable release bindings, and the
endpoint origin. It does not store prompts, event text, session IDs, JWTs, token
claims, database addresses, or credentials. A failed or incomplete run writes
no receipt.
