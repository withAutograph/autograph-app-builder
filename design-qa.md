# Design QA

## Visual truth

- Authenticated builder source: `/Volumes/Home/.TemporaryItems/folders.501/TemporaryItems/NSIRD_screencaptureui_YkrnsV/Screenshot 2026-08-28 at 14.54.33.png`
- Anonymous builder source: `/Volumes/Home/.TemporaryItems/folders.501/TemporaryItems/NSIRD_screencaptureui_fjnB7z/Screenshot 2026-08-28 at 14.53.20.png`
- Completion source: `/Volumes/Home/jasonmorganson/Desktop/Screenshot 2026-08-28 at 15.39.04.png`
- Deployment source: `/Volumes/Home/.TemporaryItems/folders.501/TemporaryItems/NSIRD_screencaptureui_WAvL6m/Screenshot 2026-08-28 at 15.37.01.png`
- Account menu source: `/Volumes/Home/.TemporaryItems/folders.501/TemporaryItems/NSIRD_screencaptureui_2QyqDX/Screenshot 2026-08-28 at 15.39.17.png`
- Final authenticated implementation: `.artifacts/design-qa/implementation-authenticated-light-final.png`
- Final completion implementation: `.artifacts/design-qa/implementation-ready-final.png`
- Anonymous implementation: `.artifacts/design-qa/implementation-anonymous.png`
- Account menu implementation: `.artifacts/design-qa/implementation-account-menu.png`
- Full-view builder comparison: `.artifacts/design-qa/source-vs-implementation-authenticated-final.jpg`
- Focused form comparison: `.artifacts/design-qa/source-vs-implementation-form-detail-v2.png`
- Completion comparison: `.artifacts/design-qa/source-vs-implementation-ready-final.jpg`
- Dynamic source captures: `.artifacts/vercel-dynamic/source-*.png`
- Dynamic implementation captures: `.artifacts/vercel-dynamic/implementation-*.png`
- Connection flow sources: the five `17.25`–`17.34` screenshots supplied on 2026-08-28.
- Connection drawer implementation: `.artifacts/connection-flow/implementation-connect.png`
- Connection success implementation: `.artifacts/connection-flow/implementation-success.png`

The authenticated builder comparison used the source viewport of 1699 x 1600 at DPR 1, with both experiences in the authenticated light-theme state. The completion comparison used the same light theme and the completed handoff state.

## Comparison history

### Pass 1

- P2: The application font was being overridden by the global Arial declaration, creating visible differences in heading weight, label density, and control text.
- P2: Section margins and the default brief density compressed the form relative to the source.
- P2: The primary action was disabled at the default placeholder state even though the source presents an enabled action.

Fixes applied: loaded and enforced Geist throughout the application, aligned section spacing and brief line density to the source, and supplied truthful placeholder defaults when the primary action is submitted.

### Pass 2

No actionable P0, P1, or P2 visual differences remain. The authenticated card width, page framing, typography hierarchy, borders, control heights, two-column grids, connection layout, primary action, handoff card, and completion card match the supplied references at the tested viewport.

Accepted P3 differences:

- Autograph identity and approved product nouns replace Vercel-specific identity where requested.
- The Slack mark is rendered in a single foreground color rather than the source's multicolor brand asset.
- The handoff reports real local preparation and connected-client actions rather than claiming a Vercel deployment.

### Dynamic interaction pass

The live authenticated Vercel experience was exercised in Chrome, Safari, and the in-app browser. DOM and accessibility inspection confirmed that Vercel uses custom Geist Design System primitives rather than stock shadcn/ui for the builder controls.

Implemented and compared against the captured live states:

- Searchable Vercel Team picker with plan badges and Create a Team footer.
- Searchable Git Scope picker with the complete captured scope list and Add GitHub Scope footer.
- Searchable, keyboard-operable model picker with provider identifiers and a constrained scrolling menu.
- Vercel-sized 40 x 24 repository privacy switch with lock/unlock states, private/public label changes, amber public state, and matching tooltips.
- Expandable 52-item connection catalog, branded icons where available, source-matched filtering, Escape-to-clear, and selected/remove states.

Chrome and the in-app browser verified menu expansion, filtering, selection, public/private state transitions, and the full connection catalog. Safari verified the same semantic structure, current values, labels, checkboxes, comboboxes, and primary action through its native accessibility tree.

### Connection flow pass

The supplied connection drawer, authorization success, configuration, and connected-card references were compared directly with the implementation at matching states.

- Selecting any catalog provider opens a responsive right-side Add Connection drawer over the builder.
- Every provider uses the explicit Connect action requested for Autograph rather than Vercel's connect-on-first-use exception.
- Connect opens a dedicated Connection successful state with the matching check and Return action.
- Return restores the drawer at Configure; Continue reveals Customize; Add Connection returns to the builder with a detailed connected card.
- Connected cards support Customize and Remove, and added providers are removed from the available catalog.
- The prototype states plainly that the local flow does not persist credentials or claim real provider authorization.

No actionable P0, P1, or P2 differences remain in the tested connection flow. The provider-specific configuration vocabulary is intentionally normalized for a frontend prototype; future live integrations can replace those fields with provider-owned schemas.

## Interaction and state QA

- Anonymous prompt, suggestion chips, disabled and enabled Continue states, and sign-in handoff verified.
- Authenticated App Name, searchable Team/Git Scope/model pickers, repository privacy, App Brief, channels, and connection filtering/selection verified.
- Account menu, system/light/dark theme controls, status link, and logout form verified.
- Preparing, validating, copying, connected-client, and completion states verified.
- Completion copy controls, dismissible install card, next steps, and Create Another App verified.
- Connection drawer close, Connect, success, Return, Configure, Customize, Add Connection, reopen, and Remove states verified.
- Keyboard focus styles, skip links, native select semantics, reduced-motion behavior, and unsaved-change warning reviewed.
- Browser console error log was empty in the verified states.

Final result: passed.
