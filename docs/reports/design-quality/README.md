# Generated UI design reports

Shared, advisory observations of generated previews. No pass threshold or runtime gate.

**Latest report:** [stock-exceptions-compact-delivery](2026-09-08/stock-exceptions-compact-delivery-213406461Z/README.md)

## Convention

Each run lives in `YYYY-MM-DD/<app-name>-HHmmssSSSZ/`, using the evaluation timestamp in UTC. Keep earlier runs intact. Each folder contains a GitHub-readable `README.md`, `index.html`, `report.json`, and the matching screenshots. Screenshot names use `<viewport>-<state-index>.png`: state 0 is the initial screen; the report names subsequent interaction states. Do not replace one app's screenshots with another app's output.

Generate into ignored `.artifacts/`, review for secrets/customer information, then explicitly archive:

```sh
mise run eval:design-archive -- --report-dir .artifacts/design-quality/RUN --name app-name
```

Archiving copies saved evidence; it does not rerun the evaluator, stage Git changes, push, or deploy. Commit the complete folder and this index together. Existing PNG baselines were retired; screenshots here are evidence, not pixel-match expectations.

## History

| Evaluated (UTC)          | App                                                                                                                | Subjective score / 100 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| 2026-09-08T21:34:06.461Z | [stock-exceptions-compact-delivery](2026-09-08/stock-exceptions-compact-delivery-213406461Z/README.md)             | 85                     |
| 2026-09-08T21:18:54.599Z | [stock-exceptions-selected-context](2026-09-08/stock-exceptions-selected-context-211854599Z/README.md)             | 85                     |
| 2026-09-08T21:10:34.840Z | [stock-exceptions-compact-primitives](2026-09-08/stock-exceptions-compact-primitives-211034840Z/README.md)         | 85                     |
| 2026-09-08T20:59:37.286Z | [stock-exceptions-natural-tables](2026-09-08/stock-exceptions-natural-tables-205937286Z/README.md)                 | 85                     |
| 2026-09-08T20:30:50.797Z | [stock-exceptions-compact-context](2026-09-08/stock-exceptions-compact-context-203050797Z/README.md)               | 85                     |
| 2026-09-08T20:19:19.952Z | [stock-exceptions-delivery-context](2026-09-08/stock-exceptions-delivery-context-201919952Z/README.md)             | 90                     |
| 2026-09-08T20:02:26.952Z | [stock-exceptions-grouped-outcome](2026-09-08/stock-exceptions-grouped-outcome-200226952Z/README.md)               | 90                     |
| 2026-09-08T19:55:32.570Z | [stock-exceptions-readable-outcome](2026-09-08/stock-exceptions-readable-outcome-195532570Z/README.md)             | 85                     |
| 2026-09-08T19:27:15.403Z | [stock-exceptions-shared-cards](2026-09-08/stock-exceptions-shared-cards-192715403Z/README.md)                     | 90                     |
| 2026-09-08T19:18:19.290Z | [stock-exceptions-tabbed-detail](2026-09-08/stock-exceptions-tabbed-detail-191819290Z/README.md)                   | 80                     |
| 2026-09-08T19:03:03.519Z | [stock-exceptions-composition-corrected](2026-09-08/stock-exceptions-composition-corrected-190303519Z/README.md)   | 80                     |
| 2026-09-08T18:58:11.538Z | [stock-exceptions-composition-first-pass](2026-09-08/stock-exceptions-composition-first-pass-185811538Z/README.md) | 65                     |
| 2026-09-08T18:14:23.365Z | [stock-exceptions-adherence-v2](2026-09-08/stock-exceptions-adherence-v2-181423365Z/README.md)                     | 75                     |
| 2026-09-08T16:00:06.674Z | [equipment-request](2026-09-08/equipment-request-160006674Z/README.md)                                             | 75                     |
| 2026-09-08T15:56:46.883Z | [equipment-request](2026-09-08/equipment-request-155646883Z/README.md)                                             | 75                     |
| 2026-09-08T15:50:03.870Z | [stock-exceptions](2026-09-08/stock-exceptions-155003870Z/README.md)                                               | 75                     |
| 2026-09-08T11:39:04.457Z | [stock-exceptions](2026-09-08/stock-exceptions-113904457Z/README.md)                                               | 60                     |
