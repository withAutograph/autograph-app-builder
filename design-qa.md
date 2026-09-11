# Approval Request MCP App UI — Design QA

## Comparison target

- Source visual truth: `/Volumes/Home/jasonmorganson/.config/codex/generated_images/01a0886a-9388-75e3-8293-a801289cfc80/exec-822378bb-c589-4418-b475-d8a22829d5ee.png`
- Source pixels: 1715 × 917
- Intended state: a single final build approval embedded in a regular desktop chat flow, light theme.
- Implementation capture: unavailable as an image file.
- Intended implementation route: Storybook `Create App/MCP Blocks/Approval Request / Unanswered`.
- Intended viewport and density: desktop, light theme; no implementation CSS viewport or device scale could be recorded because Storybook could not start.

## Evidence

The source image was available and inspected. The selected in-app browser does show the live `Make Changes Action` Storybook story with the expected rendered content and controls. However, an implementation screenshot could not be captured as an image file for a same-input comparison. The repository-required `mise run storybook:dev` entrypoint also fails before starting a replacement server because mise cannot create its trusted-config symlink under `~/.local/state/mise/trusted-configs` (`Operation not permitted`). No comparison composite or browser-console review is available.

## Required fidelity surfaces

- Fonts and typography: source calls for a strong, compact approval heading, subdued supporting copy, and clear button labels. Code targets that hierarchy, but visible font metrics and wrapping are unverified.
- Spacing and layout rhythm: source calls for a sparse chat-native surface, a divider above actions, a left-aligned secondary escape hatch, and a separated right-aligned primary action. Code targets this layout, but actual desktop and mobile rendering are unverified.
- Colors and visual tokens: code uses a dark slate primary action and a quiet outlined secondary action. Actual contrast in light and dark themes is unverified.
- Image quality and asset fidelity: the source includes a product mark that has no established component asset in the MCP UI. The implementation intentionally uses the available Autograph wordmark treatment rather than fabricating an icon or illustration. Visual fidelity is unverified.
- Copy and content: the implementation matches the approved copy: `Ready to build your app?`, `This will turn your plan into a working private preview.`, `Make changes`, `Keep chatting to refine your app.`, and `Build app`.

## Findings

- [P1] Rendered fidelity is not yet evidenced. Location: Storybook approval-request story. Evidence: source image is available; the live selected-browser story exposes the expected copy and controls, but no implementation image could be captured for the required side-by-side visual comparison. Impact: typography, responsive action placement, visible affordance, focus states, and dark-theme contrast cannot be verified against the source. Fix: restore mise trusted-config write access, run `mise run storybook:dev`, capture the Unanswered story at a matching desktop viewport and a narrow viewport, then compare both captures with the source in a single composite.

## Open questions

- The source includes an Autograph symbol beside its label, but no canonical asset was identified in the existing MCP component. Confirm whether the existing product mark should be surfaced here once rendered.

## Implementation checklist

1. Restore the mise trusted-config permission required for the supported Storybook entrypoint.
2. Capture and compare the unanswered desktop approval story with the source image.
3. Capture narrow and keyboard-focus states; correct any P1/P2 visual drift.
4. Update this report with paths, comparison history, and a final result.

## Comparison history

1. Initial pass — blocked before an implementation screenshot could be captured. No visual fixes have been accepted from a rendered comparison.

## Final result

blocked
