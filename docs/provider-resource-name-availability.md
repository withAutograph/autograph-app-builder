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

## Public app deployment policy

New normal web Builder provisioning records `deploymentAccess: "public-app"`
in its durable request, digest, response and handoff. Creation requests Standard
Protection (`prod_deployment_urls_and_all_previews`) and enabled team-issued
OIDC, then independently reads both settings back before reporting success.
The production app domain is publicly reachable; the app's Better Auth and
application authorization still control access to its data and actions. Preview
and immutable deployment URLs remain protected. This setting does not deploy
or activate the app or establish authenticated behavior.

The standard project remains `apps-<app-id>`, uses the Services framework at the
repository root, and retains its selected GitHub link. A policy mismatch is a
failed postcondition; provisioning does not patch the project, create another
project, or disable protection to repair it. Existing frozen requests without
the optional access field preserve their digest and inherited provider policy;
handoff continuations retain that absence. Dedicated native Preview plans keep
their separately approved All Deployments policy unchanged.
