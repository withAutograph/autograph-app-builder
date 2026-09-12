# Autograph App Builder

Build a production-quality, desktop-first application named **Autograph App
Builder**. It helps a person describe an app, refine its plan, connect the
destination services they choose, and create a working private preview.

This must be an independent application. Do not call, embed, proxy, or depend
on the existing Autograph App Builder service to plan or create an app. It must
own its authentication, durable data, orchestration, previews, retries, and
recovery. Ordinary open-source dependencies and local development services are
allowed.

The initial anonymous screen is a calm, focused "New App" page. It has a small
Autograph mark, Docs, Sign in, Sign up, one clear prompt asking what to build,
a multiline brief, useful example prompts, and a disabled-until-valid Continue
button. Carry an anonymous brief safely into sign-in and into the authenticated
workspace.

Authenticated users work in an app-creation canvas with a compact header,
back navigation, account controls, a clear product brief, generated name and
destination controls, and sections for the app details, build approach, and
optional GitHub and Vercel connections. Save the active draft durably and
restore it after reload, authentication, and provider returns. Make save,
loading, empty, error, conflict, cancellation, retry, and recovery states
visible and useful.

The creation flow should show the proposed work, ask for deliberate approval
before creating an app, then show real progress, a preview link, and a concise
result. A user can cancel a pending creation, retry a recoverable failure, and
resume an interrupted session. The independent backend must be capable of
creating one small generated app from a stored brief; do not recurse past that
child app.

Provider connection is optional. Offer GitHub and Vercel connection entries
with success and failure return states, preserve the draft through the return,
and explain unavailable provider operations. Include account settings and a
small public documentation area that explains the journey for a new user.
Protect tenant data. Keep request-specific identity and data separate from any
shared cache, and never expose credentials in client code or progress records.

Use Next.js 16.3 App Router practices: server-render the initial page wherever
possible, keep browser islands narrow, use Server Actions or route handlers for
writes, give dynamic routes useful loading UI and Suspense boundaries, and use
Cache Components plus partial prefetching where safe. Preserve instant shell
continuity for ordinary in-app navigation. Use optimistic UI only for mutations
with clear rollback. Provide focused tests for draft persistence, provider
return, creation progress, cancellation, retry, recovery, and one generated
child app.

Use the installed public Arrusted component and token APIs when available. Do
not build a static mock or leave controls inert: the visible workflows must
perform their stated local effects.
