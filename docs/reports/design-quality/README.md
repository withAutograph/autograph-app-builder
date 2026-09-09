# Generated UI design reports

Shared, advisory observations of generated previews. No pass threshold or runtime gate.

**Six-case evaluation:** [Arrusted and AG2 results, screenshots and limitations](2026-09-09/arrusted-ag2-batch.md).

**Latest comparison:** [Recurring-improvement reference examples](2026-09-09/recurring-improvements.md). These are hand-authored references, not a new generation benchmark.

**Latest report:** [compensation-planning-recurring-reference](2026-09-09/compensation-planning-recurring-reference-142534641Z/README.md)

## Convention

Each run lives in `YYYY-MM-DD/<app-name>-HHmmssSSSZ/`, using the evaluation timestamp in UTC. Keep earlier runs intact. Each folder contains a GitHub-readable `README.md`, `index.html`, `report.json`, and the matching screenshots. Screenshot names use `<viewport>-<state-index>.png`: state 0 is the initial screen; the report names subsequent interaction states. Do not replace one app's screenshots with another app's output.

Generate into ignored `.artifacts/`, review for secrets/customer information, then explicitly archive:

```sh
mise run eval:design-archive -- --report-dir .artifacts/design-quality/RUN --name app-name
```

Archiving copies saved evidence; it does not rerun the evaluator, stage Git changes, push, or deploy. Commit the complete folder and this index together. Existing PNG baselines were retired; screenshots here are evidence, not pixel-match expectations.

## History

