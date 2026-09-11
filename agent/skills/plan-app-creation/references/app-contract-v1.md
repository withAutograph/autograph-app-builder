# AppContractV1 reference

The only authored input is the app id:

```json
{
  "version": 1,
  "appId": "expense-review"
}
```

The planner accepts that minimal input or a previously canonicalized contract.
Its canonical output adds only the immutable binding to the exact accepted
AppSpec bytes:

```json
{
  "version": 1,
  "appId": "expense-review",
  "appSpec": {
    "path": "prototype/expense-review/app-spec.md",
    "sha256": "<64-lowercase-hex-digest>"
  }
}
```

Every object is closed. Unknown keys are invalid. A supplied binding must use
the conventional path and match the current file digest exactly.

## Required intent

- `appId`: one lowercase kebab-case segment. The future workspace is `apps/<id>`.
- `appSpec`: planner-derived product/authorization binding. Do not author it
  for first preparation.

The conventional AppSpec must be `prototype/<id>/app-spec.md` and satisfy the
strict [AppSpec Build handoff contract](../../design-app/references/app-spec.md#build-handoff).
A missing, incomplete, unaccepted, or changed AppSpec blocks preparation.

## Derived plan

The planner derives the Next.js runtime, `apps/<id>` workspace,
`@autograph/<id>` package, `apps-<id>` project, conventional `/<id>` routes,
optional additional routes from the AppSpec, and
`apps/<id>/schema/<id>-schema.json` when kernel data is declared.
Implementation derives workspace dependencies later from actual imports and
the workspace graph.

The planned microfrontend registration intentionally contains no
`development.local`. Pitchfork and Worktrunk own resolved runtime ports, and
the existing launcher supplies its direct-use fallback.

## Forbidden content

Do not include ownership, runtime, package, project, routes, ports, schema paths,
authorization copies, dependencies, capabilities, provider ids, credentials,
secrets, tokens, API keys, plan or region settings, environment values,
deployment ids, Vercel or Neon configuration in the authored contract. Product
decisions belong in the accepted AppSpec; provider configuration remains a
separate authority.

The planner reads current repository state and
`microfrontends.json`. It returns a proposal with `mutations: []`;
it never creates the future directory or writes
`apps/<id>/app.contract.json`.
