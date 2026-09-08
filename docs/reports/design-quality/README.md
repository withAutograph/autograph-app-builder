# Generated UI design reports

Shared, advisory observations of generated previews. No pass threshold or runtime gate.

**Latest report:** [stock-exceptions](2026-09-08/stock-exceptions-113904457Z/README.md)

## Convention

Each run lives in `YYYY-MM-DD/<app-name>-HHmmssSSSZ/`, using the evaluation timestamp in UTC. Keep earlier runs intact. Each folder contains a GitHub-readable `README.md`, `index.html`, `report.json`, and the matching screenshots. Screenshot names use `<viewport>-<state-index>.png`: state 0 is the initial screen; the report names subsequent interaction states. Do not replace one app's screenshots with another app's output.

Generate into ignored `.artifacts/`, review for secrets/customer information, then explicitly archive:

```sh
mise run eval:design-archive -- --report-dir .artifacts/design-quality/RUN --name app-name
```

Archiving copies saved evidence; it does not rerun the evaluator, stage Git changes, push, or deploy. Commit the complete folder and this index together. Existing PNG baselines were retired; screenshots here are evidence, not pixel-match expectations.

## History

| Evaluated (UTC) | App | Subjective score / 100 |
| --- | --- | --- |
| 2026-09-08T11:39:04.457Z | [stock-exceptions](2026-09-08/stock-exceptions-113904457Z/README.md) | 60 |
