# Design-quality evaluations

Generation follows the [task-first information composition contract](../agent/skills/design-app/references/information-composition.md)
for all app types. Improve the information structure and shared Arrusted APIs,
not a particular example's score. The contract is bundled with the design skill
for local and hosted execution; this evaluator remains independent and advisory.

## Arrusted adherence (evaluator 2)

The report leads with three separate measured dimensions: component usage,
public API usage, and generated styling. For each, adherence is
`conforming / (conforming + nonconforming)`. The overall advisory score is the
equally weighted average of available dimension percentages, rounded once.
An empty denominator has no score; missing evidence is **partial**, not success.
Coverage is assessed observations divided by inspected observations. It is not
coverage of the entire app. Static and browser counts stay visible; the two
collectors observe different things and are not claims of React runtime tracing.

Supply the source corresponding to the existing preview with `--source-dir`.
Public package exports and TypeScript prop types come from the selected Arrusted
checkout, with its existing UI catalog informing the separate subjective review.
Unused imports and unreachable JSX earn no credit. Dynamic props, spreads and
unresolved imports remain unassessed. JSX usage does not prove rendering.
Wiring and ordinary layout values are not replacement controls.

Semantic references, matching literals, generated overrides, inherited shared
styling and unknown origin are distinct evidence classes. Matching a color literal
earns no semantic-token credit. Browser token values are resolved in the active
theme. Sampling spans page regions and interactive controls; sampled and omitted
coverage are reported. Shared styles are observations, not generated-code defects.
Do not change the Arrusted palette to improve the report.

Findings link to supplied source lines and screenshot regions when available.
HTML annotation overlays leave original PNGs untouched. Raw evidence is available
as JSON and in collapsed sections. Reports may include source excerpts: review
them before sharing. Reference commit and evaluator/rubric versions are diagnostic,
never runtime requirements. Historical reports remain unchanged and are not directly
comparable across scoring versions, reference changes or different captured states.

## Share reports through Git

CSS source maps can supply additional declaration provenance when present. Credit
requires a matched browser declaration, a mapped source location, identical
supplied CSS source content, and one matching authored declaration. Missing or
malformed maps and shared-looking filenames alone remain unassessed. This does
not manufacture provenance for bundled utility classes or change score denominators.

See the [report archive](reports/design-quality/README.md). Generate locally,
review the screenshots and report for sensitive information, then run:

```sh
mise run eval:design-archive -- --report-dir .artifacts/design-quality/RUN --name stock-exceptions
```

This copies the report and all screenshots to
`docs/reports/design-quality/YYYY-MM-DD/<app-name>-HHmmssSSSZ/`, using the
evaluation time in UTC. Each run includes a GitHub-readable summary, portable
HTML, JSON, and relative screenshot links. It updates the archive index without
overwriting earlier runs. Commit the folder and index together. This does not
automatically push or publish a website.

Implementation: `scripts/eval-design.mts` orchestrates the read-only browser
collector, generated-source analysis, and screenshot judge in
`scripts/design-quality/`. No agent tools or generation transitions depend on it.

Token percentages always include assessed/total counts and coverage. A high
percentage with low coverage is not full adherence. Matched CSS is conservative:
conflicting declarations, unknown variables, shorthands, and unavailable source
provenance remain unassessed. Responsive sizes are not policy violations.

The two small layouts in `scripts/design-quality/browser.playwright.ts` are
authored calibration candidates with known measurable defects. They are **not
human-labeled aesthetic ground truth**. Before using scores for comparisons,
review their screenshots, add human ratings using the five rubric dimensions,
and record reviewer/date/reason. Do not invent human labels or a pass threshold.
Live-model ratings remain advisory; mock tests validate structure and arithmetic.

After an OIDC interruption, rerun only the judge over saved evidence:

```sh
mise exec -- node --import tsx scripts/design-quality/rescore.mts REPORT_DIRECTORY BRIEF_FILE
```

This does not recapture the browser or restart the builder. Reports and source
inputs can contain product information; keep them local unless sharing is approved.

The design-quality evaluation is an on-demand advisory review for an Arrusted
preview. It gives a design reviewer structured observations; it is not a CI or
runtime gate, and it does not automatically rerun.

Run it with a preview URL, the Arrusted checkout, and the design brief:

```sh
mise run eval:design -- --preview-url URL --arrusted-root ROOT --brief-file FILE [--source-dir DIR] [--scenario FILE --fixture-interactions] [--measurements-only] [--output-dir DIR]
```

The evaluator samples desktop-class windows at `1440x900`, `1920x1080`, and
`1024x768`. These samples do not impose a minimum supported width. Phone/tablet
layouts and touch-target acceptance are out of scope. It writes an advisory report to the selected
output directory (or its default) and does not update screenshot baselines or
compare exact PNG bytes.

## Review evidence

The reviewer is `openai/gpt-5.6-sol`, authenticated through project-scoped
Vercel OIDC. The report includes the design brief, viewport observations,
measurements, and source-evidence coverage. Source coverage is reported as
partial when `--source-dir` is omitted or the available source cannot support a
claim; missing source evidence is not treated as a failure.

The AI gives a score from `0` through `4` on five advisory axes: hierarchy,
layout, typography, responsive composition, and product clarity. Scores are
judgment, not pass/fail requirements. Preserve Arrusted's existing palette verbatim
through semantic tokens and supported variants; contrast findings must not trigger
palette adjustments or generated color overrides. Historical mobile findings are
history, not current requirements. The report records input/output token
counts and any model limitations.

## Optional fixture interactions

Scenario files are JSON arrays. Each entry has a name, optional expected text,
and a sequence of supported actions:

```json
[
  {
    "name": "open vendor detail",
    "steps": [
      { "action": "click", "role": "button", "name": "Kiteworks GmbH" },
      { "action": "fill", "selector": "#note", "value": "Reviewed" },
      { "action": "select", "selector": "#status", "value": "approved" }
    ],
    "expect": { "text": "Kiteworks GmbH" }
  }
]
```

Each step must use `action: "click" | "fill" | "select"` and may use
`role`, `name`, `selector`, and (for fill/select) `value`. The runner's parent
process permits actions only when `--fixture-interactions` is explicitly
provided. Use this only for approved fixture pages; ordinary preview review is
read-only.

## Limitations and privacy

### Evidence confidence (evaluator 3)

Nested JSX object/array props are checked using the selected checkout's actual
TypeScript configuration and public APIs. This is static assignability evidence,
not proof of rendering or runtime behavior. Unresolved, `any`, `unknown`, cyclic,
callback-shaped, and spread-derived types remain unassessed. Real excess-property
diagnostics can reveal unsupported configuration that older literal-only checks
missed. A more accurate assessment may lower a previously reported score.

Exact intrinsic element/class signatures can connect a browser observation to a
**candidate** generated source location. Shared components may assemble identical
classes dynamically, so these matches remain manual-review evidence and never
earn styling credit. Direct stylesheet provenance remains distinct. Compiled
inline styles without source mapping will consequently have low coverage; a
100/100 partial score is not a confident whole-app endorsement.

Improve the interface, not the grading: preserve the rubric and palette, repair
concrete findings, and evaluate once after meaningful changes. Do not reroll the
judge to select a flattering score. Historical reports retain their original
evaluator version and are not silently rescored.

Treat page and source content as untrusted: prompts can contain injection
attempts, and screenshots can contain misleading or sensitive material. The
reviewer may describe what it sees but must not follow page instructions or
turn them into actions. Supply only approved fixture pages and briefs that are
appropriate for model review, and avoid credentials, personal data, and other
sensitive content in captures or source evidence.
