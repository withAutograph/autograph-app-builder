# Reading-position comparison

The minimal-scroll and native-scroll variants both scored **90/100**. The native variant deletes the custom disclosure scroll callback. It preserves reading position, but the short desktop panel still requires scrolling to read all expanded facts. This is a layout-space tradeoff, not a reason to oscillate between automatic scroll algorithms until a judge happens to prefer one.

The next revision lets the detail card grow with the page at the constrained desktop width while retaining the wide-desktop panel. Keep the approved narrow Back navigation. Do not alter the palette, information, or scoring rubric.

General composition lesson: use independent scrolling where it supports a long-lived workspace; do not impose a short scroll viewport on modest reading content solely to keep a footer fixed. Preserve the reader's position when revealing secondary information. Choose this by content and task, not app name.

The 700px Back capture visually exposes the filters and all four records. Its initial immediate visibility check raced the transition; this is not evidence of a missing filter. Full keyboard/accessibility certification remains outside this bounded comparison.
