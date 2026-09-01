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
- Repository control source: `/Volumes/Home/.TemporaryItems/folders.501/TemporaryItems/NSIRD_screencaptureui_8G06ad/Screenshot 2026-08-28 at 17.04.27.png`
- Model and information-badge source: `/Volumes/Home/.TemporaryItems/folders.501/TemporaryItems/NSIRD_screencaptureui_ahXV27/Screenshot 2026-08-28 at 17.04.59.png`
- Final polished repository state: `.artifacts/polish/local-after-lock.png`
- Final polished information-tooltip state: `.artifacts/polish/local-after-tooltip.png`
- Final polished resting state: `.artifacts/polish/local-final.png`
- Final polished mobile state: `.artifacts/polish/local-after-mobile.png`

The authenticated builder comparison used the source viewport of 1699 x 1600 at DPR 1, with both experiences in the authenticated light-theme state. The completion comparison used the same light theme and the completed handoff state.

## Comparison history

### Future consideration: anonymous desktop orientation

The anonymous start is healthy and requires no current design or behavior
change. At wider desktop viewports, the deliberately compact entry card leaves
substantial open space below it. A future design pass could explore a small
amount of supporting context about what Autograph creates or what follows after
Continue, provided it preserves the current focused, low-friction hierarchy.
This is an optional improvement, not a committed requirement or an actionable
finding from this review.

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

- Selecting any catalog provider adds a pending connection card and removes that provider from the available catalog.
- Every pending card has the requested explicit Connect action and an independent remove action; only Connect opens the responsive right-side Add Connection drawer.
- Connect opens a dedicated Connection successful state with the matching check and Return action.
- Return restores the drawer at Configure; Continue reveals Customize; Add Connection returns to the builder with a detailed connected card.
- Connected cards replace Connect with Customize while retaining Remove; removing either a pending or connected card restores the provider to the catalog.
- The prototype states plainly that the local flow does not persist credentials or claim real provider authorization.

No actionable P0, P1, or P2 differences remain in the tested connection flow. The provider-specific configuration vocabulary is intentionally normalized for a frontend prototype; future live integrations can replace those fields with provider-owned schemas.

### Fine-detail polish pass

The focused source details were compared with the browser-rendered implementation in one combined inspection. The 336 x 90 repository source and 683 x 367 model source were checked against the 787 x 906 desktop implementation at CSS DPR 1, with focused crops used to judge the controls rather than browser framing. The responsive implementation was separately checked at 390 x 844 and DPR 1; document width remained exactly 390 CSS pixels with no horizontal overflow.

Initial P2 findings:

- The repository tooltip was clipped by the compound input's overflow boundary.
- Focus treatment used a generic blue outline rather than Vercel's neutral inset border and soft outer halo.
- The repository switch thumb measured 21 x 21 instead of the source-matched 22 x 22 inside the 40 x 24 track.
- Zero Data Retention used an outlined help glyph instead of the compact information badge.
- Menus, tooltips, and the connection backdrop lacked the source's short opacity/transform entrances.

Fixes and post-fix evidence:

- The lock tooltip now escapes the 38 px repository control and renders at 175 x 32 with the captured copy, black surface, six-pixel radius, and pointer.
- Repository geometry is 38 px control height, 40 x 24 track, 22 x 22 thumb, and 30 x 40 hit area; private/public positions and amber public state were browser-verified.
- Compound controls use the neutral Vercel focus border and three-pixel halo. The information trigger uses a 16 x 16 hit area with a 12 x 12 information badge and a keyboard-accessible tooltip.
- Hover, active, menu, tooltip, backdrop, drawer, and chevron transitions now animate only opacity, transform, background, border, color, and shadow. Reduced-motion disables or effectively removes these transitions.
- Post-fix captures show the source-matched lock tooltip without clipping, the polished information treatment, clean mobile stacking, and no browser console errors.

No actionable P0, P1, or P2 differences remain in the tested fine-detail states. Font family/weights, spacing rhythm, neutral color tokens, icon source quality, element sizes, and copy were explicitly checked. Autograph branding and the approved App terminology remain intentional product substitutions.

## Interaction and state QA

- Anonymous prompt, suggestion chips, disabled and enabled Continue states, and sign-in handoff verified.
- Authenticated App Name, searchable Team/Git Scope/model pickers, repository privacy, App Brief, channels, and connection filtering/selection verified.
- Account menu, system/light/dark theme controls, status link, and logout form verified.
- Preparing, validating, copying, connected-client, and completion states verified.
- Completion copy controls, dismissible install card, next steps, and Create Another App verified.
- Catalog add, pending Connect/Remove, connection drawer close, success, Return, Configure, Customize, Add Connection, reopen, and connected Remove states verified.
- Keyboard focus styles, skip links, native select semantics, reduced-motion behavior, and unsaved-change warning reviewed.
- Browser console error log was empty in the verified states.

Final result: passed.

### Picker and control fidelity pass

The Vercel Team, Git Scope, repository, model, and connection-search controls
were rechecked against the supplied open, selected, focused, private, and public
reference states at the rendered desktop size.

- Team rows now use round team marks, gray Hobby and blue Pro pills, a trailing
  selected check, aligned labels, and an undivided Create a Team footer with a
  circled plus.
- Git Scope uses the filled GitHub mark on the control and every option, a
  trailing selected check, aligned labels, and an undivided Add GitHub Scope
  footer with the larger source-sized plus.
- The repository separator, privacy track, filled lock glyphs, and right inset
  match the source geometry. The information badge is dark and legible on a
  subtle round background.
- Model options keep provider identifiers aligned without a selected-row check.
  Model and connection search icons use the smaller source-sized mark, while the
  connection search focus halo belongs to the complete compound control.
- Show all connections now uses Vercel's subtle gray hover surface.

The authenticated page was reloaded in the in-app browser and the open Team
menu was captured at the actual viewport. Labels, icons, badges, checkmark,
footer, slash, repository switch, information badge, and model row alignment
were visually verified. Unit tests and type checking passed before the final
production build.
