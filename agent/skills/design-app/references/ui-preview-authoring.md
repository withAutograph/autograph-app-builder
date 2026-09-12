# Preview authoring

Use this contract before the first `record_ui_preview` call. Discover the current
catalog with `inspect_repository({ paths: [...] })`: read `tsconfig.json` for
`@autograph/components`, `@autograph/compositions`, and `@autograph/icons` aliases,
or their package export entrypoints. Follow the selected barrel's re-exports
into implementations, then read relevant stories for actual props and usage.
Read only the components needed for the workflow; a directory or a barrel with
`export *` alone does not establish a symbol's API.

The preview manifest is a usage inventory, not the package export list. An
import must both exist in the prepared repository and fit the preview contract:

- `productionComponents`: exact capitalized names from `@autograph/components`.
- `productionCompositions`: exact capitalized names from `@autograph/compositions`.
- `productionIcons`: exact capitalized names from `@autograph/icons`.

Use named component imports with their original spelling. Do not import helpers
such as `buttonClassName`, `cn`, or `buttonVariants`; the preview schema cannot
inventory lowercase names, even if a production consumer uses the helper.
Adding a made-up name to the manifest cannot make it a package export. Select
an existing public component or simplify the design when an API is unavailable.

Raw `button`, `input`, `select`, `textarea`, `dialog`, and `table` JSX is rejected
in every submitted file. A route function, local wrapper, or styled HTML control
does not bypass that rule. Use public components and pass local fixture state
and handlers through their observed APIs. Layout and text HTML can arrange them.
Do not submit `src/components/` implementations or catalog-gap components.

## Minimal source and matching manifest

After confirming that the current `Button` supports `onClick` and `children`,
this route demonstrates fixture-only interaction. Adapt the workflow and props
to the inspected source; it is not a fixed component catalog.

`src/routes/index.tsx`:

```tsx
import { useState } from "react";
import { Button } from "@autograph/components";

export default function Page() {
  const [reviewed, setReviewed] = useState(false);
  return (
    <main>
      <h1>Request review</h1>
      <p>{reviewed ? "Reviewed" : "One request needs review"}</p>
      <Button onClick={() => setReviewed(true)}>Mark reviewed</Button>
    </main>
  );
}
```

Pass `appId: "request-review"`, `routes: ["/"]`, this source in `files`, and
`catalogGaps: []`, with the following `manifest`:

```json
{
  "version": 1,
  "screens": [
    {
      "id": "review",
      "title": "Request review",
      "route": "/",
      "entry": "src/routes/index.tsx"
    }
  ],
  "productionComponents": [{ "name": "Button", "source": "@autograph/components" }],
  "productionCompositions": [],
  "productionIcons": [],
  "fixtureFacts": [
    {
      "id": "one-request",
      "statement": "One request needs review",
      "routes": ["/"]
    }
  ],
  "decisions": [],
  "assumptions": [
    {
      "id": "review-action",
      "statement": "Reviewers can mark a request reviewed",
      "routes": ["/"]
    }
  ],
  "openQuestions": [],
  "implementationNotes": [
    {
      "visibleElement": "Mark reviewed button",
      "productionMeaning": "A future authorized review action; this preview changes local fixture state only",
      "routes": ["/"]
    }
  ]
}
```

The renderer supplies the target theme. Read semantic tokens for layout choices;
do not invent a stylesheet export or copy a palette. Before submitting, compare
every named public import with its matching manifest collection, check every
screen entry and route, and remove raw controls and unsupported helpers.
