# Builder lifecycle qualification

Use the [authoring contract](full-app-authoring.md) to assess one released
Builder version. Reuse the [public driver](evals/self-reproduction.md) and
existing scenario inventory. Run independent journeys in parallel and run the
revision after delivery of the same app. Keep acceptance evidence outside the
source tree.

| Journey                | Evidence                                                                                                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fresh private build    | Enter through a supported client, observe one Build decision, then open the working preview and exercise a real control. Use a calculator and a second brief with different behavior, such as a local checklist.                                                                           |
| Authenticated delivery | Use a disposable Expense Tracker, confirm the selected public URL serves the app, sign in, save a synthetic expense, reload, and check that another identity cannot access it. Observe the repository, Vercel project, and active deployment.                                              |
| Revision               | Change an existing page through Builder. Verify the change at the original URL and verify the repository, project, and saved expense are preserved.                                                                                                                                        |
| Recovery and handoff   | Interrupt reversible work and resume through ordinary controls. Verify preserved work. Exercise lost provider acknowledgement with existing controlled fault fixtures and verify no duplicate effects. Exercise missing authentication and disabled plugin recovery for supported clients. |

Tip Splitter and Expense Tracker are historical baselines. Both reported
private implementation starting, with no Build request in the observed public
event histories. Keep those observations as baseline evidence. Unit Converter
showed a working Production private preview after recovery.

The workflow audit identified these control points:

| Control                    | Owner and continuation                                                                                                                                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build decision             | Private apply binds the initial proposal and workspace to the Build card. Default compute follows the same decision as selected compute. In-scope repairs reuse the grant.                                                                                       |
| Apply, preview, and review | The approved build controller continues eligible work from retained outcomes. An applied app can start its preview while validation and review proceed separately. Unchanged failures stop automatic continuation and keep the diagnostics available for repair. |
| Publication and deployment | The release handler owns the frozen destination and approved effects. After those effects settle, Builder can observe the same native deployment without asking for another approval. An uncertain effect remains in reconciliation.                             |

For each attempt retain the running Builder version, session lineage, elapsed
time, user interventions, and observed outcome. Record the first failure and
each retry as passed, failed, blocked, or unassessed. An evaluator source edit,
manual deployment, or private state repair fails the public journey. A
reviewed change or ready deployment supplies evidence for its own step. The
working app and the observed action supply the user outcome.

The qualification runs outside the authoring workflow. Use isolated synthetic
data and the ordinary approvals for external effects. Preserve uncertain
operations and reconcile them through supported reads.

Release the protected operator with the observation route before pointing the
released Builder at it. Verify the operator's source and immutable endpoint and
confirm both Production Builder domains serve the candidate. The observer reads
the active Production deployment. While an older deployment remains active,
a pending result does not establish whether a new build is running or failed.
Use provider diagnostics to distinguish those outcomes during qualification.
