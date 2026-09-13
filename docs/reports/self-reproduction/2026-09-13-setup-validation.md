# Clean template and evaluator setup validation

The setup proof used a fresh clone of `withAutograph/arrusted-development`,
followed by separate disposable clones for canonical app generation. The
original r12 replica was never edited.

## Confirmed repairs

- Generated Vitest now resolves the repository TypeScript aliases, including
  the public component API. A real Vite transformation reproduces the original
  failure without the resolver and passes with it.
- Next is consistently 16.3.4. Template dependency pins and the Vite-plus
  catalog now match the repository. Post-generation installation no longer
  creates the incompatible Vite config types or a separate Next peer closure
  seen with the stale template.
- Generated apps include Tailwind PostCSS configuration and import the
  canonical shared theme. The styled starter browser readback confirmed
  sans-serif typography, text `rgb(41, 41, 41)`, and background
  `rgb(250, 250, 249)`, without custom palette values.
- The eval supplies the runner's supported `PORT` environment setting and
  reads the built Next base path instead of mistaking the gateway prefix for
  a direct server route. It installs Chromium and captures browser evidence
  while the Sandbox is alive, retaining partial logs and screenshots.
- Project OIDC owner-binding uses the selected absolute Mise executable in
  the restricted task environment. Reference startup uses the existing
  emulated product lifecycle in an isolated source snapshot and database.

## Executed proof

Canonical generation, post-generation installation, production typecheck/build,
unit test, production startup, and HTTP 200 passed locally. A fresh Vercel
Sandbox also completed installation/build/start and HTTP 200, then retained
six browser screenshots at the existing three desktop viewports. Its missing
`/docs` correctly returned 404: this fixture is a minimal starter, not a replica.

Evidence directories:

- `/private/tmp/arrusted-template-acceptance-aligned-20260913`
- `/private/tmp/arrusted-template-styled-acceptance-20260913`
- `/private/tmp/self-reproduction-starter-sandbox-proof-20260913-v3`

The Sandbox proof exposed a duplicate-observation error in final report
assembly after successful capture. The original runtime receipt and images
survived; a tested evidence merge now gives concrete observations precedence
over missing-adapter placeholders and keeps one row per side/requirement.

## Separate new generation

`/private/tmp/self-reproduction-repaired-template-generation-20260913` records
one subsequent real-model run. Generation took 332,802 ms and produced no app.
After a semantic prototype rejection, four repairs hit the arbitrary
2,000-character line limit. The model stopped and the harness incorrectly
continued into planning and export with no accepted AppSpec. This run does
not establish visual or functional replica parity.

The shared prototype validator now removes only that formatting gate, retaining
its semantic, content-size, and security checks; syntax compilation remains in
the renderer. The eval now checks the accepted design prerequisite and stops
before later stages when it is missing. Those repairs do not retroactively
turn the recorded failed run into a success.

Template PR: https://github.com/withAutograph/arrusted-development/pull/1360

Evaluator PR: https://github.com/withAutograph/autograph-app-builder/pull/427
