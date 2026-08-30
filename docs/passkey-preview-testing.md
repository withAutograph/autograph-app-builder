# Passkey testing

Autograph supports passkey-first registration and returning passkey sign-in on
loopback development origins and explicitly enabled Vercel Preview deployments.
It does not add a test-user bypass, password, impersonation endpoint, or public
registration token. Production passkey onboarding is rejected by the runtime.

## Local development

Use PostgreSQL with migration `0013_passkey_onboarding` applied. Put the local
bindings in the owner-only `.env.local` file loaded by Next.js:

```dotenv
BETTER_AUTH_URL=http://localhost:3000/api/auth
BETTER_AUTH_SECRET=<at-least-32-random-characters>
DATABASE_URL=postgresql://...
PASSKEY_ONBOARDING=local-preview-v1
```

Run `mise run app:dev`, open `http://localhost:3000/auth/sign-in`, and choose
**Continue with Passkey**. If the browser cannot authenticate, the page remains
on sign-in and changes the action to **Passkey failed (try again)**. Retrying
starts the registration recovery ceremony without adding a second passkey
button. After registration, sign out and use **Continue with Passkey** to exercise the
returning-user flow. Browsers treat `localhost` as a
WebAuthn secure context; use `localhost` consistently rather than switching
between it and `127.0.0.1` because credentials are RP-ID scoped.

To reset a local identity, remove its organization/member, session, passkey, and
user records together in a transaction. Do not reuse that procedure against
Preview or Production data.

## Vercel Preview

Enable Vercel Authentication under Deployment Protection before setting:

```dotenv
PASSKEY_ONBOARDING=local-preview-v1
PASSKEY_PREVIEW_PROTECTION=vercel-authentication
```

The runtime also requires Vercel's exact `VERCEL_ENV=preview`, `VERCEL_URL`, and
`VERCEL_DEPLOYMENT_ID` metadata. It derives the auth origin from `VERCEL_URL`
when `BETTER_AUTH_URL` is not set, or requires an explicitly configured URL to
agree exactly. Every generated Preview hostname is a different WebAuthn RP and
therefore has independent passkeys and workspace data. Removing Deployment
Protection requires removing the passkey flags first.

## Recovery

Passkey-first accounts have no verified email recovery. Add a second passkey in
Account settings before treating the account as durable. The server refuses to
delete the final passkey. OAuth linking and stable Preview aliases are deferred.