| Evaluated (UTC)          | App                                                                                                                    | Subjective score / 100 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 2026-09-09T14:25:34.641Z | [compensation-planning-recurring-reference](2026-09-09/compensation-planning-recurring-reference-142534641Z/README.md) | 75                     |
| 2026-09-09T14:25:30.877Z | [spend-import-review-recurring-reference](2026-09-09/spend-import-review-recurring-reference-142530877Z/README.md)     | 65                     |
| 2026-09-09T13:22:44.628Z | [spend-import-review](2026-09-09/spend-import-review-132244628Z/README.md)                                             | 75                     |
| 2026-09-09T13:19:50.277Z | [revenue-analysis](2026-09-09/revenue-analysis-131950277Z/README.md)                                                   | 80                     |
| 2026-09-09T13:15:21.865Z | [vendor-spend-forecast](2026-09-09/vendor-spend-forecast-131521865Z/README.md)                                         | 80                     |
| 2026-09-09T13:14:30.037Z | [reorganization-scenario](2026-09-09/reorganization-scenario-131430037Z/README.md)                                     | 90                     |
| 2026-09-09T13:13:05.302Z | [compensation-planning](2026-09-09/compensation-planning-131305302Z/README.md)                                         | 75                     |
| 2026-09-09T13:12:50.013Z | [position-request](2026-09-09/position-request-131250013Z/README.md)                                                   | 85                     |
| 2026-09-09T12:39:10.739Z | [stock-exceptions-explained-addition](2026-09-09/stock-exceptions-explained-addition-123910739Z/README.md)             | 95                     |
| 2026-09-09T12:22:01.012Z | [stock-exceptions-ranked-selection](2026-09-09/stock-exceptions-ranked-selection-122201012Z/README.md)                 | 90                     |
| 2026-09-09T12:10:38.077Z | [stock-exceptions-readable-description](2026-09-09/stock-exceptions-readable-description-121038077Z/README.md)         | 90                     |
| 2026-09-09T12:02:36.378Z | [stock-exceptions-header-description](2026-09-09/stock-exceptions-header-description-120236378Z/README.md)             | 95                     |
| 2026-09-09T11:38:02.027Z | [stock-exceptions-consistent-basis](2026-09-09/stock-exceptions-consistent-basis-113802027Z/README.md)                 | 95                     |
| 2026-09-09T11:25:25.416Z | [stock-exceptions-calculation-disclosure](2026-09-09/stock-exceptions-calculation-disclosure-112525416Z/README.md)     | 90                     |
| 2026-09-09T11:16:16.454Z | [stock-exceptions-compact-orientation](2026-09-09/stock-exceptions-compact-orientation-111616454Z/README.md)           | 95                     |
| 2026-09-09T11:04:34.428Z | [stock-exceptions-focused-context](2026-09-09/stock-exceptions-focused-context-110434428Z/README.md)                   | 90                     |
| 2026-09-09T10:53:42.438Z | [stock-exceptions-visible-selection](2026-09-09/stock-exceptions-visible-selection-105342438Z/README.md)               | 95                     |
| 2026-09-09T10:41:07.615Z | [stock-exceptions-selection-guidance](2026-09-09/stock-exceptions-selection-guidance-104107615Z/README.md)             | 90                     |
| 2026-09-09T10:26:22.321Z | [stock-exceptions-compact-outcome](2026-09-09/stock-exceptions-compact-outcome-102622321Z/README.md)                   | 95                     |
| 2026-09-09T10:04:09.431Z | [stock-exceptions-full-outcome](2026-09-09/stock-exceptions-full-outcome-100409431Z/README.md)                         | 90                     |
| 2026-09-09T09:54:32.378Z | [stock-exceptions-header-actions](2026-09-09/stock-exceptions-header-actions-095432378Z/README.md)                     | 80                     |
| 2026-09-09T09:46:19.617Z | [stock-exceptions-reachable-actions](2026-09-09/stock-exceptions-reachable-actions-094619617Z/README.md)               | 80                     |
| 2026-09-09T09:29:55.074Z | [stock-exceptions-primary-labels](2026-09-09/stock-exceptions-primary-labels-092955074Z/README.md)                     | 90                     |
| 2026-09-09T09:17:03.978Z | [stock-exceptions-decision-composition](2026-09-09/stock-exceptions-decision-composition-091703978Z/README.md)         | 90                     |
| 2026-09-09T08:56:31.747Z | [stock-exceptions-natural-window](2026-09-09/stock-exceptions-natural-window-085631747Z/README.md)                     | 90                     |
| 2026-09-09T08:46:08.340Z | [stock-exceptions-native-scroll](2026-09-09/stock-exceptions-native-scroll-084608340Z/README.md)                       | 90                     |
| 2026-09-09T08:40:18.759Z | [stock-exceptions-minimal-scroll](2026-09-09/stock-exceptions-minimal-scroll-084018759Z/README.md)                     | 90                     |
| 2026-09-09T08:28:16.955Z | [stock-exceptions-aligned-header](2026-09-09/stock-exceptions-aligned-header-082816955Z/README.md)                     | 90                     |
| 2026-09-09T08:22:18.776Z | [stock-exceptions-strong-actions](2026-09-09/stock-exceptions-strong-actions-082218776Z/README.md)                     | 90                     |
| 2026-09-09T08:12:05.324Z | [stock-exceptions-outlined-actions](2026-09-09/stock-exceptions-outlined-actions-081205324Z/README.md)                 | 95                     |
| 2026-09-09T08:04:04.459Z | [stock-exceptions-state-aware-confirmation](2026-09-09/stock-exceptions-state-aware-confirmation-080404459Z/README.md) | 95                     |
| 2026-09-09T07:55:11.473Z | [stock-exceptions-concise-confirmation](2026-09-09/stock-exceptions-concise-confirmation-075511473Z/README.md)         | 85                     |
| 2026-09-09T07:50:47.921Z | [stock-exceptions-consistent-confirmation](2026-09-09/stock-exceptions-consistent-confirmation-075047921Z/README.md)   | 85                     |
| 2026-09-09T07:43:37.561Z | [stock-exceptions-stacked-explanations](2026-09-09/stock-exceptions-stacked-explanations-074337561Z/README.md)         | 90                     |
| 2026-09-09T07:27:05.375Z | [stock-exceptions-supplier-constraints](2026-09-09/stock-exceptions-supplier-constraints-072705375Z/README.md)         | 90                     |
| 2026-09-09T07:20:51.570Z | [stock-exceptions-priority-label](2026-09-09/stock-exceptions-priority-label-072051570Z/README.md)                     | 85                     |
| 2026-09-09T07:16:25.252Z | [stock-exceptions-urgency-context](2026-09-09/stock-exceptions-urgency-context-071625252Z/README.md)                   | 80                     |
| 2026-09-09T07:05:32.329Z | [stock-exceptions-compact-calculation](2026-09-09/stock-exceptions-compact-calculation-070532329Z/README.md)           | 90                     |
| 2026-09-09T07:00:15.211Z | [stock-exceptions-confirmation-evidence](2026-09-09/stock-exceptions-confirmation-evidence-070015211Z/README.md)       | 85                     |
| 2026-09-09T06:53:41.948Z | [stock-exceptions-disclosure-reveal](2026-09-09/stock-exceptions-disclosure-reveal-065341948Z/README.md)               | 85                     |
| 2026-09-09T06:37:15.000Z | [stock-exceptions-context-comparison](2026-09-09/stock-exceptions-context-comparison-063715000Z/README.md)             | 90                     |
| 2026-09-09T06:33:14.792Z | [stock-exceptions-readable-tag](2026-09-09/stock-exceptions-readable-tag-063314792Z/README.md)                         | 90                     |
| 2026-09-09T06:23:25.572Z | [stock-exceptions-readable-outcome](2026-09-09/stock-exceptions-readable-outcome-062325572Z/README.md)                 | 75                     |
| 2026-09-09T06:19:07.936Z | [stock-exceptions-content-fit](2026-09-09/stock-exceptions-content-fit-061907936Z/README.md)                           | 80                     |
| 2026-09-09T06:12:09.440Z | [stock-exceptions-shared-emphasis](2026-09-09/stock-exceptions-shared-emphasis-061209440Z/README.md)                   | 80                     |
| 2026-09-09T05:44:00.198Z | [stock-exceptions-authored-provenance](2026-09-09/stock-exceptions-authored-provenance-054400198Z/README.md)           | 80                     |
| 2026-09-09T05:34:16.236Z | [stock-exceptions-outcome-summary](2026-09-09/stock-exceptions-outcome-summary-053416236Z/README.md)                   | 85                     |
| 2026-09-09T05:28:22.104Z | [stock-exceptions-filter-fit](2026-09-09/stock-exceptions-filter-fit-052822104Z/README.md)                             | 85                     |
| 2026-09-09T05:22:04.677Z | [stock-exceptions-context-actions](2026-09-09/stock-exceptions-context-actions-052204677Z/README.md)                   | 80                     |
| 2026-09-09T05:11:25.618Z | [stock-exceptions-structured-result](2026-09-09/stock-exceptions-structured-result-051125618Z/README.md)               | 75                     |
| 2026-09-09T05:04:48.232Z | [stock-exceptions-verified-interactions](2026-09-09/stock-exceptions-verified-interactions-050448232Z/README.md)       | 80                     |
| 2026-09-09T04:54:02.841Z | [stock-exceptions-disclosure-finding](2026-09-09/stock-exceptions-disclosure-finding-045402841Z/README.md)             | 70                     |
| 2026-09-09T04:47:23.140Z | [stock-exceptions-decision-evidence](2026-09-09/stock-exceptions-decision-evidence-044723140Z/README.md)               | 80                     |
| 2026-09-09T04:34:43.346Z | [stock-exceptions-reachable-actions](2026-09-09/stock-exceptions-reachable-actions-043443346Z/README.md)               | 80                     |
| 2026-09-09T04:32:41.537Z | [stock-exceptions-actions-scenario-error](2026-09-09/stock-exceptions-actions-scenario-error-043241537Z/README.md)     | 75                     |
| 2026-09-09T04:10:24.873Z | [stock-exceptions-shared-composition](2026-09-09/stock-exceptions-shared-composition-041024873Z/README.md)             | 80                     |
| 2026-09-09T03:37:37.128Z | [stock-exceptions-attribution-repair](2026-09-09/stock-exceptions-attribution-repair-033737128Z/README.md)             | not scored             |
| 2026-09-09T03:11:12.441Z | [stock-exceptions-fresh-postmerge](2026-09-09/stock-exceptions-fresh-postmerge-031112441Z/README.md)                   | 65                     |
| 2026-09-09T02:10:07.174Z | [stock-exceptions-task-first](2026-09-09/stock-exceptions-task-first-021007174Z/README.md)                             | 90                     |
| 2026-09-09T00:56:43.352Z | [stock-exceptions-review-action](2026-09-09/stock-exceptions-review-action-005643352Z/README.md)                       | 85                     |
| 2026-09-09T00:40:02.709Z | [stock-exceptions-sku-metadata](2026-09-09/stock-exceptions-sku-metadata-004002709Z/README.md)                         | 90                     |
| 2026-09-09T00:19:13.264Z | [stock-exceptions-delivery-signal](2026-09-09/stock-exceptions-delivery-signal-001913264Z/README.md)                   | 95                     |
| 2026-09-09T00:15:48.602Z | [stock-exceptions-settled-evidence](2026-09-09/stock-exceptions-settled-evidence-001548602Z/README.md)                 | 95                     |
| 2026-09-09T00:06:57.443Z | [stock-exceptions-concise-completion](2026-09-09/stock-exceptions-concise-completion-000657443Z/README.md)             | 95                     |
| 2026-09-09T00:03:14.211Z | [stock-exceptions-stable-footer](2026-09-09/stock-exceptions-stable-footer-000314211Z/README.md)                       | 95                     |
| 2026-09-08T23:58:54.478Z | [stock-exceptions-compact-footer](2026-09-08/stock-exceptions-compact-footer-235854478Z/README.md)                     | 90                     |
| 2026-09-08T23:53:50.250Z | [stock-exceptions-shared-tags](2026-09-08/stock-exceptions-shared-tags-235350250Z/README.md)                           | 95                     |
| 2026-09-08T23:47:49.774Z | [stock-exceptions-semantic-severity](2026-09-08/stock-exceptions-semantic-severity-234749774Z/README.md)               | 90                     |
| 2026-09-08T23:42:38.518Z | [stock-exceptions-focused-detail](2026-09-08/stock-exceptions-focused-detail-234238518Z/README.md)                     | 90                     |
| 2026-09-08T23:36:24.339Z | [stock-exceptions-narrow-navigation](2026-09-08/stock-exceptions-narrow-navigation-233624339Z/README.md)               | 80                     |
| 2026-09-08T21:41:52.809Z | [stock-exceptions-action-context](2026-09-08/stock-exceptions-action-context-214152809Z/README.md)                     | 90                     |
| 2026-09-08T21:34:06.461Z | [stock-exceptions-compact-delivery](2026-09-08/stock-exceptions-compact-delivery-213406461Z/README.md)                 | 85                     |
| 2026-09-08T21:18:54.599Z | [stock-exceptions-selected-context](2026-09-08/stock-exceptions-selected-context-211854599Z/README.md)                 | 85                     |
| 2026-09-08T21:10:34.840Z | [stock-exceptions-compact-primitives](2026-09-08/stock-exceptions-compact-primitives-211034840Z/README.md)             | 85                     |
| 2026-09-08T20:59:37.286Z | [stock-exceptions-natural-tables](2026-09-08/stock-exceptions-natural-tables-205937286Z/README.md)                     | 85                     |
| 2026-09-08T20:30:50.797Z | [stock-exceptions-compact-context](2026-09-08/stock-exceptions-compact-context-203050797Z/README.md)                   | 85                     |
| 2026-09-08T20:19:19.952Z | [stock-exceptions-delivery-context](2026-09-08/stock-exceptions-delivery-context-201919952Z/README.md)                 | 90                     |
| 2026-09-08T20:02:26.952Z | [stock-exceptions-grouped-outcome](2026-09-08/stock-exceptions-grouped-outcome-200226952Z/README.md)                   | 90                     |
| 2026-09-08T19:55:32.570Z | [stock-exceptions-readable-outcome](2026-09-08/stock-exceptions-readable-outcome-195532570Z/README.md)                 | 85                     |
| 2026-09-08T19:27:15.403Z | [stock-exceptions-shared-cards](2026-09-08/stock-exceptions-shared-cards-192715403Z/README.md)                         | 90                     |
| 2026-09-08T19:18:19.290Z | [stock-exceptions-tabbed-detail](2026-09-08/stock-exceptions-tabbed-detail-191819290Z/README.md)                       | 80                     |
| 2026-09-08T19:03:03.519Z | [stock-exceptions-composition-corrected](2026-09-08/stock-exceptions-composition-corrected-190303519Z/README.md)       | 80                     |
| 2026-09-08T18:58:11.538Z | [stock-exceptions-composition-first-pass](2026-09-08/stock-exceptions-composition-first-pass-185811538Z/README.md)     | 65                     |
| 2026-09-08T18:14:23.365Z | [stock-exceptions-adherence-v2](2026-09-08/stock-exceptions-adherence-v2-181423365Z/README.md)                         | 75                     |
| 2026-09-08T16:00:06.674Z | [equipment-request](2026-09-08/equipment-request-160006674Z/README.md)                                                 | 75                     |
| 2026-09-08T15:56:46.883Z | [equipment-request](2026-09-08/equipment-request-155646883Z/README.md)                                                 | 75                     |
| 2026-09-08T15:50:03.870Z | [stock-exceptions](2026-09-08/stock-exceptions-155003870Z/README.md)                                                   | 75                     |
| 2026-09-08T11:39:04.457Z | [stock-exceptions](2026-09-08/stock-exceptions-113904457Z/README.md)                                                   | 60                     |
