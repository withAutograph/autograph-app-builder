# Review actions: behavior and score limits

The narrow desktop view now composes existing Arrusted Cards with explicit Review buttons. Product, SKU, location, severity, and cover are preserved. No custom colors or components were introduced. The wide desktop selection cards remain unchanged.

## Verified behavior

- All 20 fixture interaction checks pass across the four captured desktop sizes.
- At 700px, Tab/Enter activates Review and moves focus into the detail panel. Tab/Enter on Back returns focus to the originating Review button.
- Initial screenshots at 1024, 1440, and 1920px are byte-for-byte identical to the preceding SKU-metadata report. The 700px layout is intentionally different.
- An initial full-width Button experiment centered its inner content. It was corrected to ordinary Card/Button composition before this evaluation; no internal Button styling override was retained.

## Advisory result, not an optimization target

The unchanged judge/rubric returned **85/100**, versus **90/100** for SKU metadata. It rated responsive composition higher (4 rather than 3), but hierarchy and typography lower despite the unchanged wide screenshots. This does not establish a uniform quality regression or improvement. The changed narrow composition and model variability are both possible influences; this run cannot separate them.

The source has 38/42 assessed component observations, 64/71 assessed API observations, and 23/5750 assessed styling observations. Assessed adherence is 100%, but styling provenance remains overwhelmingly unknown and the overall verdict stays partial.

The report and screenshots are preserved without rerolling the judge. Repeatedly editing to reach exactly 100 would risk optimizing for unstable model preferences. Further visual choices should use a human-reviewed reference or explicit product feedback, not a score threshold. No generation gates or automated repair loop were added.
