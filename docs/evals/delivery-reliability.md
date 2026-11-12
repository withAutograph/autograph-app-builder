# Builder delivery reliability

Use these cases when changing Builder or its generation contract. They qualify
the Builder changes; they are not a check or approval for each generated app.
Use synthetic records and the ordinary Creator account in the authorized test
workspace.

- **Frontend and Preview:** Build [Color Contrast Card](../../evals/delivery-reliability/frontend.md) with one Build approval. Exercise the form in the working Preview (black on white reads 21:1). Send the [release request](../../evals/delivery-reliability/frontend-release.md) in the same session, give ordinary publication consent, and exercise the Production route. Confirm setup did not allocate an app database.
- **Private persistence:** Build [Tool Checkout Notes](../../evals/delivery-reliability/persistence.md) with one Build approval. Builder sets up creator access and storage without infrastructure inputs. As the creator, open the Production URL, save and edit a synthetic record, and reopen it in a fresh app visit. An unsigned visitor must sign in; an authenticated actor without a grant must not see the record.
- **Data-preserving revision:** Request the [heading update](../../evals/delivery-reliability/revision.md) for that exact app. Check the changed heading and saved record at the same Production URL. Record the unchanged storage resource identity from read-only evidence when available.
- **Interrupted publication:** Use the frontend case with an isolated test provider. After the provider accepts the exact approved GitHub write, interrupt recording its result in the current workflow. Resume the original session through the public flow. Observe the same pull request and reviewed revision, a single provider write, and no authority for a moved head or unrelated app. Exercise both confirmed and uncertain outcomes. An uncertain result must be reconciled or left unresolved without another write. Do not intentionally fault Production.

For each new app case, replace `[RUN LABEL]` with a unique label in a temporary
copy of the brief and use that same label for its revision. Use the web app
or the [existing public MCP driver](self-reproduction.md#supported-public-driver)
with `--brief-file` and its own external evidence directory. The revision may
also be requested as a normal public message in the saved app session when
the product supports it. Save the original session and resume it on stalls.
The driver may poll, answer product questions consistently with the brief, and
submit the exact ordinary product approvals. It must not edit generated files,
prepare the runtime privately, nudge internal stages, or mutate GitHub or the
deployment provider. Record a run needing any such assistance as a failure of
unassisted delivery.

Record the deployed Builder revision, session handle, first Build approval,
first working Preview, review acceptance, draft and merge, and first verified
live revision as separate facts. For each, retain timestamps and links or a
sanitized transcript reference. Count Build approvals and interventions and
report wall time from Build to Preview and Build to live when applicable.
Record source checks, provider state, route behavior, and authenticated
readback separately. A working Preview can be credited only after exercising
the app; a live revision can be credited only after checking its Production
URL and the intended change. Mark missing or unavailable evidence explicitly
as failed, blocked, or unassessed. Keep credentials, private Preview
capabilities, and synthetic records out of shareable logs.
