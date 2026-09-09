# Compact calculation comparison

The score increased from **85 to 90/100** against the expanded confirmation-aware
scenario set. All **20 interaction executions passed**. Typography, responsive
composition, and product clarity each scored 4/4; hierarchy and layout scored 3/4.

The revised confirmation combines the quantity, case count, case size, shortfall,
and rounding explanation instead of repeating intermediate facts in separate rows.
All five confirmation rows fit at 1024×768 without scrolling. The original baseline,
model assumption, and no-order notice remain. No palette or scoring changes were made.

The evaluator now captures confirmation before completion and the result's lower
evidence. A focused browser check showed the footer begins exactly at the scroll
viewport's bottom; lower result content is reachable through ordinary scrolling.
Do not interpret a screenshot of a partially scrolled row as proven overlap.

## Evidence coverage

All assessed observations conform, but confidence is not uniform:

| Dimension                    | Conforming | Unassessed | Coverage |
| ---------------------------- | ---------: | ---------: | -------: |
| Component usage (static JSX) |         18 |          2 |      90% |
| API usage (static JSX)       |         41 |         13 |   75.93% |
| Styling (source and browser) |         13 |      5,181 |    0.25% |

The combined coverage is 1.37%. Browser attribution remains unknown where utility
rules cannot be reliably attributed to authored versus inherited styling. Static
JSX does not prove browser rendering. No unknown observation received credit.

## Remaining design judgment

The judge suggests urgency ordering and an earlier shortfall summary. It also
prefers a wider desktop composition, while previous reports praised the readable
maximum width. Treat that preference as a tradeoff, not an automatic defect or a
requirement for every generated app. The rubric remains advisory.

The shared callback type was subsequently separated from the serializable spec
in Arrusted commit d2d365dc; this preserves identical runtime behavior and resolves
the API boundary review in PR #1317.
