# Future: Provider Resource Name Availability

The current provisioning flow tries the requested GitHub repository name and
derived Vercel project name first. On a provider conflict it records and tries
up to five bounded names with a six-character lowercase alphanumeric suffix.
The Ready screen shows the actual names returned by provider read-back.

A future form improvement should check availability after the user selects an
installation and display conflicts inline beside Repository and Deployment.
That check must be advisory: availability can change before Create App, tenant
and provider scope must remain exact, and provisioning must retain its durable
conflict handling. The form should never adopt, overwrite, or imply ownership
of an existing resource based only on an availability response.

This change intentionally does not add form-time provider requests or inline
conflict UI.
