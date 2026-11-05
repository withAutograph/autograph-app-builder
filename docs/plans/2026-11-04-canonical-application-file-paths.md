# Canonical application file paths

Normal Builder repair must accept actual application filenames throughout
planning, frozen iteration receipts, apply, source handoff and publication.
Next.js dynamic and optional catch-all routes, route groups, parallel slots and
intercepting routes are ordinary source files, not traversal or shell patterns.

The observed failure is a mismatch: the public repair input accepts
`app/auth/[...view]/page.tsx`, but its frozen iteration parser rejects brackets.
Use one maintained canonical relative-file-path schema for application changes
and their iteration inventory. Keep destination/workspace identity schemas and
all existing app ownership, preimage, approval and publication guards intact.
Reject absolute paths, dot/dot-dot traversal segments, empty segments, backslash,
NUL and control characters. Preserve legal filename bytes rather than decoding,
normalizing or rewriting a path into another target.

Treat those filenames literally across every transport. In particular, observed
file modes must read the exact selected path, never a shell-expanded bracket
pattern. Prefer structured filesystem operations; any maintained shell boundary
must quote the full argument correctly. Do not solve this by weakening the
generated app, omitting the route or changing its identity.

Qualify real dynamic/catch-all/group/parallel/intercepting filenames, a collision
that would otherwise match a bracket glob, unsafe paths and unchanged app-root
ownership. Exercise the same normal prepare-to-frozen-plan/apply path and retain
exact content/mode preimages. Finally resume the saved app through public Builder
controls with a fresh repair plan and approval; do not replay its rejected call
or any prior response batch.
