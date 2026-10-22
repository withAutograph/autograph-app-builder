# Preview authoring

Use this contract before the first `record_ui_preview` call. Discover the current
catalog with `inspect-repository({ paths: [...] })`: read the repository's actual
public import mappings before requesting a barrel. Start with `tsconfig.json`,
workspace path maps referenced by it or the repository overview (for example,
`.config/typescript/workspace-paths.json`), and package `exports` where present.
Resolve `@autograph/components`, `@autograph/compositions`, and
`@autograph/icons` from those mappings; do not assume a historical
`packages/components`, `packages/compositions`, or `packages/icons` layout.
Follow each selected barrel's re-exports into implementations, then read
relevant stories for actual props and usage.
Read only the components needed for the workflow; a directory or a barrel with
`export *` alone does not establish a symbol's API.

The preview manifest is an advisory usage inventory, not the package export
list or an admission checklist. The renderer compiles the actual public exports
from the prepared repository:

- `productionComponents`: components or helpers from `@autograph/components`.
- `productionCompositions`: compositions or helpers from `@autograph/compositions`.
- `productionIcons`: icons or helpers from `@autograph/icons`.

Use actual exported names and observed APIs. Public helpers may have lowercase
names; inventory names need not start with a capital letter. Adding a name to
the manifest does not make it a package export, and an omitted inventory entry
does not prevent compilation. Resolve concrete missing-export errors against
the current public source rather than a fixed preview symbol or icon list.

Prefer reusable public Arrusted controls and compositions, with local fixture
state and handlers through their observed APIs. Local workflow components,
HTML controls, and CSS are not source-admission failures. Catalog gaps may be
recorded as advisory design notes without claiming they are implemented or
forcing a component, primitive, or token inventory. Keep the Arrusted palette
verbatim through semantic tokens and supported variants; style guidance does
not create a replacement source validator. Readable formatting helps diagnose
real compiler errors but does not gate a preview.

Preview authority is still limited to contained source and local fixtures:
no backend/server behavior, network services, or private package exports.
Directory names such as `schema` or `api` do not create server authority in a
browser bundle. Relative imports, including parent imports, may resolve within
the submitted `src` tree; rooted, file-URL, ambiguous backslash, and escaping
source imports are rejected. Missing files remain concrete compiler errors.
Actual screen routes and source entry files must agree. Advisory decisions,
assumptions, and gap metadata do not create routes or execution authority.

If `record_ui_preview` reports an import, syntax, or compilation error, repair
the reported source and call `record_ui_preview` again. Call `accept-ui-preview`
only after `record_ui_preview` has returned a current valid preview revision.

Hosted durable receipts use `contentDelivery: hosted-browser-stream`. Open the
authenticated preview URL from the public session result directly; the server
authorizes the read and verifies the immutable manifest and chunks before
streaming HTML. `browserReady` means ready to open, while browser rendering and
control verification still need observation. `routineReadNotRequired` means
compiled HTML does not need a `get_prototype_artifact` drain for viewing or
planning. Use the readable authored React source to plan revisions. The retained
`requiresChunkedRead` flag describes deliberate raw export for this hosted path;
Markdown documents and targeted raw diagnostics remain readable through the
artifact tool. Local inline output and oversized local/legacy chunk readback
retain their existing delivery behavior.

## Minimal source and advisory manifest

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
an empty advisory `catalogGaps` list for this example, with this `manifest`:

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
do not invent a stylesheet export or copy a palette. Check actual public APIs,
screen entries, and routes; use the renderer's concrete compiler diagnostics
when source fails. Inventories remain useful review notes, not authority to
accept an unavailable export or reject an otherwise valid source bundle.
