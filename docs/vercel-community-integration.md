# Autograph App Builder Vercel Community Integration

Provider registration is a separate activation step. The application code in
this repository does not create or modify a Vercel Integration.

Register a connectable-account Community Integration with the external
installation flow and these public properties:

- Name: `Autograph App Builder`
- Slug: `autograph-app-builder`
- Website: `https://www.autograph.so/`
- Terms/EULA: `https://www.autograph.so/terms/`
- Privacy: `https://www.autograph.so/privacy/`
- Support: `https://www.autograph.so/contact/`
- Documentation: this repository
- Redirect URI: `<APP_ORIGIN>/vercel/installations/callback`
- Webhook URI: `<APP_ORIGIN>/api/vercel/webhooks`

Request only the integration-configuration, user/team metadata, projects, and
deployments permissions needed to read the selected scope and later create and
deploy an explicitly approved project. Do not enable Sign in with Vercel or
Vercel Connect for this deployment-authority flow.

After registration, configure the environment names documented in
`.env.example`. `VERCEL_INTEGRATION_TOKEN_KEY` is a base64-encoded 32-byte key;
rotate it by adding support for the old version before changing
`VERCEL_INTEGRATION_TOKEN_KEY_VERSION`.
