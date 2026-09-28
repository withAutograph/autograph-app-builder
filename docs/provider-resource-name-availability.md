# Future: Provider Resource Name Availability

The current provisioning flow tries the requested GitHub repository name and
derived Vercel project name first. On a confirmed provider name conflict it
records a new candidate with a six-character lowercase alphanumeric suffix.
The Ready screen shows the actual names returned by provider read-back.

An expired provisioning lease is not proof that a provider write failed.
Before retrying, Builder reads every candidate that was confirmed absent before
a possible write. A GitHub repository with the exact request marker and starter
readback settles as success. An incomplete or foreign repository pauses for
review. Vercel projects have no equivalent request marker, so an existing
project pauses for review. A 404 after an uncertain write also pauses: delayed
provider visibility could otherwise cause duplicate creation. Builder does not
issue another create request until the previous outcome is known.

A future form improvement should check availability after the user selects an
installation and display conflicts inline beside Repository and Deployment.
That check must be advisory: availability can change before Create App, tenant
and provider scope must remain exact, and provisioning must retain its durable
conflict handling. The form should never adopt, overwrite, or imply ownership
of an existing resource based only on an availability response.

This change intentionally does not add form-time provider requests or inline
conflict UI.
