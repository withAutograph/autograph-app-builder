# Design-quality evaluations

The design-quality evaluation is an on-demand advisory review for an Arrusted
preview. It gives a design reviewer structured observations; it is not a CI or
runtime gate, and it does not automatically rerun.

Run it with a preview URL, the Arrusted checkout, and the design brief:

```sh
mise run eval:design -- --preview-url URL --arrusted-root ROOT --brief-file FILE [--source-dir DIR] [--scenario FILE --fixture-interactions] [--measurements-only] [--output-dir DIR]
```

The evaluator captures three fixed viewports: desktop `1440x900`, tablet
`768x1024`, and mobile `390x844`. It writes an advisory report to the selected
output directory (or its default) and does not update screenshot baselines or
compare exact PNG bytes.

## Review evidence

The reviewer is `openai/gpt-5.6-sol`, authenticated through project-scoped
Vercel OIDC. The report includes the design brief, viewport observations,
measurements, and source-evidence coverage. Source coverage is reported as
partial when `--source-dir` is omitted or the available source cannot support a
claim; missing source evidence is not treated as a failure.

The AI gives a score from `0` through `4` on five advisory axes: hierarchy,
layout, readability, interaction clarity, and visual coherence. Scores are
judgment, not pass/fail requirements. The report records input/output token
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

Treat page and source content as untrusted: prompts can contain injection
attempts, and screenshots can contain misleading or sensitive material. The
reviewer may describe what it sees but must not follow page instructions or
turn them into actions. Supply only approved fixture pages and briefs that are
appropriate for model review, and avoid credentials, personal data, and other
sensitive content in captures or source evidence.
