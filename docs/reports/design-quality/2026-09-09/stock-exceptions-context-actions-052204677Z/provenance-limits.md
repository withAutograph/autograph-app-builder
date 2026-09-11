# Why current styling coverage remains partial

The active component preview is produced by `lib/agent/ui-preview-renderer.ts`, not by the generated application's Next.js deployment renderer. The preview renderer builds browser JavaScript with Bun, compiles the theme and scanned component classes with PostCSS/Tailwind, and returns one HTML document containing inline CSS. It does not currently retain CSS source maps.

The evaluator's source-map consumer is now on main, but consumer support alone does not restore absent producer evidence. No extra adherence credit is awarded for shared-looking filenames, matching colors, or ambiguous theme rules.

An implementation worth exploring separately would preserve compiler-produced CSS maps and their corresponding CSS as revision-scoped preview assets. Actual browser map discovery and mapped declaration positions must be demonstrated before claiming that this improves attribution. Merely enabling a build option is not evidence of browser-visible provenance.

Even valid Tailwind maps need careful interpretation: a synthesized utility's mapping to the compilation entry stylesheet is not proof of which generated or shared TSX occurrence requested it. Authored CSS attribution and TSX utility ownership are different claims. Keep unresolved utility ownership unassessed.

## Subsequent browser experiment

A controlled Chromium experiment subsequently confirmed that inline `<style>` elements can expose real PostCSS data source maps through CDP. External asset transport is therefore unnecessary. The smaller implementation to evaluate is an inline PostCSS map with `sourcesContent`, keeping that CSS separate from Bun-emitted CSS so the map remains associated with its own stylesheet. This does not remove the synthesized-utility ownership limitation described above.

This note records an evidence limitation, not a runtime prerequisite or a change to the scoring denominator. No source-map generation, deployment transport, palette, or runtime change is included in this report PR.
